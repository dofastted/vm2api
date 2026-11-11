# Optional Docker slot CPU limits

Docker slots have historically used `machine.memory` but **not** `machine.vcpus`.
`vcpus` remains a KVM guest setting; existing Docker slots do not acquire a cap
when upgrading.

The panel creation API (`POST /api/panel/vms/create`) now accepts an optional
per-slot `machine.docker_cpus` number, for example alongside the other required
creation options:

```json
{
  "runtime_type": "docker",
  "machine": { "memory": "1g", "docker_cpus": 0.5 },
  "start": false
}
```

- Omitted or `0`: no CPU quota (backward-compatible default).
- `0.01` through `16`: a CPU-time hard ceiling, including fractional CPUs.
  For example `0.5` means up to half of one host CPU's time, not a dedicated CPU.
- Strings, null, non-finite numbers and out-of-range values are rejected with
  `invalid_machine`; `docker_cpus` is rejected for KVM creation.
- The quota is saved in the slot's `machine` record. Local Docker creation uses
  `--cpus`; cluster Docker creation uses the equivalent Engine `NanoCpus` field.
  Claude and GPT Docker slots share the same policy.
- This is an API-only, per-slot creation option. The current creation form and
  global defaults have no CPU-quota control. No implicit fallback to global
  `vcpus`, migration or fleet-wide quota update is performed.

## When it takes effect

Only **container creation/recreation** applies resource arguments. A normal
start of an existing stopped container, a kernel restart, or a control-plane
restart retains that container's existing limits. This change does not add a
live-update endpoint, automatically recreate existing slots, or modify storage,
identity, KVM runner resources or memory/swap policy.

CPU quota is not CPU affinity or a reservation. Very small limits can increase
CLI startup and response latency. The daemon must support CPU quotas; Docker
creation errors are returned rather than retrying without the requested cap.

## Claude kernel worker threads

The Claude `kin-kernel` launcher sets `TOKIO_WORKER_THREADS` at kernel startup
from the process CPU affinity and the tightest visible cgroup CPU quota (v1 or
v2, including visible ancestors). Fractional quotas round up to a thread count,
with a minimum of one; the CPU-time quota itself is unchanged. This budgets
Tokio workers, not all process threads, CLI subprocesses, concurrent requests,
or CPUs used by the upstream model. Codex, CRAG and native launchers are unchanged.

New local and cluster Docker containers get the launcher in their command;
detached Docker kernel launches also use it. A legacy Docker container remains
valid and restarting it retains its original command. The launcher alone does
not trigger recreation.

KVM uses `machine.vcpus` for guest CPU topology, not `machine.docker_cpus`.
With a matching runner and freshly provisioned guest, guest affinity and quota
bound the worker count, further capped by the runner's detected CPU budget.
Existing overlays do not install new guest scripts from a regenerated seed.
Do not recreate an overlay for this change: before any planned runner
replacement, verify that the base image ID and disk size match the saved
`overlay.id` and `overlay.size` (a mismatch can recreate the disk).

### Disposable serving check

One disposable Docker slot ran the real `kin-kernel` and `cli-node` extracted
from `vm2api-ci-pin-fix:20261112`, with four clients streaming through the
Unix socket's `/internal/v1/messages` endpoint and a loopback fixture upstream.
In the heavier SSE fixture, samples counted CPU time only from PID 1 Tokio
threads observed blocked at the start of the window. CLI and upstream CPU
were excluded. At a 3-CPU quota, 10 of 1,251 windows exceeded
1.02 CPU-ms per wall-ms. The strongest window recorded 5.85 ms of thread CPU
within 3.84 ms of wall time. At a 1-CPU quota, none of 865 windows exceeded
that threshold. The lighter fixture did not show overlap with this check.
The serving samples precede the final cgroup namespace-path refinement.
A separate smoke check of the final launcher confirmed thread budgets of
1 and 3 under the corresponding Docker quotas.

This demonstrates brief kernel-thread overlap in the serving path, not
sustained scaling or faster inference. The same payload with Tokio's default
worker sizing already had one busy worker at 1 CPU and three at 3 CPUs in
the lighter fixture. Each quota and launcher combination was sampled once;
these runs do not establish a launcher speedup. KVM guest serving and
remote-model compute were not measured.

## Checks

`node --test test/unit/docker-slot-cpu.test.mjs` covers strict validation,
legacy defaults, local/cluster argument parity, Claude/GPT and KVM exclusion.
An operator can inspect `HostConfig.NanoCpus` and, on cgroup v2, `cpu.max` inside
a separately authorized disposable container. Do not load-test serving slots.
