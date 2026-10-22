import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { runtimeKind } from './runtime-kind.mjs'
import { slotHost } from './slot-host.mjs'
import { slotExecArgv } from './slot-exec.mjs'

const runFile = promisify(execFile)

const DMI_KEYS = Object.freeze(['manufacturer', 'product', 'version', 'family', 'serial', 'uuid'])

function textOrNull(value) {
  if (value == null) return null
  const text = String(value).trim()
  return text ? text : null
}

function intOrNull(value) {
  if (value == null || value === '') return null
  const n = typeof value === 'number' ? value : Number.parseInt(String(value), 10)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.trunc(n)
}

function dmiFrom(doc = {}) {
  const src = doc.dmi && typeof doc.dmi === 'object' && !Array.isArray(doc.dmi) ? doc.dmi : {}
  const dmi = {}
  for (const key of DMI_KEYS) {
    dmi[key] = textOrNull(src[key] ?? doc[`dmi_${key}`])
  }
  return dmi
}

/** Normalize guest-observed hardware. Missing optional facts stay null. */
export function normalizeGuestHardware(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null
  return {
    cpu_model: textOrNull(doc.cpu_model),
    cpu_cores: intOrNull(doc.cpu_cores),
    memory_bytes: intOrNull(doc.memory_bytes),
    root_disk: textOrNull(doc.root_disk),
    mac: textOrNull(doc.mac),
    dmi: dmiFrom(doc),
    shell: textOrNull(doc.shell),
    package_managers: textOrNull(doc.package_managers),
    runtimes: textOrNull(doc.runtimes),
  }
}

export function parseGuestHardware(raw) {
  const text = String(raw || '').trim()
  if (!text) return null
  try {
    return normalizeGuestHardware(JSON.parse(text))
  } catch {
    return null
  }
}

