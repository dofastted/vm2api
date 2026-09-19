#!/bin/sh
# Pack a HostDzire overlay tarball from the vm2api repo root.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/../../.." && pwd)
cd "$ROOT"
VERSION=$(tr -d ' \n' < VERSION)
OUT=${OUT:-/tmp/vm2api-hostdzire-$VERSION}
TGZ=${TGZ:-$OUT.tgz}

if [ ! -f web/dist/index.html ]; then
  echo "pack-overlay: web/dist missing; run pnpm -C web build" >&2
  exit 1
fi
for b in kin-kernel kin-codex-kernel kin-cookie-auth kin-egress kin-worker; do
  if [ ! -x "bin/$b" ]; then
    echo "pack-overlay: bin/$b missing or not executable" >&2
    exit 1
  fi
done
if [ ! -x share/wrap-cli/cli-node ]; then
  echo "pack-overlay: share/wrap-cli/cli-node missing" >&2
  exit 1
fi

rm -rf "$OUT"
mkdir -p "$OUT/src/config" "$OUT/bin" "$OUT/share" "$OUT/web"
cp -a src/server.mjs "$OUT/src/"
cp -a src/lib "$OUT/src/"
cp -a src/config/distill-rules.json "$OUT/src/config/"
cp -a VERSION "$OUT/"
for b in kin-kernel kin-codex-kernel kin-cookie-auth kin-egress kin-worker; do
  cp -a "bin/$b" "$OUT/bin/"
  chmod 755 "$OUT/bin/$b"
done
cp -a share/wrap-cli "$OUT/share/"
rm -rf "$OUT/share/wrap-cli/cli-dist" "$OUT/share/wrap-cli/bun"
cp -a web/dist "$OUT/web/"
tar -C "$OUT" -czf "$TGZ" .
echo "$TGZ"
