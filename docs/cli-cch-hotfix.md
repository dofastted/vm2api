# Native CLI CCH history repair

## Root cause and provenance

The native CLI searched serialized request JSON for the first billing-looking
string. Messages precede system in its SDK serialization. A billing example in a
tool result could therefore be rewritten instead of the actual system billing
block. Subsequent turns changed historical bytes and lost cache-prefix reuse.

- PR #566 introduced the native CCH payload family.
- PR #580 repaired the Node implementation, but not the published native ELF.
- PR #655 used a different CLI with unrelated prompt changes; restoring that
  entire binary is not this repair.
- PR #659 restored the affected `b5054cb8` CLI. Both v1.3.207 and v1.3.219 pin it.
- The v1.3.218 two-anchor correction does not fix historical content mutation.

Only the first billing block beginning with `x-anthropic-billing-header:` in
`system` is canonical. Message literals, later system examples and embedded
documentation lines stay untouched. Node and native sealing use this boundary.
CCH is a checksum of the final request, **not a session constant**: its value can
change as a request grows; previously sent message contents must not change.

## Historical payloads

These are per-build binary repairs, not upgrades to the latest CLI. The patch
changes only the embedded CCH function span, preserves decompressed ELF length
and all bytes outside that span, and verifies the UPX unpack/repack round trip.
Private CLI source is not distributed in this repository.

| Historical versions | Original SHA256 prefix | Repaired SHA256 prefix | Repaired bytes |
| --- | --- | --- | --- |
| 1.3.198-1.3.199 | 369889d8 | ac3403b6 | 27173284 |
| 1.3.200-1.3.201 | 049200f5 | f96a6aca | 27174008 |
| 1.3.202 | 55efe49e | 1458ef62 | 27174548 |
| 1.3.203-1.3.219 | b5054cb8 | 5d6b33b6 | 27174984 |

Full size/SHA256 pairs and the allowed release tags are hardcoded in
`scripts/fix-cli-cch.mjs`. New, uniquely named assets are appended to the existing
payload releases. No source tags or existing assets are overwritten. Historical
manifests can therefore select the repaired CLI while retaining their exact old
kernel, OpenAI payload, glibc and other pins. Even the old fetch script understands
the resulting manifest; it needs no per-file release override or checksum bypass.

Older versions before 1.3.198 also need Node's #580 repair; this helper explicitly
refuses them rather than claiming a native-only patch fixes the complete chain.
Unknown/custom CLI hashes are also refused. Original historical source archives
remain immutable; existing installations must explicitly apply the repair.
Older persona paths that omit canonical billing remain unchanged; the repair
stops assigning their CCH to historical examples. It does not backport newer
billing injection or cache-anchor policies.

## Apply to an old checkout or installation

Run the helper from the fixed checkout, pointing `--dest` at the historical root:

```sh
node /path/to/fixed-checkout/scripts/fix-cli-cch.mjs --dest /opt/vm2api --check
node /path/to/fixed-checkout/scripts/fix-cli-cch.mjs --dest /opt/vm2api
node /opt/vm2api/scripts/fetch-payload.mjs --check
```

For installations without the new checkout, the standalone helper is also an
append-only asset on the payload releases:

```sh
curl -fL https://github.com/dofastted/vm2api/releases/download/payload-2026.10.22-computer-linux/fix-cli-cch-20261023.mjs -o /tmp/fix-cli-cch-20261023.mjs
echo 'dbb5948e8a7d64b8690995774fd83b825a2f982211f7b33bd3f953027c083fd1  /tmp/fix-cli-cch-20261023.mjs' | sha256sum -c -
node /tmp/fix-cli-cch-20261023.mjs --dest /opt/vm2api
```

`--check` exits nonzero if repair is required and never downloads or writes. For
offline use, add `--artifact /path/to/the/matching/repaired/cli-node`; the same
hardcoded size/SHA256 verification applies. The helper verifies the installed CLI,
backs up the manifest and existing template under `.deploy-bak-cli-cch-*`, then
atomically replaces each file. An interrupted manifest update can be rerun.
If the process was killed, first verify that no repair process remains, then
remove its stale `.cli-cch-hotfix.lock` before rerunning; never remove a live lock.
It does not change VERSION, credentials, routing, scheduling or any other payload.
Keep the printed backup path. Do not run the old fetch concurrently with repair.

**Template repair does not activate running slots.** Drain each Anthropic slot,
use targeted local `wrap-cli/sync`, and recycle only its CLI child if necessary.
For cluster slots copy/atomically replace the matching binary in place and its
persistent slot-bin copy, then recycle the drained CLI child. Do not recreate
containers or change identity. Preserve every original scheduling/manual-disable
flag. Exclude all OpenAI slots, including vm-01; do not run unfiltered fleet sync.
Verify the running executable through `/proc/<pid>/exe`, not only the template.
Old container images can restore old bytes on recreation; repeat the verified
payload refresh before activating a recreated Anthropic slot.

## Regression gates

```sh
node scripts/fetch-payload.mjs
node --test test/unit/cch.test.mjs test/unit/cli-cch-hotfix.test.mjs
node --test test/e2e/cli-cch-history.e2e.test.mjs
```

The E2E runs real Node -> kernel -> CLI -> loopback HTTP, sends three growing
turns containing the original quoted-header trigger, and checks immutable
history plus native/Node final-body digest parity. `KIN_CCH_KERNEL` and
`KIN_CCH_CLI` select exact historical artifacts for compatibility verification.
CI runs this regression against the manifest-pinned CLI, not a reconstructed
source-only substitute. Live cache hit ratios still require real upstream usage;
a loopback fixture cannot establish them.
