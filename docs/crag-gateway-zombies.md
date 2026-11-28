# CRAG gateway worker leaves `claude` children unreaped

Report for the CRAG vendor, plus how vm2api works around it.

## Symptom

On CRAG v2 KVM slots, the guest process `crag-v2 --gateway-worker --config /run/kin/kernel.json`
spawns a `claude` CLI per session. When one of those children exits, the gateway does not always
`wait()` for it, so it stays in the process table as a zombie:

```
PID   PPID  STAT  COMMAND
 210     1  Ssl   crag-v2 --gateway-worker --config /run/kin/kernel.json
 301   210  Zsl   [claude] <defunct>
 302   210  Zsl   [claude] <defunct>
 ...  (children of those claude processes also left behind)
```

- State `Z` with flags `sl` (session leader, multi-threaded at exit), parent is the gateway worker
  (not PID 1), so nothing else can reap them.
- Observed about two `claude` zombies per slot, plus their children, building up over several hours
  of normal traffic. Count only grows; it does not drop while the gateway runs.
- One slot that collected them ended in the panel state 内核故障 (watchdog recovery budget spent).
- Stopping and starting the slot clears them (the gateway exits, init reaps the orphans).

## What would help from the vendor side

- Reap every spawned child (`SIGCHLD` handler or `waitpid(-1, WNOHANG)` loop), including children
  whose session was cancelled or timed out.
- Expose a zombie / unreaped-child count in the gateway health response.

## Collecting evidence on a slot

```sh
kin-guest-exec -u 0 -- sh -c 'ps -eo pid,ppid,stat,etimes,lstart,args | awk "\$3 ~ /^Z/ || /gateway-worker/"'
```

`etimes` / `lstart` of the gateway versus the zombies gives the accumulation rate.

## vm2api workaround: `routing.crag_zombie_guard` (off by default)

```json
"crag_zombie_guard": {
  "enabled": false,
  "interval_sec": 600,
  "zombie_threshold": 4,
  "cooldown_sec": 3600,
  "restart_on_kernel_fault": true,
  "scan_timeout_ms": 8000
}
```

Every `interval_sec` the guard reads `/proc` in each running CRAG v2 slot (through the normal slot
exec path, read-only) and counts zombies whose parent is the gateway worker. A slot at or over
`zombie_threshold`, or kernel-faulted, is power-cycled only when the scheduler has nothing in
flight on it, the native kernel reports no active request, continuation or queue, no hold or
不可调度 is set, no lifecycle lock is taken, and the guard has not cycled it within `cooldown_sec`.
The cycle is the panel 恢复服务 path (maintenance hold, drain, stop, start, diagnosis, watchdog
reset). Afterwards the guard checks the egress binding is unchanged and the zombie count is below
the threshold. Any failed check leaves the slot 不可调度 (`maintenance_failed`) and sends a
notification; an operator 恢复服务 clears it. At most one slot is cycled per tick.