// Run inside the guest: never substitute the control plane's OS or machine ID.
// NUL separators preserve whitespace and quotes without requiring jq or Node.
// Minimal images (kin-os-arch) ship without `hostname`; `uname -n` is the same nodename.
// Optional hardware is a final JSON field; missing files/commands must not abort.
// In a Docker slot /proc and /sys/class/dmi are the host's: the slot computer
// (kin-computer → /etc/kin-hardware, /etc/kin-dmi) and the container's cgroup
// limits come first. KVM guests have neither and read their own /proc and DMI.
export const READ_IDENTITY = `
set -eu
if [ -r /etc/os-release ]; then . /etc/os-release; fi
host="$(hostname 2>/dev/null || uname -n)"
printf '%s\\000' "$host" "\${ID:-}" "\${PRETTY_NAME:-}" "$(uname -r)" "$(uname -m)"
printf '%s\\000' "$(cat /etc/machine-id 2>/dev/null || true)" "\${TZ:-$(cat /etc/timezone 2>/dev/null || true)}" "\${LC_ALL:-\${LANG:-}}"
jesc() {
  awk -v s="$1" 'BEGIN{gsub(/\\\\/,"\\\\\\\\",s); gsub(/"/,"\\\\042",s); printf "%s", s}' 2>/dev/null || printf '%s' "$1"
}
jstr() { printf '"%s"' "$(jesc "$1")"; }
jnum() { case $1 in ''|*[!0-9]*) printf 'null' ;; *) printf '%s' "$1" ;; esac; }
read_sys() {
  if [ -r "$1" ]; then IFS= read -r _v < "$1" || true; printf '%s' "\${_v}"; fi
}
trim() { printf '%s' "$1" | tr -d '\\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'; }
set +e
: "\${KIN_HW_DIR:=/etc/kin-hardware}" "\${KIN_DMI_DIR:=/etc/kin-dmi}" "\${KIN_CGROUP_DIR:=/sys/fs/cgroup}"
read_num() {
  _x=$(trim "$(read_sys "$1")")
  case $_x in ''|0|*[!0-9]*) _x= ;; esac
  printf '%s' "$_x"
}
cg_cpus() {
  _q=; _p=
  if [ -r "$KIN_CGROUP_DIR/cpu.max" ]; then
    read -r _q _p < "$KIN_CGROUP_DIR/cpu.max"
  else
    _q=$(read_num "$KIN_CGROUP_DIR/cpu/cpu.cfs_quota_us")
    _p=$(read_num "$KIN_CGROUP_DIR/cpu/cpu.cfs_period_us")
  fi
  case $_q in ''|*[!0-9]*) return 0 ;; esac
  case $_p in ''|0|*[!0-9]*) return 0 ;; esac
  printf '%s' $(( (_q + _p - 1) / _p ))
}
cg_mem() {
  _m=$(read_num "$KIN_CGROUP_DIR/memory.max")
  [ -n "$_m" ] || _m=$(read_num "$KIN_CGROUP_DIR/memory/memory.limit_in_bytes")
  # cgroup v1 reports no limit as a page-rounded LONG_MAX.
  [ \${#_m} -lt 19 ] && printf '%s' "$_m"
}
hw_cpu_model=$(trim "$(read_sys "$KIN_HW_DIR/cpu_brand")")
[ -n "$hw_cpu_model" ] || hw_cpu_model=$(trim "$(awk -F': ' '/^model name[ \\t]*:/{print $2; exit} /^Hardware[ \\t]*:/{print $2; exit}' /proc/cpuinfo 2>/dev/null)")
hw_cpu_cores=$(cg_cpus)
[ -n "$hw_cpu_cores" ] || hw_cpu_cores=$(read_num "$KIN_HW_DIR/logical_cpus")
[ -n "$hw_cpu_cores" ] || hw_cpu_cores=$(nproc 2>/dev/null)
if [ -z "$hw_cpu_cores" ]; then hw_cpu_cores=$(awk 'BEGIN{n=0} /^processor[ \\t]*:/{n++} END{print n}' /proc/cpuinfo 2>/dev/null); fi
hw_memory_bytes=$(cg_mem)
[ -n "$hw_memory_bytes" ] || hw_memory_bytes=$(read_num "$KIN_HW_DIR/ram_bytes")
if [ -z "$hw_memory_bytes" ]; then
  hw_mem_kb=$(awk '/^MemTotal:/{print $2; exit}' /proc/meminfo 2>/dev/null)
  if [ -n "$hw_mem_kb" ]; then hw_memory_bytes=$((hw_mem_kb * 1024)); fi
fi
hw_root_disk=$(trim "$(awk '$2=="/"{print $1; exit}' /proc/mounts 2>/dev/null)")
case $hw_root_disk in *docker*|*containerd*|*podman*) hw_root_disk=overlay ;; esac
hw_mac=$(trim "$(read_sys "$KIN_HW_DIR/mac")")
[ "$hw_mac" = "00:00:00:00:00:00" ] && hw_mac=""
for _n in /sys/class/net/*; do
  [ -z "$hw_mac" ] || break
  [ -e "\$_n" ] || continue
  _base=\${_n##*/}
  [ "\$_base" = lo ] && continue
  _addr=$(trim "$(read_sys "\$_n/address")")
  [ -n "\$_addr" ] || continue
  [ "\$_addr" = "00:00:00:00:00:00" ] && continue
  hw_mac=\$_addr
  break
done
_dmi=/sys/class/dmi/id
[ -d "$KIN_DMI_DIR" ] && _dmi=$KIN_DMI_DIR
hw_dmi_manufacturer=$(trim "$(read_sys "\$_dmi/sys_vendor")")
hw_dmi_product=$(trim "$(read_sys "\$_dmi/product_name")")
hw_dmi_version=$(trim "$(read_sys "\$_dmi/product_version")")
hw_dmi_family=$(trim "$(read_sys "\$_dmi/product_family")")
hw_dmi_serial=$(trim "$(read_sys "\$_dmi/product_serial")")
hw_dmi_uuid=$(trim "$(read_sys "\$_dmi/product_uuid")")
hw_shell=\${SHELL:-}
if [ -z "$hw_shell" ] && [ -r /etc/passwd ]; then
  hw_shell=$(awk -F: -v u="$(id -un 2>/dev/null)" '$1==u{print $7; exit}' /etc/passwd 2>/dev/null)
fi
hw_shell=\${hw_shell##*/}
hw_shell=$(trim "$hw_shell")
hw_pms=""
for _spec in 'apt-get:apt' 'dnf:dnf' 'yum:yum' 'pacman:pacman' 'zypper:zypper' 'apk:apk' 'nix-env:nix' 'brew:brew'; do
  _cmd=\${_spec%%:*}
  _name=\${_spec##*:}
  if command -v "\$_cmd" >/dev/null 2>&1; then
    if [ -n "$hw_pms" ]; then hw_pms="$hw_pms,\$_name"; else hw_pms=\$_name; fi
  fi
done
hw_rts=""
add_rt() {
  case ",$hw_rts," in *",$2,"*) return 0 ;; esac
  if command -v "$1" >/dev/null 2>&1; then
    if [ -n "$hw_rts" ]; then hw_rts="$hw_rts,$2"; else hw_rts=\$2; fi
  fi
}
add_rt node node
add_rt bun bun
add_rt python3 python
add_rt python python
add_rt go go
add_rt rustc rust
add_rt java java
add_rt ruby ruby
add_rt php php
add_rt deno deno
add_rt perl perl
hw_json=$(printf '{"cpu_model":%s,"cpu_cores":%s,"memory_bytes":%s,"root_disk":%s,"mac":%s,"dmi":{"manufacturer":%s,"product":%s,"version":%s,"family":%s,"serial":%s,"uuid":%s},"shell":%s,"package_managers":%s,"runtimes":%s}' \\
  "$(jstr "$hw_cpu_model")" "$(jnum "$hw_cpu_cores")" "$(jnum "$hw_memory_bytes")" "$(jstr "$hw_root_disk")" "$(jstr "$hw_mac")" \\
  "$(jstr "$hw_dmi_manufacturer")" "$(jstr "$hw_dmi_product")" "$(jstr "$hw_dmi_version")" "$(jstr "$hw_dmi_family")" "$(jstr "$hw_dmi_serial")" "$(jstr "$hw_dmi_uuid")" \\
  "$(jstr "$hw_shell")" "$(jstr "$hw_pms")" "$(jstr "$hw_rts")")
[ -n "$hw_json" ] || hw_json='{}'
set -e
printf '%s\\000' "$hw_json"
`

