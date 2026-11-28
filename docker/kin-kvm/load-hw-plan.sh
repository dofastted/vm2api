#!/bin/bash
# Safe, zero-eval loaders for hardware.json resource plans and qemu-smbios.args.
# Values with spaces or $(...) remain literal data and are never passed to eval.

load_hw_plan() {
  local hardware_json=$1
  local plan_json
  plan_json=$(mktemp)
  KIN_KVM_ACCEL="${KIN_KVM_ACCEL:-}" \
  KIN_KVM_HOST_CPU_VENDOR="${KIN_KVM_HOST_CPU_VENDOR:-}" \
  KIN_HOST_CPU_VENDOR="${KIN_HOST_CPU_VENDOR:-}" \
  python3 - "$hardware_json" "$plan_json" <<'PY'
import json
import os
import re
import sys
from pathlib import Path

source = Path(sys.argv[1])
dest = Path(sys.argv[2])
raw = json.loads(source.read_text(encoding="utf-8")) if source.is_file() else {}
if not isinstance(raw, dict):
    raw = {}

identity_path = source.parent / "identity.json"
identity = {}
if identity_path.is_file():
    try:
        parsed_id = json.loads(identity_path.read_text(encoding="utf-8"))
        if isinstance(parsed_id, dict):
            identity = parsed_id
    except Exception:
        identity = {}

# Support both flat hardware.json and slot-hardware-manifest.json resources section.
if "resources" in raw and isinstance(raw["resources"], dict) and "cpu_family" not in raw:
    res = raw["resources"]
    disk_obj = res.get("disk") if isinstance(res.get("disk"), dict) else {}
    acpi_obj = raw.get("acpi") if isinstance(raw.get("acpi"), dict) else {}
    hardware = {
        "cpu_vendor": res.get("cpu_vendor") or res.get("cpuid_vendor") or raw.get("cpu_vendor") or raw.get("cpuid_vendor"),
        "cpu_model_id": res.get("cpu_model_id") or res.get("cpu_brand") or raw.get("cpu_model_id") or raw.get("cpu_brand"),
        "cpu_family": res.get("cpu_family"),
        "cpu_model": res.get("cpu_model"),
        "cpu_stepping": res.get("cpu_stepping"),
        "logical_cpus": res.get("logical_cpus", res.get("vcpus")),
        "ram_mb": res.get("memory_mb"),
        "ram_gb": res.get("memory_gb"),
        "en0_mac": res.get("mac"),
        "disk_serial": disk_obj.get("serial"),
        "acpi_oem_id": res.get("acpi_oem_id") or acpi_obj.get("oem_id"),
        "acpi_oem_table_id": res.get("acpi_oem_table_id") or acpi_obj.get("oem_table_id"),
    }
else:
    hardware = dict(raw)
    if isinstance(raw.get("acpi"), dict):
        hardware.setdefault("acpi_oem_id", raw["acpi"].get("oem_id"))
        hardware.setdefault("acpi_oem_table_id", raw["acpi"].get("oem_table_id"))

id_acpi = identity.get("acpi") if isinstance(identity.get("acpi"), dict) else {}
if not hardware.get("cpu_vendor") and not hardware.get("cpuid_vendor"):
    hardware["cpu_vendor"] = identity.get("cpuid_vendor") or identity.get("cpu_vendor")
if not hardware.get("cpu_model_id") and not hardware.get("cpu_brand"):
    hardware["cpu_model_id"] = identity.get("cpu_model_id") or identity.get("cpu_brand")
if not hardware.get("acpi_oem_id"):
    hardware["acpi_oem_id"] = id_acpi.get("oem_id")
if not hardware.get("acpi_oem_table_id"):
    hardware["acpi_oem_table_id"] = id_acpi.get("oem_table_id")

def num_text(value):
    if value is None or value == "" or isinstance(value, bool):
        return ""
    return str(value).strip()

def norm_vendor(raw_vendor):
    v = str(raw_vendor or "").strip().lower()
    if v in ("amd", "authenticamd", "advanced micro devices, inc.") or "amd" in v or "ryzen" in v or "epyc" in v:
        return "AuthenticAMD"
    if v in ("intel", "genuineintel", "intel(r) corporation") or "intel" in v or "core(tm)" in v or "xeon" in v:
        return "GenuineIntel"
    return ""

def detect_host_vendor():
    override = os.environ.get("KIN_KVM_HOST_CPU_VENDOR", "") or os.environ.get("KIN_HOST_CPU_VENDOR", "")
    if override.strip().lower() == "any":
        return ""
    v = norm_vendor(override)
    if v:
        return v
    try:
        for line in Path("/proc/cpuinfo").read_text(encoding="utf-8", errors="ignore").splitlines():
            if line.startswith("vendor_id"):
                parts = line.split(":", 1)
                if len(parts) == 2:
                    return norm_vendor(parts[1])
    except OSError:
        pass
    return ""

def sanitize_model_id(raw_model):
    text = str(raw_model or "").strip()
    if not text:
        return ""
    # Strip control characters and clamp to x86 CPUID brand string limit (48 bytes).
    cleaned = "".join(ch for ch in text if 32 <= ord(ch) < 127).strip()
    if not cleaned:
        return ""
    cleaned = cleaned.encode("ascii", "ignore")[:48].decode("ascii").rstrip()
    # QEMU QemuOpts separates properties with ','; escape literal commas as ',,'.
    return cleaned.replace(",", ",,")

def sanitize_acpi_id(raw_val, max_len):
    text = str(raw_val or "")
    if not text or any(ord(ch) < 32 or ord(ch) >= 127 for ch in text):
        return ""
    if any(ch in text for ch in (",", "=", '"', "\\")):
        return ""
    cleaned = text[:max_len]
    return cleaned if cleaned.strip() else ""

not_applied = ["smc_version", "rom_hex"]
plan = {}

accel = str(os.environ.get("KIN_KVM_ACCEL", "") or "").strip().lower()
family = num_text(hardware.get("cpu_family"))
model = num_text(hardware.get("cpu_model"))
stepping = num_text(hardware.get("cpu_stepping"))
has_cpuid_tuple = family.isdigit() and model.isdigit() and stepping.isdigit()

raw_model_id = hardware.get("cpu_model_id") or hardware.get("cpu_brand") or ""
escaped_model_id = sanitize_model_id(raw_model_id)

profile_vendor = norm_vendor(hardware.get("cpu_vendor") or hardware.get("cpuid_vendor"))
if not profile_vendor and raw_model_id:
    profile_vendor = norm_vendor(raw_model_id)
if not profile_vendor and family.isdigit():
    fam_num = int(family)
    if fam_num in (23, 24, 25, 26):
        profile_vendor = "AuthenticAMD"
    elif fam_num == 6:
        profile_vendor = "GenuineIntel"

if accel == "tcg":
    # Under TCG software emulation there is no host KVM vendor mismatch constraint.
    cpu_parts = ["max", "-hypervisor"]
    if profile_vendor:
        cpu_parts.append(f"vendor={profile_vendor}")
    if has_cpuid_tuple:
        cpu_parts.extend([f"family={int(family)}", f"model={int(model)}", f"stepping={int(stepping)}"])
    else:
        not_applied.append("cpu_id")
    if escaped_model_id:
        cpu_parts.append(f"model-id={escaped_model_id}")
    plan["cpu"] = ",".join(cpu_parts)
else:
    # Under KVM, enforce same-vendor CPUID to prevent AMD/Intel flag leakage & wrong kernel errata.
    host_vendor = detect_host_vendor()
    cpu_parts = ["max", "kvm=off", "-hypervisor"]
    if host_vendor == "AuthenticAMD":
        cpu_parts.append("-svm")
    elif host_vendor == "GenuineIntel":
        cpu_parts.append("-vmx")

    if host_vendor and profile_vendor and profile_vendor != host_vendor:
        not_applied.append("cross_vendor_cpu")
        fallback_model = (
            "AMD Ryzen 7 5800X 8-Core Processor"
            if host_vendor == "AuthenticAMD"
            else "12th Gen Intel(R) Core(TM) i7-12700"
        )
        cpu_parts.append(f"model-id={fallback_model}")
    else:
        if has_cpuid_tuple:
            cpu_parts.extend([f"family={int(family)}", f"model={int(model)}", f"stepping={int(stepping)}"])
        else:
            not_applied.append("cpu_id")
        if escaped_model_id:
            cpu_parts.append(f"model-id={escaped_model_id}")
    plan["cpu"] = ",".join(cpu_parts)

acpi_oem_id = sanitize_acpi_id(hardware.get("acpi_oem_id"), 6)
if acpi_oem_id:
    plan["acpi_oem_id"] = acpi_oem_id

acpi_oem_table_id = sanitize_acpi_id(hardware.get("acpi_oem_table_id"), 8)
if acpi_oem_table_id:
    plan["acpi_oem_table_id"] = acpi_oem_table_id

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
  local cpu memory vcpus mac serial skipped acpi_oem acpi_table
  cpu=$(_hw_field cpu)
  memory=$(_hw_field memory_mb)
  vcpus=$(_hw_field smp)
  mac=$(_hw_field mac)
  serial=$(_hw_field disk_serial)
  acpi_oem=$(_hw_field acpi_oem_id)
  acpi_table=$(_hw_field acpi_oem_table_id)
  skipped=$(_hw_field not_applied)
  [ -n "$cpu" ] && CPU_MODEL=$cpu
  [ -n "$memory" ] && KIN_KVM_MEMORY_MB=$memory
  [ -n "$vcpus" ] && KIN_KVM_VCPUS=$vcpus
  [ -n "$mac" ] && KIN_KVM_MAC=$mac
  [ -n "$serial" ] && KIN_KVM_DISK_SERIAL=$serial
  [ -n "$acpi_oem" ] && KIN_KVM_ACPI_OEM_ID=$acpi_oem
  [ -n "$acpi_table" ] && KIN_KVM_ACPI_OEM_TABLE_ID=$acpi_table
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
