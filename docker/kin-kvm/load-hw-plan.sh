#!/bin/bash
# Safe, zero-eval loaders for hardware.json resource plans and qemu-smbios.args.
# Values with spaces or $(...) remain literal data and are never passed to eval.

load_hw_plan() {
  local hardware_json=$1
  local plan_json
  plan_json=$(mktemp)
  python3 - "$hardware_json" "$plan_json" <<'PY'
import json
import re
import sys
from pathlib import Path

source = Path(sys.argv[1])
dest = Path(sys.argv[2])
raw = json.loads(source.read_text(encoding="utf-8")) if source.is_file() else {}
if not isinstance(raw, dict):
    raw = {}

# Support both flat hardware.json and slot-hardware-manifest.json resources section.
if "resources" in raw and isinstance(raw["resources"], dict) and "cpu_family" not in raw:
    res = raw["resources"]
    disk_obj = res.get("disk") if isinstance(res.get("disk"), dict) else {}
    hardware = {
        "cpu_family": res.get("cpu_family"),
        "cpu_model": res.get("cpu_model"),
        "cpu_stepping": res.get("cpu_stepping"),
        "logical_cpus": res.get("logical_cpus", res.get("vcpus")),
        "ram_mb": res.get("memory_mb"),
        "ram_gb": res.get("memory_gb"),
        "en0_mac": res.get("mac"),
        "disk_serial": disk_obj.get("serial"),
    }
else:
    hardware = raw

def num_text(value):
    if value is None or value == "" or isinstance(value, bool):
        return ""
    return str(value).strip()

not_applied = ["smc_version", "rom_hex"]
plan = {}

family = num_text(hardware.get("cpu_family"))
model = num_text(hardware.get("cpu_model"))
stepping = num_text(hardware.get("cpu_stepping"))
if family.isdigit() and model.isdigit() and stepping.isdigit():
    # Use max (not qemu64) so KVM/TCG guests expose SSE4.2/AVX/AVX2 needed by Bun/claude while spoofing CPUID.
    plan["cpu"] = f"max,family={int(family)},model={int(model)},stepping={int(stepping)}"
else:
    not_applied.append("cpu_id")

logical = num_text(hardware.get("logical_cpus"))
if logical.isdigit() and 1 <= int(logical) <= 256:
    plan["smp"] = str(int(logical))
else:
    not_applied.append("smp")

ram = num_text(hardware.get("ram_mb"))
if not ram.isdigit():
    ram_gb = num_text(hardware.get("ram_gb"))
    if ram_gb.isdigit() and int(ram_gb) > 0:
        ram = str(int(ram_gb) * 1024)
if ram.isdigit() and int(ram) > 0:
    plan["memory_mb"] = str(int(ram))
else:
    not_applied.append("memory")

mac = str(hardware.get("en0_mac") or "").strip().lower()
if re.fullmatch(r"[0-9a-f]{2}(?::[0-9a-f]{2}){5}", mac) and (int(mac[:2], 16) & 1) == 0:
    plan["mac"] = mac
else:
    not_applied.append("mac")

disk = str(hardware.get("disk_serial") or "").strip()
# Comma, quote, backslash, and newline split a QEMU -device option. Space and $() stay literal data.
if disk and not re.search(r'[,"\\\r\n\x00]', disk):
    plan["disk_serial"] = disk
else:
    not_applied.append("disk_serial")

plan["not_applied"] = not_applied
dest.write_text(json.dumps(plan), encoding="utf-8")
PY
  _hw_field() {
    python3 -c 'import json,sys; data=json.load(open(sys.argv[1], encoding="utf-8")); value=data.get(sys.argv[2], ""); sys.stdout.write(",".join(value) if isinstance(value, list) else "" if value is None else str(value))' "$plan_json" "$1"
  }
  local cpu memory vcpus mac serial skipped
  cpu=$(_hw_field cpu)
  memory=$(_hw_field memory_mb)
  vcpus=$(_hw_field smp)
  mac=$(_hw_field mac)
  serial=$(_hw_field disk_serial)
  skipped=$(_hw_field not_applied)
  [ -n "$cpu" ] && CPU_MODEL=$cpu
  [ -n "$memory" ] && KIN_KVM_MEMORY_MB=$memory
  [ -n "$vcpus" ] && KIN_KVM_VCPUS=$vcpus
  [ -n "$mac" ] && KIN_KVM_MAC=$mac
  [ -n "$serial" ] && KIN_KVM_DISK_SERIAL=$serial
  not_applied=$skipped
  rm -f "$plan_json"
}

