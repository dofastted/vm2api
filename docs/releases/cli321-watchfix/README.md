# Claude CLI 2.1.321 file-watch repair

The repaired CLI handles both `null` and `undefined` filenames from file-watch
events. An unnamed event invalidates cached configuration rather than being
ignored. No recovery budget or memory limit changes are included.

## Historical releases

The scope is releases published since 2026-11-10 00:00 UTC+8:
`v1.4.057` through `v1.4.069`, inclusive. Their tags, original assets and container
images remain unchanged so existing SHA256-pinned downloads remain reproducible.
Each release receives these additional assets:

- `cli-node-2.1.321-watchfix`: the same repaired amd64 ELF shipped in v1.4.070.
- `payload-cli321-watchfix.json`: a complete replacement manifest for that baseline.
- `CLI321-WATCHFIX.md`: these instructions.

The replacement manifests retain every non-CLI path, size and SHA256 from the
corresponding historical tag. All referenced assets live in v1.4.070; its extra
`cc-node` asset is only for the v1.4.057-v1.4.061 historical manifests, not the
current payload. The three checked-in manifests cover these groups:

| Historical versions | Manifest |
| --- | --- |
| v1.4.057-v1.4.061 | payload-v1.4.057-061.json |
| v1.4.062-v1.4.066 | payload-v1.4.062-066.json |
| v1.4.067-v1.4.069 | payload-v1.4.067-069.json |

## Apply to an existing source installation

Run from the installation root after backing up `deploy/payload.json` and the
current CLI. Replace the example tag with the installed historical version.
These commands only install factory payload files; they do not restart live VMs.

```sh
tag=v1.4.069
manifest=$(mktemp)
curl -fL "https://github.com/dofastted/vm2api/releases/download/$tag/payload-cli321-watchfix.json" -o "$manifest"
node scripts/fetch-payload.mjs --manifest "$manifest" --dest .
node scripts/fetch-payload.mjs --manifest "$manifest" --dest . --check
install -m 644 "$manifest" deploy/payload.json
rm -f "$manifest"
```

ARM64 installations must also use the matching `deploy/arm64-cli.json` from
v1.4.070 when rebuilding their native CLI overlay. For container installations,
upgrade to the v1.4.070 image instead of assuming an old image changed.

After installation, drain and restart only the selected Claude slots through
the panel. Verify their running CLI hash and healthy ready-slot count; do not
delete/recreate containers, change account data, or increase recovery attempts.
The independent kin-59 OOM condition is not fixed by this CLI update.
