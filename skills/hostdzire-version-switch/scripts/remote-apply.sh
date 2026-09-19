#!/bin/sh
# Apply /tmp/vm2api-hostdzire-<VERSION>.tgz onto /opt/kin-gateway.
# Usage: sh remote-apply.sh <VERSION>
set -eu
VERSION=${1:?version}
ROOT=/opt/kin-gateway
STAGE=/tmp/vm2api-hostdzire-$VERSION
TGZ=/tmp/vm2api-hostdzire-$VERSION.tgz
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BAK=$ROOT/.deploy-bak-vm2api-$VERSION-$STAMP

if [ ! -f "$TGZ" ]; then
  echo "remote-apply: missing $TGZ" >&2
  exit 1
fi
mkdir -p "$BAK" "$STAGE"
tar -C "$STAGE" -xzf "$TGZ"

cp -a "$ROOT/src/server.mjs" "$ROOT/src/lib" "$BAK/"
mkdir -p "$BAK/config" "$BAK/bin" "$BAK/share"
cp -a "$ROOT/src/config/distill-rules.json" "$BAK/config/" 2>/dev/null || true
for b in kin-kernel kin-worker kin-egress kin-codex-kernel; do
  if [ -e "$ROOT/bin/$b" ]; then
    cp -a "$ROOT/bin/$b" "$BAK/bin/"
  fi
done
if [ -d "$ROOT/share/wrap-cli" ]; then
  cp -a "$ROOT/share/wrap-cli" "$BAK/share/"
fi
cp -a /var/www/kin-console "$BAK/kin-console"

cp -a "$STAGE/src/server.mjs" "$ROOT/src/server.mjs"
rm -rf "$ROOT/src/lib"
cp -a "$STAGE/src/lib" "$ROOT/src/lib"
if [ -f "$STAGE/src/config/distill-rules.json" ]; then
  cp -a "$STAGE/src/config/distill-rules.json" "$ROOT/src/config/distill-rules.json"
fi
cp -a "$STAGE/VERSION" "$ROOT/VERSION"

mkdir -p "$ROOT/bin"
for b in kin-kernel kin-codex-kernel kin-cookie-auth kin-egress kin-worker; do
  cp -a "$STAGE/bin/$b" "$ROOT/bin/$b.new"
  chmod 755 "$ROOT/bin/$b.new"
  mv -f "$ROOT/bin/$b.new" "$ROOT/bin/$b"
done

rm -rf "$ROOT/share/wrap-cli"
mkdir -p "$ROOT/share"
cp -a "$STAGE/share/wrap-cli" "$ROOT/share/wrap-cli"
chmod 755 "$ROOT/share/wrap-cli/cli-node" "$ROOT/share/wrap-cli/kin-kernel" "$ROOT/share/wrap-cli/kin-kernel.bin" || true

rsync -a --delete --exclude dl "$STAGE/web/dist/" /var/www/kin-console/
ln -sfn /var/www/kin-console-dl /var/www/kin-console/dl
chown -R kincli:kincli /var/www/kin-console

systemctl restart kin-gateway
sleep 2
systemctl is-active kin-gateway
systemctl is-active kin-gateway-go
echo "BAK=$BAK"
echo "VERSION=$(cat "$ROOT/VERSION")"
