#!/usr/bin/env bash
set -Eeuo pipefail
# Bootstrap postgres never shares the application's password. No password is logged or passed in argv.
if [ -z "${VM2API_POSTGRES_PASSWORD:-}" ]; then
  echo 'VM2API_POSTGRES_PASSWORD is required for the application role.' >&2
  exit 1
fi
POSTGRES_PASSWORD="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
export POSTGRES_PASSWORD
exec /usr/local/bin/docker-entrypoint.sh "$@"
