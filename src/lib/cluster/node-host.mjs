/**
 * Extension-node host stats read over the existing SSH link, on the same scale
 * as the local panel host column: CPU = load1 / cores, memory = MemAvailable.
 * Remote nodes run no control-plane process, so the third figure is the sum of
 * Docker container memory (cgroup v2, minus inactive_file like `docker stats`).
 * The root filesystem line (`disk <KiB total> <KiB used> <KiB avail>`) feeds the
 * cluster page's disk column; it is optional so an odd `df` never hides the rest.
 */

import { shellQuote } from './remote-fs.mjs'

export const NODE_HOST_TIMEOUT_MS = 5_000

// POSIX `df -P`: 1024-byte blocks, one line per filesystem. Slots live on the login's
// home (Linux root: same disk as `/`; macOS: the Data volume, not the sealed system one).
const DISK_LINE = (target) => `df -Pk ${target} 2>/dev/null | awk 'NR==2{print "disk", $2, $3, $4}'`

const NODE_HOST_SCRIPT = [
  'echo "ncpu $(nproc)"',
  'echo "load $(cat /proc/loadavg)"',
  "grep -E '^(MemTotal|MemAvailable):' /proc/meminfo",
  DISK_LINE('/'),
  'for d in /sys/fs/cgroup/system.slice/docker-*.scope /sys/fs/cgroup/docker/*; do',
  '  [ -r "$d/memory.current" ] || continue',
  `  echo "cg $(cat "$d/memory.current") $(awk '$1=="inactive_file"{print $2}' "$d/memory.stat" 2>/dev/null)"`,
  'done',
].join('\n')

export const NODE_HOST_COMMAND = `sh -c ${shellQuote(NODE_HOST_SCRIPT)}`

// macOS: same lines and units as /proc. Available = free + inactive + speculative + purgeable pages
// (what Activity Monitor can hand out without paging); slot memory = RSS of processes under ~/.vm2api.
const NODE_HOST_SCRIPT_DARWIN = [
  'echo "ncpu $(sysctl -n hw.ncpu)"',
  `echo "load $(sysctl -n vm.loadavg | tr -d '{}')"`,
  'echo "MemTotal: $(( $(sysctl -n hw.memsize) / 1024 ))"',
  `vm_stat | awk -v ps="$(sysctl -n hw.pagesize)" '/^Pages (free|inactive|speculative|purgeable):/{gsub(/\\./,"",$NF); n+=$NF} END{print "MemAvailable:", int(n*ps/1024)}'`,
  `ps -axo rss=,command= | awk -v root="$HOME/.vm2api/" 'index($0, root) && !index($0, "awk -v root"){s+=$1} END{print "cg", s*1024, 0}'`,
  DISK_LINE('"$HOME"'),
].join('\n')

export const NODE_HOST_COMMAND_DARWIN = `sh -c ${shellQuote(NODE_HOST_SCRIPT_DARWIN)}`

export function nodeHostCommand(platform) {
  return platform === 'darwin' ? NODE_HOST_COMMAND_DARWIN : NODE_HOST_COMMAND
}

const num = (s) => {
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/**
 * Disk figures on `df`'s scale: percent = used / (used + available), so blocks
 * reserved for root do not read as free. All null when the line was missing.
 */
export function diskFigures(total, used, avail) {
  if (!(total > 0) || used == null || avail == null || used < 0 || avail < 0 || used + avail <= 0) {
    return { disk_total: null, disk_used: null, disk_pct: null }
  }
  return {
    disk_total: total,
    disk_used: used,
    disk_pct: Math.round((used / (used + avail)) * 1000) / 10,
  }
}

/** Returns null when the essentials (cores, load, memory) are missing. */
export function parseNodeHost(stdout) {
  let cpuCount = null
  let load = []
  let memTotal = null
  let memAvailable = null
  let containersMem = null
  let disk = diskFigures(null)
  for (const line of String(stdout || '').split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts[0] === 'ncpu') cpuCount = num(parts[1])
    else if (parts[0] === 'load') load = parts.slice(1, 4).map(num)
    else if (parts[0] === 'MemTotal:') memTotal = num(parts[1]) * 1024
    else if (parts[0] === 'MemAvailable:') memAvailable = num(parts[1]) * 1024
    else if (parts[0] === 'disk') {
      const [total, used, avail] = parts.slice(1, 4).map((v) => {
        const kib = num(v)
        return kib == null ? null : kib * 1024
      })
      disk = diskFigures(total, used, avail)
    } else if (parts[0] === 'cg') {
      const current = num(parts[1])
      if (current == null) continue
      containersMem = (containersMem || 0) + Math.max(0, current - (num(parts[2]) || 0))
    }
  }
  const [load1, load5, load15] = load
  if (!cpuCount || load1 == null || !memTotal || memAvailable == null) return null
  const memUsed = Math.max(0, memTotal - memAvailable)
  return {
    cpu_count: cpuCount,
    load1,
    load5,
    load15,
    cpu_pct: Math.round(Math.min(1000, (load1 / cpuCount) * 1000)) / 10,
    mem_total: memTotal,
    mem_used: memUsed,
    mem_pct: Math.round((memUsed / memTotal) * 1000) / 10,
    containers_mem: containersMem,
    ...disk,
  }
}