load_smbios_args() {
  local args_file=$1
  FP_SMBIOS=()
  [ -f "$args_file" ] || return 1
  if ! python3 - "$args_file" <<'PY'
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
if "\x00" in text:
    sys.stderr.write("smbios args contains NUL byte\n")
    sys.exit(1)

UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
ALLOWED_KEYS = {
    "0": {"type", "vendor", "version", "date", "release", "uefi"},
    "1": {"type", "manufacturer", "product", "version", "serial", "uuid", "sku", "family"},
    "2": {"type", "manufacturer", "product", "version", "serial", "asset", "location"},
    "3": {"type", "manufacturer", "version", "serial", "asset", "sku"},
    "4": {"type", "sock_pfx", "manufacturer", "version", "serial", "asset", "part", "max-speed", "current-speed"},
    "17": {"type", "loc_pfx", "bank", "manufacturer", "serial", "asset", "part", "speed"},
}

def split_smbios(body: str):
    parts = []
    cur = []
    i = 0
    while i < len(body):
        if body[i] == "," and i + 1 < len(body) and body[i + 1] == ",":
            cur.append(",")
            i += 2
            continue
        if body[i] == ",":
            parts.append("".join(cur))
            cur = []
            i += 1
            continue
        cur.append(body[i])
        i += 1
    parts.append("".join(cur))
    return parts

lines = [line.strip() for line in text.splitlines() if line.strip()]
if not lines:
    sys.stderr.write("smbios args file is empty\n")
    sys.exit(1)

i = 0
seen_types = set()
while i < len(lines):
    flag = lines[i]
    if i + 1 >= len(lines):
        sys.stderr.write(f"smbios args dangling flag: {flag}\n")
        sys.exit(1)
    val = lines[i + 1]
    if flag == "-uuid":
        if not UUID_RE.fullmatch(val):
            sys.stderr.write(f"invalid -uuid value: {val}\n")
            sys.exit(1)
    elif flag == "-smbios":
        if any(ord(ch) < 32 or ord(ch) == 127 for ch in val):
            sys.stderr.write("control character in -smbios argument\n")
            sys.exit(1)
        parts = split_smbios(val)
        fields = {}
        for part in parts:
            if "=" not in part:
                sys.stderr.write(f"malformed -smbios field: {part}\n")
                sys.exit(1)
            k, v = part.split("=", 1)
            fields[k] = v
        t = fields.get("type", "")
        if t not in ALLOWED_KEYS:
            sys.stderr.write(f"disallowed SMBIOS type: {t}\n")
            sys.exit(1)
        extra = set(fields.keys()) - ALLOWED_KEYS[t]
        if extra:
            sys.stderr.write(f"disallowed SMBIOS type={t} keys: {sorted(extra)}\n")
            sys.exit(1)
        if t == "1" and "uuid" in fields and not UUID_RE.fullmatch(fields["uuid"]):
            sys.stderr.write(f"invalid type=1 uuid: {fields['uuid']}\n")
            sys.exit(1)
        seen_types.add(t)
    else:
        sys.stderr.write(f"disallowed flag in qemu-smbios.args: {flag}\n")
        sys.exit(1)
    i += 2

if "1" not in seen_types:
    sys.stderr.write("qemu-smbios.args missing required SMBIOS type=1\n")
    sys.exit(1)
PY
  then
    FP_SMBIOS=()
    return 1
  fi
  local item
  while IFS= read -r -d '' item; do
    FP_SMBIOS+=("$item")
  done < <(python3 - "$args_file" <<'PY'
import sys
from pathlib import Path
# Re-emit already-validated tokens as NUL-delimited stream without bash subshell NUL stripping.
lines = [line.strip() for line in Path(sys.argv[1]).read_text(encoding="utf-8").splitlines() if line.strip()]
out = []
i = 0
while i < len(lines):
    flag = lines[i]
    val = lines[i + 1]
    out.extend([flag, val.lower() if flag == "-uuid" else val])
    i += 2
sys.stdout.buffer.write(b"\0".join(s.encode("utf-8") for s in out) + b"\0")
PY
  )
  [ "${#FP_SMBIOS[@]}" -gt 0 ]
}
