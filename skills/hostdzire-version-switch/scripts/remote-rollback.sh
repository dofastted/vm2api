#!/bin/sh
# Restore /opt/kin-gateway from a .deploy-bak-vm2api-* snapshot.
# Usage: sh remote-rollback.sh [BAK_DIR]
set -eu
ROOT=/opt/kin-gateway
if [ -n "${1:-}" ]; then
  BAK=$1
else
  BAK=$(ls -1dt "$ROOT"/.deploy-bak-vm2api-* 2>/dev/null | head -1)
fi
if [ -z "$BAK" ] || [ ! -d "$BAK" ]; then
  echo "remote-rollback: no bak dir" >&2
  exit 1
fi
if [ ! -f "$BAK/server.mjs" ] || [ ! -d "$BAK/lib" ]; then
  echo "remote-rollback: $BAK missing server.mjs/lib" >&2
  exit 1
fi

cp -a "$BAK/server.mjs" "$ROOT/src/server.mjs"
rm -rf "$ROOT/src/lib"
cp -a "$BAK/lib" "$ROOT/src/lib"
if [ -f "$BAK/config/distill-rules.json" ]; then
  cp -a "$BAK/config/distill-rules.json" "$ROOT/src/config/distill-rules.json"
fi
mkdir -p "$ROOT/bin"
for b in kin-kernel kin-codex-kernel kin-egress kin-worker; do
  if [ -e "$BAK/bin/$b" ]; then
    cp -a "$BAK/bin/$b" "$ROOT/bin/$b.new"
    chmod 755 "$ROOT/bin/$b.new"
    mv -f "$ROOT/bin/$b.new" "$ROOT/bin/$b"
  fi
done
if [ -d "$BAK/share/wrap-cli" ]; then
  rm -rf "$ROOT/share/wrap-cli"
  mkdir -p "$ROOT/share"
  cp -a "$BAK/share/wrap-cli" "$ROOT/share/wrap-cli"
fi
if [ -d "$BAK/kin-console" ]; then
  rsync -a --delete --exclude dl "$BAK/kin-console/" /var/www/kin-console/
  ln -sfn /var/www/kin-console-dl /var/www/kin-console/dl
  chown -R kincli:kincli /var/www/kin-console
fi

systemctl restart kin-gateway
sleep 2
systemctl is-active kin-gateway
systemctl is-active kin-gateway-go
echo "RESTORED_FROM=$BAK"
echo "VERSION=$(cat "$ROOT/VERSION" 2>/dev/null || true)"