export async function readGuestIdentity(exec, _requestPath, { timeoutMs = 5000, run = runFile } = {}) {
  const fail = (code, message) => ({ ok: false, status: 502, body: { error: { code, message } } })
  if (!exec?.vmId) return fail('vm_required', 'vm required')
  const vm = { ...(exec.vm || {}), id: exec.vmId || exec.vm?.id }
  try {
    const env = slotHost(exec.vm).dockerEnv()
    const { stdout } = await run('docker', slotExecArgv(vm, ['sh', '-c', READ_IDENTITY]), {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 64 * 1024,
      ...(env ? { env } : {}),
    })
    const fields = stdout.split('\0')
    if (
      fields[fields.length - 1] !== '' ||
      (fields.length !== 9 && fields.length !== 10) ||
      !fields[0] ||
      !fields[3] ||
      !fields[4]
    ) {
      return fail('guest_identity_invalid', 'Guest returned incomplete identity data')
    }
    const [hostname, os_id, os_pretty, kernel_release, arch, machine_id, timezone, locale] = fields
    const collected_at = new Date().toISOString()
    const hardware = fields.length === 10 ? parseGuestHardware(fields[8]) : null
    const identity = {
      schema_version: '1',
      runtime_kind: runtimeKind(vm),
      hostname,
      os_id,
      os_pretty,
      kernel_release,
      arch,
      machine_id,
      timezone,
      locale,
      goos: 'linux',
      collected_at,
    }
    if (hardware) {
      hardware.observed_at = collected_at
      identity.hardware = hardware
    }
    return {
      ok: true,
      status: 200,
      body: { identity },
    }
  } catch (error) {
    return fail(
      error.killed ? 'guest_identity_timeout' : 'guest_identity_exec_failed',
      String(error.stderr || error.message || error)
        .trim()
        .slice(0, 300),
    )
  }
}
