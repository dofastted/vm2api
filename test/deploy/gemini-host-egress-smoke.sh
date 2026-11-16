#!/usr/bin/env bash
set -euo pipefail

[[ $# == 1 && $(id -u) != 0 ]]
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
egress=$(realpath -- "$1")
unshare -Urnm bash -s -- "$root" "$egress" <<'NS'
set -euo pipefail
mount --make-rprivate /
mount -t tmpfs tmpfs /run
ip link set lo up
echo 1 > /proc/sys/net/ipv4/ip_forward
ip netns add gemini-fixture
ip link add gemini-fxh type veth peer name gemini-fxp netns gemini-fixture
ip address add 192.0.2.1/24 dev gemini-fxh
ip link set gemini-fxh up
ip -n gemini-fixture link set lo up
ip -n gemini-fixture address add 192.0.2.5/24 dev gemini-fxp
ip -n gemini-fixture link set gemini-fxp up
ip netns exec gemini-fixture python3 - <<'PY' &
import socket

with socket.create_server(("192.0.2.5", 1080)) as server:
    server.settimeout(5)
    connection, _ = server.accept()
    with connection, connection.makefile("rb") as stream:
        connection.settimeout(3)
        assert stream.read(3) == b"\x05\x01\x00"
        connection.sendall(b"\x05\x00")
        assert stream.read(10) == b"\x05\x01\x00\x01\xcb\x00\x71\x07\x01\xbb"
        connection.sendall(b"\x05\x00\x00\x01\x00\x00\x00\x00\x00\x00")
        assert stream.read(4) == b"test"
        connection.sendall(b"pong")
PY
proxy_pid=$!
trap 'kill "$proxy_pid" "${egress_pid:-}" 2>/dev/null || true' EXIT
helper="$1/scripts/gemini-host-egress.sh"
bash "$helper" start 0 0 192.0.2.5 1080
ip netns exec vm2agy0 "$2" --socks socks5h://192.0.2.5:1080 --listen 127.0.0.1:1080 --dns 127.0.0.1:1053 &
egress_pid=$!
for attempt in {1..30}; do
    if ip netns exec vm2agy0 awk '$2 == "0100007F:0438" && $4 == "0A" { ready = 1 } END { exit !ready }' /proc/net/tcp; then break; fi
    sleep .05
done
ip netns exec vm2agy0 nft insert rule inet gemini_out translate ip daddr 203.0.113.7 meta l4proto tcp redirect to :1080
ip netns exec vm2agy0 python3 - <<'PY'
import socket

with socket.create_connection(("203.0.113.7", 443), 2) as connection:
    connection.sendall(b"test")
    assert connection.makefile("rb").read(4) == b"pong"
PY
wait "$proxy_pid"
kill "$egress_pid"
wait "$egress_pid"
ip netns exec vm2agy0 python3 - <<'PY'
import socket

try:
    socket.create_connection(("203.0.113.7", 443), 0.5).close()
except OSError:
    pass
else:
    raise AssertionError("request succeeded after the egress helper stopped")
PY
bash "$helper" stop 0 0 192.0.2.5 1080
[[ ! -e /run/netns/vm2agy0 ]]
printf '%s\n' 'Gemini namespace: SOCKS5 forwarding, fail-closed disconnect and cleanup passed.'
NS
