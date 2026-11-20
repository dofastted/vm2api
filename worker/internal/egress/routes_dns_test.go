package egress

import (
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"net/netip"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/net/dns/dnsmessage"
)

// The DNS side was not covered by the real-node run (that verified the TCP
// path), so the behaviour that matters is exercised here: per-exit answers,
// per-exit caching, fail-closed refusal, and that the listeners pass the
// query's source through.

// dnsOverTCP answers every query with ip. Two of these behind two SOCKS exits
// are the case the per-exit cache exists for: one configured upstream address,
// a different answer depending on which exit reached it, which is what geo
// routing and CDNs do to a shared resolver in practice.
func dnsOverTCP(t *testing.T, ip string) net.Listener {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			c, accErr := ln.Accept()
			if accErr != nil {
				return
			}
			go func() {
				defer c.Close()
				for {
					var hdr [2]byte
					if _, rErr := io.ReadFull(c, hdr[:]); rErr != nil {
						return
					}
					query := make([]byte, binary.BigEndian.Uint16(hdr[:]))
					if _, rErr := io.ReadFull(c, query); rErr != nil {
						return
					}
					var msg dnsmessage.Message
					if msg.Unpack(query) != nil || len(msg.Questions) != 1 {
						return
					}
					var out dnsmessage.Message
					if out.Unpack(dnsA(t, msg.Questions[0].Name.String(), 300, net.ParseIP(ip))) != nil {
						return
					}
					out.ID = msg.ID
					packed, pErr := out.Pack()
					if pErr != nil {
						return
					}
					frame := make([]byte, 2+len(packed))
					binary.BigEndian.PutUint16(frame[:2], uint16(len(packed)))
					copy(frame[2:], packed)
					if _, wErr := c.Write(frame); wErr != nil {
						return
					}
				}
			}()
		}
	}()
	return ln
}

// socksTo is a SOCKS exit that lands every CONNECT on target, standing in for
// an exit whose upstream resolver is a different server than another exit's.
func socksTo(t *testing.T, target string, hits *atomic.Int32) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			c, accErr := ln.Accept()
			if accErr != nil {
				return
			}
			one := &oneConnListener{c: c, addr: ln.Addr()}
			go serveTestSOCKSWithTarget(t, one, func(_ byte, _ string, _ uint16) (string, error) {
				if hits != nil {
					hits.Add(1)
				}
				return target, nil
			})
		}
	}()
	return (&url.URL{Scheme: "socks5h", Host: ln.Addr().String()}).String()
}

// answerIP is the A record in a reply, or "" when there is none.
func answerIP(t *testing.T, reply []byte) string {
	t.Helper()
	var msg dnsmessage.Message
	if err := msg.Unpack(reply); err != nil {
		t.Fatalf("unpack reply: %v", err)
	}
	for _, rr := range msg.Answers {
		if a, ok := rr.Body.(*dnsmessage.AResource); ok {
			return net.IP(a.A[:]).String()
		}
	}
	return ""
}

func resolveFrom(t *testing.T, srv *Server, query []byte, src string) ([]byte, error) {
	t.Helper()
	return srv.ResolveDNSFrom(context.Background(), query, fixedAddr(src))
}

