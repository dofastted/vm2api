#!/bin/sh
# Run one command in Docker Desktop's host network. Local WSL cannot see the
# egress bridge or its listener; this stays project-scoped via KIN_EGRESS_CMD_PREFIX.
command="$1"
shift
case "$command" in
  ss)
    port=$(printf '%s\n' "$*" | sed -n 's/.*:\([0-9][0-9]*\).*/\1/p')
    [ -n "$port" ] || exit 1
    # Query the network namespace that owns the bridge. Its process IDs are
    # meaningful there; do not substitute a Docker client from another namespace.
    exec docker run --rm --network host --pid host --privileged nicolaka/netshoot \
      ss "$@"
    ;;
  iptables)
    exec docker run --rm --network host --pid host --privileged --entrypoint iptables nicolaka/netshoot "$@"
    ;;
  *)
    exit 127
    ;;
esac
