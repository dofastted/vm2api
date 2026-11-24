#!/usr/bin/env bash
set -euo pipefail

# End-to-end Linux netfilter smoke test for #1622:
# Proves that Gemini's isolated netns + host-side single-target relay traverses
# a host transparent proxy (PREROUTING REDIRECT + OUTPUT REDIRECT) AND survives
# a strict iptables INPUT DROP policy, while keeping host_input DROP for all
# other host ports and cleaning up every namespace/nft/iptables resource.
[[ $# == 1 ]]
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
egress=$(realpath -- "$1")
unshare_flags=(-nm)
if [[ $(id -u) != 0 ]]; then
    unshare_flags=(-Urnm)
fi

unshare "${unshare_flags[@]}" bash -s -- "$root" "$egress" <<'NS'
set -euo pipefail
mount --make-rprivate /
mount -t tmpfs tmpfs /run
ip link set lo up
echo 0 > /proc/sys/net/ipv4/ip_forward

# Hardened host baseline: default INPUT DROP + transparent proxy PREROUTING & OUTPUT REDIRECT.
iptables -P INPUT DROP
iptables -A INPUT -i lo -j ACCEPT
iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -t nat -A PREROUTING -p tcp -j REDIRECT --to-ports 52345

# Remote mock SOCKS5 endpoint in separate netns (192.0.2.5:1080).
ip netns add gemini-fixture
ip link add gemini-fxh type veth peer name gemini-fxp netns gemini-fixture
ip address add 192.0.2.1/24 dev gemini-fxh
ip link set gemini-fxh up
ip -n gemini-fixture link set lo up
ip -n gemini-fixture address add 192.0.2.5/24 dev gemini-fxp
ip -n gemini-fixture link set gemini-fxp up
ip -n gemini-fixture route add default via 192.0.2.1

ip netns exec gemini-fixture python3 - <<'PY' &
import socket

with socket.create_server(("192.0.2.5", 1080)) as server:
    server.settimeout(10)
    connection, _ = server.accept()
    with connection, connection.makefile("rb") as stream:
        connection.settimeout(5)
        assert stream.read(3) == b"\x05\x01\x00"
        connection.sendall(b"\x05\x00")
        assert stream.read(10) == b"\x05\x01\x00\x01\xcb\x00\x71\x07\x01\xbb"
        connection.sendall(b"\x05\x00\x00\x01\x00\x00\x00\x00\x00\x00")
        assert stream.read(4) == b"test"
        connection.sendall(b"pong")
PY
proxy_pid=$!

relay_uid=0
relay_prefix=()
tproxy_mark=0
if [[ $(id -u) == 0 ]] && command -v setpriv >/dev/null && id nobody >/dev/null 2>&1; then
    relay_uid=$(id -u nobody)
    relay_prefix=(setpriv --reuid "$relay_uid" --regid "$relay_uid" --clear-groups)
    iptables -t nat -A OUTPUT -m owner --uid-owner "$relay_uid" -d 192.0.2.5 -p tcp --dport 1080 -j REDIRECT --to-ports 52345
else
    tproxy_mark=0x66
    iptables -t nat -A OUTPUT -d 192.0.2.5 -p tcp --dport 1080 -m mark ! --mark 0x66 -j REDIRECT --to-ports 52345
fi

# Mock transparent proxy on :52345 forwarding host OUTPUT traffic to 192.0.2.5:1080
# and writing a marker file to prove the front-hop was actually traversed.
tproxy_hit=$(mktemp)
python3 - "$tproxy_hit" "$tproxy_mark" <<'PY' &
import socket, sys, threading

hit_file = sys.argv[1]
so_mark = int(sys.argv[2], 0)

def pipe(src, dst):
    try:
        while True:
            chunk = src.recv(4096)
            if not chunk:
                break
            dst.sendall(chunk)
    except OSError:
        pass
    finally:
        try:
            dst.shutdown(socket.SHUT_WR)
        except OSError:
            pass

with socket.create_server(("0.0.0.0", 52345)) as server:
    server.settimeout(10)
    client, _ = server.accept()
    with open(hit_file, "w", encoding="ascii") as out:
        out.write("HIT\n")
    with client, socket.socket(socket.AF_INET, socket.SOCK_STREAM) as upstream:
        upstream.settimeout(3)
        if so_mark:
            upstream.setsockopt(socket.SOL_SOCKET, getattr(socket, "SO_MARK", 36), so_mark)
        upstream.connect(("192.0.2.5", 1080))
        t1 = threading.Thread(target=pipe, args=(client, upstream), daemon=True)
        t2 = threading.Thread(target=pipe, args=(upstream, client), daemon=True)
        t1.start()
        t2.start()
        t1.join(5)
        t2.join(5)
PY
tproxy_pid=$!

# Mock unrelated host service on :22222 (must remain unreachable from vm2agy0).
python3 - <<'PY' &
import socket

with socket.create_server(("0.0.0.0", 22222)) as server:
    server.settimeout(10)
    try:
        conn, _ = server.accept()
        conn.close()
    except OSError:
        pass
PY
host_svc_pid=$!

trap 'kill "$proxy_pid" "$tproxy_pid" "$host_svc_pid" "${relay_pid:-}" "${egress_pid:-}" 2>/dev/null || true; rm -f "$tproxy_hit"' EXIT
sleep 0.2

helper="$1/scripts/gemini-host-egress.sh"
gateway=198.18.252.1
guest=198.18.252.2
relay_port=41080

bash "$helper" start 0 0 "$gateway" "$relay_port"
if bash "$helper" start 0 0 "$gateway" "$relay_port"; then exit 1; fi

# Run the exact RELAY_EXEC from scripts/gemini-host.py in host netns.
relay_script=$(python3 - "$1/scripts/gemini-host.py" <<'PY'
import ast, pathlib, sys
tree = ast.parse(pathlib.Path(sys.argv[1]).read_text())
for node in tree.body:
    if isinstance(node, ast.Assign) and any(getattr(t, "id", None) == "RELAY_EXEC" for t in node.targets):
        print(ast.literal_eval(node.value))
        break
PY
)
"${relay_prefix[@]}" python3 -I -c "$relay_script" "$$" "$gateway" "$relay_port" "$guest" 192.0.2.5 1080 &
relay_pid=$!

for attempt in {1..40}; do
    if python3 - "$gateway" "$relay_port" "$relay_uid" <<'PY'
import socket, struct, sys
addr_hex = "%08X:%04X" % (struct.unpack("=I", socket.inet_aton(sys.argv[1]))[0], int(sys.argv[2]))
with open("/proc/net/tcp") as f:
    next(f, None)
    ok = any(len(r := l.split()) > 7 and r[1] == addr_hex and r[3] == "0A" and r[7] == sys.argv[3] for l in f)
sys.exit(0 if ok else 1)
PY
    then
        break
    fi
    sleep .05
done

# Start real kin-egress inside vm2agy0 pointing at the slot gateway relay.
ip netns exec vm2agy0 "$2" --socks "socks5h://$gateway:$relay_port" --listen 127.0.0.1:1080 --dns 127.0.0.1:1053 &
egress_pid=$!
for attempt in {1..40}; do
    if ip netns exec vm2agy0 awk '$2 == "0100007F:0438" && $4 == "0A" { ready = 1 } END { exit !ready }' /proc/net/tcp; then break; fi
    sleep .05
done

# 1. End-to-end SOCKS5 request from vm2agy0 through kin-egress -> gateway relay -> host OUTPUT -> tproxy -> SOCKS5.
ip netns exec vm2agy0 nft insert rule inet gemini_out translate ip daddr 203.0.113.7 meta l4proto tcp redirect to :1080
ip netns exec vm2agy0 python3 - <<'PY'
import socket

with socket.create_connection(("203.0.113.7", 443), 3) as connection:
    connection.sendall(b"test")
    assert connection.makefile("rb").read(4) == b"pong"
PY
wait "$proxy_pid"
wait "$tproxy_pid"
[[ $(cat "$tproxy_hit") == "HIT" ]]

# 2. Host isolation still holds: other host ports & direct tproxy port & direct remote IP remain blocked!
ip netns exec vm2agy0 python3 - <<'PY'
import socket

for target in (("198.18.252.1", 22222), ("198.18.252.1", 52345), ("192.0.2.5", 1080)):
    try:
        socket.create_connection(target, 0.8).close()
    except OSError:
        pass
    else:
        raise AssertionError(f"forbidden host/direct target remained reachable: {target}")
PY

# 3. Stopping egress & relay fails closed and cleans up all netns/nft/iptables rules.
kill "$egress_pid" "$relay_pid"
wait "$egress_pid" || true
wait "$relay_pid" || true
bash "$helper" stop 0 0 "$gateway" "$relay_port"
[[ ! -e /run/netns/vm2agy0 ]]
if nft list table inet vm2agy0 >/dev/null 2>&1; then exit 1; fi
if iptables -S VM2API-AGY-IN-0 >/dev/null 2>&1; then exit 1; fi
[[ $(iptables -S INPUT) == $'-P INPUT DROP\n-A INPUT -i lo -j ACCEPT\n-A INPUT -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT' ]]
printf '%s\n' 'Gemini namespace relay: transparent proxy traversal, INPUT DROP compatibility, host isolation and cleanup passed.'
NS
