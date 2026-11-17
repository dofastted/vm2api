#!/usr/bin/env bash
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin

[[ $# == 5 && $2 =~ ^[0-7]$ && $3 =~ ^[0-9]+$ && $4 =~ ^[0-9]+(\.[0-9]+){3}$ && $5 =~ ^[0-9]+$ ]]
prefix=vm2agy$2
base=$((4 * $2))
gateway=198.18.252.$((base + 1))
guest=198.18.252.$((base + 2))
namespace=$prefix
host_link=${prefix}h
peer_link=${prefix}p
docker_chain=VM2API-AGY-$2

iptables_rule() { iptables -w 3 "$@"; }

docker_chain_exists() {
    command -v iptables >/dev/null && iptables_rule -S "$docker_chain" >/dev/null 2>&1
}

allow_docker_forwarding() {
    if ! command -v iptables >/dev/null || ! iptables_rule -S DOCKER-USER >/dev/null 2>&1; then
        return
    fi
    iptables_rule -N "$docker_chain"
    iptables_rule -A "$docker_chain" -i "$host_link" -s "$guest/32" -d "$1/32" \
        -p tcp --dport "$2" -m conntrack --ctstate NEW,ESTABLISHED -j ACCEPT
    iptables_rule -A "$docker_chain" -o "$host_link" -d "$guest/32" -s "$1/32" \
        -p tcp --sport "$2" -m conntrack --ctstate ESTABLISHED -j ACCEPT
    iptables_rule -I DOCKER-USER 1 -i "$host_link" -j "$docker_chain"
    iptables_rule -I DOCKER-USER 1 -o "$host_link" -j "$docker_chain"
}

cleanup() {
    if ip link show "$host_link" >/dev/null 2>&1; then ip link delete "$host_link"; fi
    if [[ -e /run/netns/$namespace ]]; then ip netns delete "$namespace"; fi
    if nft list table inet "$prefix" >/dev/null 2>&1; then nft delete table inet "$prefix"; fi
    if docker_chain_exists; then
        local direction
        for direction in -i -o; do
            if iptables_rule -C DOCKER-USER "$direction" "$host_link" -j "$docker_chain" >/dev/null 2>&1; then
                iptables_rule -D DOCKER-USER "$direction" "$host_link" -j "$docker_chain"
            fi
        done
        iptables_rule -F "$docker_chain"
        iptables_rule -X "$docker_chain"
    fi
}

case $1 in
    stop) cleanup; exit ;;
    start) ;;
    *) exit 2 ;;
esac

[[ $(< /proc/sys/net/ipv4/ip_forward) == 1 ]]
[[ ! -e /run/netns/$namespace ]]
if ip link show "$host_link" >/dev/null 2>&1 || nft list table inet "$prefix" >/dev/null 2>&1 || docker_chain_exists; then
    exit 1
fi
trap cleanup EXIT
ip netns add "$namespace"
ip link add "$host_link" type veth peer name "$peer_link" netns "$namespace"
ip -n "$namespace" link set lo up
ip -n "$namespace" address add "$guest/30" dev "$peer_link"

ip netns exec "$namespace" nft -f - <<EOF
table inet gemini_out {
    chain translate {
        type nat hook output priority -100; policy accept;
        meta skuid $3 return
        ip daddr 127.0.0.0/8 return
        meta nfproto ipv4 udp dport 53 redirect to :1053
        meta nfproto ipv4 tcp dport 53 redirect to :1053
        meta nfproto ipv4 meta l4proto tcp redirect to :1080
    }
    chain restrict {
        type filter hook output priority filter; policy drop;
        oifname "lo" accept
        ct status dnat ip daddr 127.0.0.1 tcp dport { 1053, 1080 } accept
        ct status dnat ip daddr 127.0.0.1 udp dport 1053 accept
        meta skuid $3 ip daddr $4 tcp dport $5 accept
    }
    chain inbound {
        type filter hook input priority filter; policy drop;
        iifname "lo" accept
        ct state established,related accept
    }
}
EOF
nft -f - <<EOF
table inet $prefix {
    chain restrict {
        type filter hook forward priority -20; policy accept;
        iifname "$host_link" ip saddr $guest ip daddr $4 tcp dport $5 accept
        iifname "$host_link" drop
        oifname "$host_link" ct state established,related accept
        oifname "$host_link" drop
    }
    chain host_input {
        type filter hook input priority -20; policy accept;
        iifname "$host_link" drop
    }
    chain translate {
        type nat hook postrouting priority srcnat; policy accept;
        ip saddr $guest ip daddr $4 tcp dport $5 masquerade
    }
}
EOF
allow_docker_forwarding "$4" "$5"
ip address add "$gateway/30" dev "$host_link"
ip link set "$host_link" up
ip -n "$namespace" link set "$peer_link" up
ip -n "$namespace" route add default via "$gateway" dev "$peer_link" onlink
trap - EXIT