// sharedDNSHelper serves two VMs whose exits resolve the same name to
// different addresses. proxy_url is set only so a test can prove it stays
// unused.
func sharedDNSHelper(t *testing.T, hitsDefault, hitsA, hitsB *atomic.Int32) *Server {
	t.Helper()
	srv, err := New(Config{
		ListenTCP: "127.0.0.1:0",
		// Never dialled directly: each exit's SOCKS lands it on that exit's
		// own resolver.
		DNSUpstream: "192.0.2.53:53",
		ProxyURL:    socksTo(t, dnsOverTCP(t, "10.0.0.9").Addr().String(), hitsDefault),
		Routes: []Route{
			{VMIP: "100.64.0.10", ProxyURL: socksTo(t, dnsOverTCP(t, "10.0.0.1").Addr().String(), hitsA)},
			{VMIP: "100.64.0.11", ProxyURL: socksTo(t, dnsOverTCP(t, "10.0.0.2").Addr().String(), hitsB)},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	return srv
}

func TestResolveDNSFromAnswersAndCachesPerExit(t *testing.T) {
	var hitsDefault, hitsA, hitsB atomic.Int32
	srv := sharedDNSHelper(t, &hitsDefault, &hitsA, &hitsB)
	query := cacheQuery(t, 1, "example.com.", dnsmessage.TypeA)

	for range 3 {
		reply, err := resolveFrom(t, srv, query, "100.64.0.10:5300")
		if err != nil {
			t.Fatal(err)
		}
		if got := answerIP(t, reply); got != "10.0.0.1" {
			t.Fatalf("first VM answered %s, want 10.0.0.1", got)
		}
	}
	// One dial: the repeats came from that exit's own cache.
	if hitsA.Load() != 1 {
		t.Fatalf("first exit dialled %d times, want 1", hitsA.Load())
	}

	// The same question from the other VM must not be served the first VM's
	// cached answer: one cache for the helper would return 10.0.0.1 here, an
	// address only the first VM's exit can reach, and would disclose which
	// names that VM looked up.
	reply, err := resolveFrom(t, srv, query, "100.64.0.11:5300")
	if err != nil {
		t.Fatal(err)
	}
	if got := answerIP(t, reply); got != "10.0.0.2" {
		t.Fatalf("second VM answered %s, want 10.0.0.2", got)
	}
	if hitsB.Load() != 1 {
		t.Fatalf("second exit dialled %d times, want 1", hitsB.Load())
	}
	if hitsDefault.Load() != 0 {
		t.Fatalf("configured ProxyURL resolved %d queries while routes are set", hitsDefault.Load())
	}
}

func TestResolveDNSRefusesWithoutARoutableSource(t *testing.T) {
	var hitsDefault, hitsA, hitsB atomic.Int32
	srv := sharedDNSHelper(t, &hitsDefault, &hitsA, &hitsB)
	query := cacheQuery(t, 2, "example.com.", dnsmessage.TypeA)

	// Fail-closed: an answer from the default exit would be addresses the VM
	// cannot reach, and would disclose what another VM's exit resolves.
	for _, src := range []string{"100.64.0.99:5300", "pipe"} {
		if _, err := resolveFrom(t, srv, query, src); err == nil {
			t.Fatalf("source %s was resolved", src)
		}
	}
	if _, err := srv.ResolveDNSFrom(context.Background(), query, nil); err == nil {
		t.Fatal("a query with no source address was resolved")
	}
	// ResolveDNS has no source to route on, so on a shared helper it is a
	// bypass rather than a convenience.
	_, err := srv.ResolveDNS(context.Background(), query)
	if err == nil {
		t.Fatal("ResolveDNS answered while routes are configured")
	}
	if !strings.Contains(err.Error(), "routes are configured") {
		t.Fatalf("error %q does not explain why", err)
	}
	if hitsDefault.Load() != 0 || hitsA.Load() != 0 || hitsB.Load() != 0 {
		t.Fatalf("refused queries still resolved: default=%d a=%d b=%d", hitsDefault.Load(), hitsA.Load(), hitsB.Load())
	}
}

func TestResolveDNSWithoutRoutesUsesTheSingleExit(t *testing.T) {
	var hits atomic.Int32
	single := socksTo(t, dnsOverTCP(t, "10.0.0.9").Addr().String(), &hits)
	srv, err := New(Config{ListenTCP: "127.0.0.1:0", DNSUpstream: "192.0.2.53:53", ProxyURL: single})
	if err != nil {
		t.Fatal(err)
	}
	// A per-VM helper reads no source address, so one it could not parse must
	// still be answered.
	reply, err := resolveFrom(t, srv, cacheQuery(t, 5, "example.com.", dnsmessage.TypeA), "pipe")
	if err != nil {
		t.Fatal(err)
	}
	if got := answerIP(t, reply); got != "10.0.0.9" {
		t.Fatalf("answered %s, want 10.0.0.9", got)
	}

	// Rollback is a reload that drops the table: every source is served again.
	routed := Config{
		ListenTCP:   "127.0.0.1:0",
		DNSUpstream: "192.0.2.53:53",
		ProxyURL:    single,
		Routes:      []Route{{VMIP: "100.64.0.10", ProxyURL: socksTo(t, dnsOverTCP(t, "10.0.0.1").Addr().String(), nil)}},
	}
	if err := srv.Reload(routed); err != nil {
		t.Fatal(err)
	}
	query := cacheQuery(t, 6, "rollback.example.com.", dnsmessage.TypeA)
	if _, err := resolveFrom(t, srv, query, "100.64.0.99:5300"); err == nil {
		t.Fatal("unrouted source resolved before rollback")
	}
	if err := srv.Reload(Config{ListenTCP: "127.0.0.1:0", DNSUpstream: "192.0.2.53:53", ProxyURL: single}); err != nil {
		t.Fatal(err)
	}
	reply, err = resolveFrom(t, srv, query, "100.64.0.99:5300")
	if err != nil {
		t.Fatal(err)
	}
	if got := answerIP(t, reply); got != "10.0.0.9" {
		t.Fatalf("after rollback answered %s, want 10.0.0.9", got)
	}
}

func TestReloadKeepsTheResolverEachUnchangedExitSettledOn(t *testing.T) {
	cfg := Config{
		ListenTCP:   "127.0.0.1:0",
		DNSUpstream: "192.0.2.53:53,192.0.2.54:53",
		ProxyURL:    "socks5h://127.0.0.1:1",
		Routes: []Route{
			{VMIP: "100.64.0.10", ProxyURL: "socks5h://127.0.0.1:2"},
			{VMIP: "100.64.0.11", ProxyURL: "socks5h://127.0.0.1:3"},
		},
	}
	srv, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range srv.rt().routes {
		e.preferred.Store(1)
	}
	srv.rt().def.preferred.Store(1)

	// One route's proxy changes. Every exit re-probing on any reload would turn
	// one VM's change into a resolution stall for all of them.
	next := cfg
	next.Routes = []Route{
		{VMIP: "100.64.0.10", ProxyURL: "socks5h://127.0.0.1:2"},
		{VMIP: "100.64.0.11", ProxyURL: "socks5h://127.0.0.1:4"},
	}
	if err := srv.Reload(next); err != nil {
		t.Fatal(err)
	}
	rt := srv.rt()
	kept := rt.routes[mustAddr(t, "100.64.0.10")]
	if kept == nil || kept.preferred.Load() != 1 {
		t.Fatalf("unchanged route lost its preferred upstream: %v", kept)
	}
	changed := rt.routes[mustAddr(t, "100.64.0.11")]
	if changed == nil || changed.preferred.Load() != 0 {
		t.Fatalf("changed route kept a preference from the old exit: %v", changed)
	}
	if rt.def.preferred.Load() != 1 {
		t.Fatal("unchanged default exit lost its preferred upstream")
	}
}

func mustAddr(t *testing.T, s string) netip.Addr {
	t.Helper()
	addr, err := netip.ParseAddr(s)
	if err != nil {
		t.Fatal(err)
	}
	return addr
}

func TestServeDNSRoutesByTheQuerySourceAddress(t *testing.T) {
	// A loopback query's source is 127.0.0.1, so routing it to its own exit
	// proves the listeners pass the source through: resolving centrally would
	// answer SERVFAIL here, not 10.0.0.1.
	var hitsDefault, hitsLocal atomic.Int32
	srv, err := New(Config{
		ListenTCP:   "127.0.0.1:0",
		DNSUpstream: "192.0.2.53:53",
		ProxyURL:    socksTo(t, dnsOverTCP(t, "10.0.0.9").Addr().String(), &hitsDefault),
		Routes:      []Route{{VMIP: "127.0.0.1", ProxyURL: socksTo(t, dnsOverTCP(t, "10.0.0.1").Addr().String(), &hitsLocal)}},
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	udp, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer udp.Close()
	go srv.serveDNS(ctx, udp)
	client, err := net.Dial("udp", udp.LocalAddr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	_ = client.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err := client.Write(cacheQuery(t, 11, "udp.example.com.", dnsmessage.TypeA)); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, dnsMaxUDPSize)
	n, err := client.Read(buf)
	if err != nil {
		t.Fatalf("no UDP reply: %v", err)
	}
	if got := answerIP(t, buf[:n]); got != "10.0.0.1" {
		t.Fatalf("UDP answered %s, want 10.0.0.1", got)
	}

	tcpLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer tcpLn.Close()
	go srv.serveDNSTCP(ctx, tcpLn)
	conn, err := net.Dial("tcp", tcpLn.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	// A different name, so this cannot be answered from the UDP query's cache.
	query := cacheQuery(t, 12, "tcp.example.com.", dnsmessage.TypeA)
	frame := make([]byte, 2+len(query))
	binary.BigEndian.PutUint16(frame[:2], uint16(len(query)))
	copy(frame[2:], query)
	if _, err := conn.Write(frame); err != nil {
		t.Fatal(err)
	}
	var hdr [2]byte
	if _, err := io.ReadFull(conn, hdr[:]); err != nil {
		t.Fatalf("no DNS/TCP reply: %v", err)
	}
	reply := make([]byte, binary.BigEndian.Uint16(hdr[:]))
	if _, err := io.ReadFull(conn, reply); err != nil {
		t.Fatal(err)
	}
	if got := answerIP(t, reply); got != "10.0.0.1" {
		t.Fatalf("DNS/TCP answered %s, want 10.0.0.1", got)
	}
	if hitsDefault.Load() != 0 {
		t.Fatalf("configured ProxyURL served %d queries through the listeners", hitsDefault.Load())
	}
}

func TestServeDNSServFailsAnUnroutedSource(t *testing.T) {
	var hitsDefault atomic.Int32
	srv, err := New(Config{
		ListenTCP:   "127.0.0.1:0",
		DNSUpstream: "192.0.2.53:53",
		ProxyURL:    socksTo(t, dnsOverTCP(t, "10.0.0.9").Addr().String(), &hitsDefault),
		// No route covers loopback, so the query below has no exit.
		Routes: []Route{{VMIP: "100.64.0.10", ProxyURL: socksTo(t, dnsOverTCP(t, "10.0.0.1").Addr().String(), nil)}},
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	udp, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer udp.Close()
	go srv.serveDNS(ctx, udp)
	client, err := net.Dial("udp", udp.LocalAddr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	_ = client.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err := client.Write(cacheQuery(t, 13, "example.com.", dnsmessage.TypeA)); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, dnsMaxUDPSize)
	n, err := client.Read(buf)
	if err != nil {
		t.Fatalf("expected SERVFAIL, got read error: %v", err)
	}
	var msg dnsmessage.Message
	if err := msg.Unpack(buf[:n]); err != nil {
		t.Fatal(err)
	}
	// SERVFAIL rather than an address: the refused source learns its resolver
	// failed, and carries away nothing about another VM's exit.
	if msg.RCode != dnsmessage.RCodeServerFailure || msg.ID != 13 {
		t.Fatalf("got rcode %v id %d, want SERVFAIL id 13", msg.RCode, msg.ID)
	}
	if len(msg.Answers) != 0 {
		t.Fatalf("SERVFAIL carried %d answers", len(msg.Answers))
	}
	if hitsDefault.Load() != 0 {
		t.Fatalf("configured ProxyURL resolved %d queries for an unrouted source", hitsDefault.Load())
	}
}

func TestResolveDNSFromConcurrentlyKeepsAnswersOnTheirOwnExit(t *testing.T) {
	const vms = 6
	const each = 4
	var hitsDefault atomic.Int32
	routes := make([]Route, vms)
	want := make([]string, vms)
	for i := range routes {
		want[i] = fmt.Sprintf("10.0.1.%d", i+1)
		routes[i] = Route{
			VMIP:     fmt.Sprintf("100.64.0.%d", 10+i),
			ProxyURL: socksTo(t, dnsOverTCP(t, want[i]).Addr().String(), nil),
		}
	}
	srv, err := New(Config{
		ListenTCP:   "127.0.0.1:0",
		DNSUpstream: "192.0.2.53:53",
		ProxyURL:    socksTo(t, dnsOverTCP(t, "10.0.0.9").Addr().String(), &hitsDefault),
		Routes:      routes,
	})
	if err != nil {
		t.Fatal(err)
	}

	type result struct {
		vm  int
		ip  string
		err error
	}
	results := make(chan result, vms*each)
	for i := range vms {
		for j := range each {
			go func(i, j int) {
				query := cacheQuery(t, uint16(100+j), "example.com.", dnsmessage.TypeA)
				reply, rErr := resolveFrom(t, srv, query, fmt.Sprintf("100.64.0.%d:%d", 10+i, 5300+j))
				if rErr != nil {
					results <- result{vm: i, err: rErr}
					return
				}
				results <- result{vm: i, ip: answerIP(t, reply)}
			}(i, j)
		}
	}
	for range vms * each {
		got := <-results
		if got.err != nil {
			t.Errorf("vm %d: %v", got.vm, got.err)
			continue
		}
		if got.ip != want[got.vm] {
			t.Errorf("vm %d answered %s, want %s", got.vm, got.ip, want[got.vm])
		}
	}
	if hitsDefault.Load() != 0 {
		t.Errorf("configured ProxyURL resolved %d queries under load", hitsDefault.Load())
	}
}
