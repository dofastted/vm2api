# VM telemetry service

Telemetry is an explicit seed-policy opt-in. A newly created VM is disabled;
setting `telemetry_disabled` to `false` writes the VM's `worker.json` identity
and starts the Go `kin-worker telemetry` service. Setting it back to `true`
stops that child process and leaves the VM and its Rust kernel running.

The service reads credentials only from the VM's own Claude home. Its feature
payload uses facts collected from that VM (including its timezone, OS,
hardware, shell and runtime versions), never controller-host defaults or a
synthetic fingerprint. Requests leave through the VM's bound egress, so the
service observes the VM's actual network address. Uploads are periodic and are idle-gated
by `run/telemetry.touch`.

`claude.setting` is a plain, editable seed file beside `settings.json` and is
initialized with:

```text
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
```

## Service-only updates

Go payloads are copied atomically into each slot's persistent `slot-bin`
directory. Cluster containers bind that directory at `/opt/kin-live` (and the
KVM guest payload at `/opt/kin-live`). The panel/fleet `telemetry` action
restarts only the telemetry child and the `kin-egress` helper; it does not
rebuild a VM, replace `vms/`, rotate credentials, or restart the Rust kernel.

An update must verify the new binary hash and the replacement process before
reporting success. A failed service restart is reported per slot so the old VM
identity remains intact and can be rolled back by republishing the previous
binary.
