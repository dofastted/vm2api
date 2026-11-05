# Cluster-page KVM migration / memory enlargement

Administrators can open **集群 → source machine → slot row → 迁移 / 扩容**.
Selecting the existing node enlarges memory without copying the disk; selecting
another node performs a **cold**, not live, migration. Closing the dialog does
not cancel a task; reopen the same slot to see its latest persisted result.
Nothing in this feature deploys the control plane or automatically migrates slots.

## Deliberately limited first version

- Running Claude KVM slots on SSH-connected **Linux remote nodes** only. No controller
  placement, Docker-slot, Codex, crag or macOS/native migration, shrinking, or disk resizing.
- Both SSH users must have the same UID/GID. Both nodes need Python 3, GNU
  `timeout` and `nice`; the target needs working KVM and prebuilt slot/egress images.
- The target's desired KVM Docker image ID must equal the source container's
  actual image ID. Boot is pinned to that ID, not its mutable tag, so retagging
  during a long copy cannot boot the overlay against another base disk.
- Cross-node moves reject direct/node-local and loopback SOCKS exits rather than
  quietly changing the account's route. A non-loopback proxy must be reachable
  from the target; final service diagnosis must pass before scheduling resumes.
- One migration at a time per controller project. Configured slot reservations
  include 512 MiB KVM overhead and 1 GiB system headroom, and a fresh MemAvailable
  check must also pass. This is admission control, **not** a physical reservation
  against unrelated host workloads or another controller.
- No active model request is used for verification. Credential/account quota,
  operator schedule-off and unschedulable policy are not reset by migration.

## API / lifecycle

Administrator-only:

```
POST /api/panel/vms/:id/migration
{"target_node_id":"node-example","memory":"4g"}

GET /api/panel/vms/:id/migration
```

POST returns HTTP 202 and a job; GET returns the latest job or null. A second
migration receives 409. Other per-slot mutating panel routes are rejected while
migration is active or needs attention. Node connection changes also see the
existing VM file lock. Do not use the raw Docker console to override the task.

1. Preflight without stopping the original: image/base identity, KVM, Python,
   owners, actual disk allocation, free disk and memory. No image is built by
   the preflight. Missing capacity/image means failure without downtime.
2. Atomically persist the job journal and an owned maintenance hold. Hold the
   watchdog, require two idle scheduler observations three seconds apart, and
   give draining at most 120 seconds. Missing in-flight accounting fails closed.
3. Stop the original. Disable its automatic restart and rename its container for
   rollback. Leave its full disk untouched.
4. Stream regular files, metadata and symlinks over the existing SSH connections
   through the controller with backpressure. No disk/account archive is stored
   on the controller. `run/`, `slot-bin/` and sockets are regenerated. Preserve
   qcow2 extents, disk metadata, guest keys, home and credential directories.
   The stream carries an end-to-end SHA-256 checksum. The receiver writes into
   a new task-owned directory, fsyncs every 256 KiB and publishes by rename only
   after verification. It never merges into an existing destination.
5. Patch only placement/memory/runtime, boot the pinned image and diagnose the
   kernel, container and exit. Keep the maintenance hold until this succeeds.
6. Remove the old stopped container and unused egress resources. For a cross-node
   move, retain the original disk as
   `<source-root>/migration-backups/<slot-id>-<job-id>`. This is intentional cold
   rollback material owned by the administrator, not an active slot or temporary
   staging directory. Delete it only after the administrator's retention period
   and a confirmed usable independent backup. Same-node expansion makes no copy.
7. Clear **only this job's** hold and release the watchdog. Existing operator
   schedule-off and other policy restrictions remain in effect.

Transfer processes have a 30-minute wall-clock limit and run at nice 19. The
sender limits the entire stream to 1 MiB/s; sparse holes cost metadata, not their
logical size. Large or insufficiently sparse disks can exceed this bound; the
job then rolls back rather than running without a deadline. Metadata preflight
and helper cleanup have shorter deadlines. Filesystems without SEEK_DATA/HOLE
fall back to transmitting regular file bytes. Capacity estimates use actual
allocation, so allow extra space for fallback/non-sparse target filesystems.

## Failure, interruption and retained resources

Before target verification, failures first stop/remove the replacement and clean
only directories carrying this job's ownership token, then restore original
placement/memory/runtime and boot the original. The original is never started
when stopping the replacement is uncertain. A failed rollback remains
`needs_attention`, with its maintenance hold and persisted journal; watchdog
recovery and boot revival exclude these slots even after a controller restart.

**There is no automatic crash recovery or force-unlock endpoint in this first
version.** A restart during a destructive phase requires administrator review.
The private `vms/<id>.json` journal includes the original placement/machine/runtime
under `slot_migration.rollback`; the public job response excludes that snapshot.

For an interrupted task, do not clear the hold or start both copies. Pause
controller operations for that slot and inspect both nodes and the recorded
phase. Establish whether the replacement is stopped, where the original cold
files and renamed container are, and whether target verification/cleanup had
already completed. Only after the replacement is conclusively stopped may an
administrator restore the original record fields and container name/restart
policy. Verify the chosen single copy, preserve prior schedule restrictions, and
then clear the matching migration hold/journal state. If the task was already
verified and cleanup was interrupted, finish cleanup instead of reverting a
possibly-used target. Never roll back a completed task by simply changing node_id.

A post-verification cleanup failure returns `done` **with an explicit warning**
listing the original resource locations. The chosen target remains authoritative;
the old copy remains stopped. Resolve the warning before considering cleanup
finished. Failed cleanup does not trigger a second live copy or delete cold data.

## Validation / release gate

Unit coverage exercises the state machine with injected lifecycle operations,
ACL, capacity admission, normal sparse-file/metadata transfer, incomplete-stream
cleanup, and restart exclusion from watchdog/revival. Frontend tests cover memory
choices and progress labels. These are local tests, not proof of successful KVM
migration on a real cluster. Before rollout, perform an opt-in Linux/KVM staging
acceptance test covering successful move/resize, disconnect during transfer,
failed boot, rollback, controller restart and source/target resource cleanup.
**Do not use production as the integration-test environment.**
