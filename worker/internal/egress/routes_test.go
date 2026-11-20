package egress

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// Per-source routing and fail-closed refusal were verified on a real cluster
// node (aws-jp, 2026-11-20): two VMs on one shared bridge reached their own
// SOCKS exits, and an unrouted source was refused with `no route for source`.
// What is left here is what that node could not show — the shapes of a bad
// route table, a dual-stack peer address, concurrency, and reload.

// srcConn fixes the peer address the helper sees. On a shared bridge that is
// the VM's own address and the only thing that selects an upstream.
type srcConn struct {
	net.Conn
	remote net.Addr
}

func (c *srcConn) RemoteAddr() net.Addr { return c.remote }

type fixedAddr string

func (a fixedAddr) Network() string { return "tcp" }
func (a fixedAddr) String() string  { return string(a) }

func routeEcho(t *testing.T) net.Listener {
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
			go func() { defer c.Close(); _, _ = io.Copy(c, c) }()
		}
	}()
	return ln
}

// clientFrom returns the test's end plus the end ForwardTCP serves, reporting
// src as its peer. A src of "" leaves net.Pipe's unparsable "pipe" address.
func clientFrom(t *testing.T, src string) (net.Conn, net.Conn) {
	t.Helper()
	mine, theirs := net.Pipe()
	t.Cleanup(func() { _ = mine.Close() })
	if src == "" {
		return mine, theirs
	}
	return mine, &srcConn{Conn: theirs, remote: fixedAddr(src)}
}

// routeRoundTrip echoes through the helper under a deadline. net.Pipe has no
// buffer, so a conn the router wrongly refuses leaves nobody reading and the
// write blocks forever; echoRoundTrip only guards the read side.
func routeRoundTrip(t *testing.T, client net.Conn, msg string) {
	t.Helper()
	_ = client.SetDeadline(time.Now().Add(3 * time.Second))
	echoRoundTrip(t, client, msg)
}

// refusal returns how ForwardTCP ended, insisting the answer arrives promptly.
// A helper that forwards an unrouted conn instead of refusing it would sit in
// a splice until IdleClose, hanging the test for seven minutes rather than
// failing it.
func refusal(t *testing.T, srv *Server, served net.Conn, dest string) error {
	t.Helper()
	done := make(chan error, 1)
	go func() { done <- srv.ForwardTCP(context.Background(), served, dest) }()
	select {
	case err := <-done:
		if err == nil {
			return errors.New("ForwardTCP forwarded the conn instead of refusing it")
		}
		return err
	case <-time.After(3 * time.Second):
		return errors.New("ForwardTCP neither refused nor returned: it is splicing an unrouted conn")
	}
}

func assertNoRoute(t *testing.T, err error, label string) {
	t.Helper()
	var se *spliceError
	if !errors.As(err, &se) || se.class != classNoRoute {
		t.Fatalf("%s: got %v, want a %s spliceError", label, err, classNoRoute)
	}
}

func TestForwardTCPSelectsTheExitForTheSourceAddress(t *testing.T) {
	echo := routeEcho(t)
	var hitsDefault, hitsA, hitsB atomic.Int32
	// proxy_url is set here only so the test can prove it stays unused; a real
	// shared helper leaves it empty (see TestSharedHelperNeedsNoDefaultExit).
	srv, err := New(Config{
		ListenTCP: "127.0.0.1:0",
		ProxyURL:  countingSOCKS(t, &hitsDefault),
		Routes: []Route{
			{VMIP: "100.64.0.10", ProxyURL: countingSOCKS(t, &hitsA)},
			{VMIP: "100.64.0.11", ProxyURL: countingSOCKS(t, &hitsB)},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	for _, tc := range []struct{ src, msg string }{
		{"100.64.0.10:51000", "from-a"},
		{"100.64.0.11:51000", "from-b"},
		// A helper on a dual-stack socket sees the same VM as ::ffff:a.b.c.d,
		// while the route table is keyed on the plain form.
		{"[::ffff:100.64.0.10]:51001", "mapped"},
	} {
		client, served := clientFrom(t, tc.src)
		go func() { _ = srv.ForwardTCP(ctx, served, echo.Addr().String()) }()
		routeRoundTrip(t, client, tc.msg)
	}
	if hitsA.Load() != 2 || hitsB.Load() != 1 {
		t.Fatalf("per-route hits a=%d b=%d, want 2 and 1", hitsA.Load(), hitsB.Load())
	}

	// An address not in the table, and one that cannot be read, are refused
	// the same way. Falling back to ProxyURL would send an unauthorised VM's
	// traffic out through someone else's exit.
	for _, src := range []string{"100.64.0.99:51000", ""} {
		_, served := clientFrom(t, src)
		assertNoRoute(t, refusal(t, srv, served, echo.Addr().String()), fmt.Sprintf("source %q", src))
	}
	if hitsDefault.Load() != 0 {
		t.Fatalf("configured ProxyURL took %d conns while routes are set", hitsDefault.Load())
	}
}

func TestForwardTCPWithoutRoutesKeepsTheSingleExit(t *testing.T) {
	echo := routeEcho(t)
	var hits atomic.Int32
	srv, err := New(Config{ListenTCP: "127.0.0.1:0", ProxyURL: countingSOCKS(t, &hits)})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	// A per-VM helper reads no source address, so one it could not parse must
	// still be forwarded.
	client, served := clientFrom(t, "")
	go func() { _ = srv.ForwardTCP(ctx, served, echo.Addr().String()) }()
	routeRoundTrip(t, client, "single-exit")
	if hits.Load() != 1 {
		t.Fatalf("single-exit hits=%d, want 1", hits.Load())
	}
}

func TestSharedHelperNeedsNoDefaultExit(t *testing.T) {
	echo := routeEcho(t)
	var hitsA, hitsB atomic.Int32
	// No proxy_url at all: there is no default exit to reach even by mistake.
	// A placeholder would read as a sanctioned default in the config and logs.
	// Verified on a real node, where an empty one started cleanly on the new
	// binary and was refused by the old one with `unsupported proxy scheme ""`.
	srv, err := New(Config{
		ListenTCP: "127.0.0.1:0",
		Routes: []Route{
			{VMIP: "100.64.0.10", ProxyURL: countingSOCKS(t, &hitsA)},
			{VMIP: "100.64.0.11", ProxyURL: countingSOCKS(t, &hitsB)},
		},
	})
	if err != nil {
		t.Fatalf("shared helper without proxy_url rejected: %v", err)
	}
	if srv.rt().def != nil {
		t.Fatal("a helper configured without proxy_url still built a default exit")
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	client, served := clientFrom(t, "100.64.0.11:51000")
	go func() { _ = srv.ForwardTCP(ctx, served, echo.Addr().String()) }()
	routeRoundTrip(t, client, "shared-only")

	// The refusal path must not depend on a default exit being present.
	_, servedUnknown := clientFrom(t, "100.64.0.99:51000")
	assertNoRoute(t, refusal(t, srv, servedUnknown, echo.Addr().String()), "unrouted source")
	if hitsB.Load() != 1 || hitsA.Load() != 0 {
		t.Fatalf("hits a=%d b=%d, want 0 and 1", hitsA.Load(), hitsB.Load())
	}
}

func TestNewRejectsAnUnusableConfig(t *testing.T) {
	// Each of these would otherwise become a VM refused at dial time by a
	// reload that reported success.
	for _, tc := range []struct {
		name string
		cfg  Config
		want string
	}{
		{
			name: "duplicate vm ip",
			cfg:  Config{Routes: []Route{{VMIP: "100.64.0.10", ProxyURL: "socks5h://127.0.0.1:1"}, {VMIP: "100.64.0.10", ProxyURL: "socks5h://127.0.0.1:2"}}},
			want: "duplicate",
		},
		{
			name: "duplicate across the mapped form",
			cfg:  Config{Routes: []Route{{VMIP: "100.64.0.10", ProxyURL: "socks5h://127.0.0.1:1"}, {VMIP: "::ffff:100.64.0.10", ProxyURL: "socks5h://127.0.0.1:2"}}},
			want: "duplicate",
		},
		{
			name: "unparsable vm ip",
			cfg:  Config{Routes: []Route{{VMIP: "100.64.0.10/28", ProxyURL: "socks5h://127.0.0.1:1"}}},
			want: "unparsable vm_ip",
		},
		{
			name: "missing proxy url",
			cfg:  Config{Routes: []Route{{VMIP: "100.64.0.10", ProxyURL: "   "}}},
			want: "proxy_url is required",
		},
		{
			// Neither routes nor proxy_url: a helper with nowhere to send
			// anything, which has to fail at load rather than accept conns.
			name: "nothing to serve",
			cfg:  Config{},
			want: "proxy_url is required",
		},
		{
			// The observed-domain table is one per helper, so sharing it would
			// let one VM's lookups rewrite another VM's destinations.
			name: "domain forward with routes",
			cfg:  Config{ProxyURL: "socks5h://127.0.0.1:1", DomainForward: true, Routes: []Route{{VMIP: "100.64.0.10", ProxyURL: "socks5h://127.0.0.1:2"}}},
			want: "domain_forward",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cfg := tc.cfg
			cfg.ListenTCP = "127.0.0.1:0"
			_, err := New(cfg)
			if err == nil {
				t.Fatalf("accepted an unusable config: %+v", cfg)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error %q does not mention %q", err, tc.want)
			}
		})
	}
	// domain_forward alone stays valid: it is only shared mode it conflicts with.
	if _, err := New(Config{ListenTCP: "127.0.0.1:0", ProxyURL: "socks5h://127.0.0.1:1", DomainForward: true}); err != nil {
		t.Fatalf("domain_forward alone rejected: %v", err)
	}
}

func TestReloadSwitchesBetweenShapesAndKeepsEstablishedConns(t *testing.T) {
	echo := routeEcho(t)
	var hitsSingle, hitsA atomic.Int32
	single := countingSOCKS(t, &hitsSingle)
	routeA := countingSOCKS(t, &hitsA)
	srv, err := New(Config{ListenTCP: "127.0.0.1:0", ProxyURL: single})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	// Opened before the switch, and must survive it. (Verified on a real node
	// too: a VM joining by SIGHUP left an established conn intact.)
	old, oldPeer := net.Pipe()
	defer old.Close()
	go func() { _ = srv.ForwardTCP(ctx, oldPeer, echo.Addr().String()) }()
	routeRoundTrip(t, old, "before")

	// per-VM -> shared: the default exit is dropped along with proxy_url.
	shared := Config{ListenTCP: "127.0.0.1:0", Routes: []Route{{VMIP: "100.64.0.10", ProxyURL: routeA}}}
	if err := srv.Reload(shared); err != nil {
		t.Fatal(err)
	}
	if srv.rt().def != nil {
		t.Fatal("reload to shared kept a default exit")
	}
	routeRoundTrip(t, old, "still-connected")
	client, served := clientFrom(t, "100.64.0.10:51000")
	go func() { _ = srv.ForwardTCP(ctx, served, echo.Addr().String()) }()
	routeRoundTrip(t, client, "to-shared")

	// A rejected reload leaves the running table untouched.
	before := srv.rt()
	bad := shared
	bad.Routes = append(append([]Route(nil), shared.Routes...), Route{VMIP: "100.64.0.10", ProxyURL: "socks5h://127.0.0.1:9"})
	if err := srv.Reload(bad); err == nil {
		t.Fatal("reload accepted a duplicate route")
	}
	if srv.rt() != before {
		t.Fatal("a rejected reload replaced the running routes")
	}

	// shared -> per-VM is the rollback: proxy_url returns and serves everyone.
	if err := srv.Reload(Config{ListenTCP: "127.0.0.1:0", ProxyURL: single}); err != nil {
		t.Fatal(err)
	}
	back, servedBack := clientFrom(t, "100.64.0.99:51000")
	go func() { _ = srv.ForwardTCP(ctx, servedBack, echo.Addr().String()) }()
	routeRoundTrip(t, back, "rolled-back")
	if hitsA.Load() != 1 || hitsSingle.Load() != 2 {
		t.Fatalf("hits route=%d single=%d, want 1 and 2", hitsA.Load(), hitsSingle.Load())
	}
}

func TestForwardTCPRoutesConcurrentlyAcrossSources(t *testing.T) {
	echo := routeEcho(t)
	const vms = 6
	const perVM = 4
	var hitsDefault atomic.Int32
	hits := make([]*atomic.Int32, vms)
	routes := make([]Route, vms)
	for i := range routes {
		hits[i] = new(atomic.Int32)
		routes[i] = Route{VMIP: fmt.Sprintf("100.64.0.%d", 10+i), ProxyURL: countingSOCKS(t, hits[i])}
	}
	srv, err := New(Config{ListenTCP: "127.0.0.1:0", ProxyURL: countingSOCKS(t, &hitsDefault), Routes: routes})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var wg sync.WaitGroup
	errCh := make(chan error, vms*perVM+perVM)
	for i := 0; i < vms; i++ {
		for j := 0; j < perVM; j++ {
			wg.Add(1)
			go func(i, j int) {
				defer wg.Done()
				client, served := clientFrom(t, fmt.Sprintf("100.64.0.%d:%d", 10+i, 51000+j))
				go func() { _ = srv.ForwardTCP(ctx, served, echo.Addr().String()) }()
				msg := fmt.Sprintf("vm-%d-%d", i, j)
				_ = client.SetDeadline(time.Now().Add(5 * time.Second))
				if _, wErr := client.Write([]byte(msg)); wErr != nil {
					errCh <- wErr
					return
				}
				got := make([]byte, len(msg))
				if _, rErr := io.ReadFull(client, got); rErr != nil {
					errCh <- rErr
					return
				}
				if string(got) != msg {
					errCh <- fmt.Errorf("got %q want %q", got, msg)
				}
			}(i, j)
		}
	}
	// Unrouted sources race the routed ones through the same table.
	for j := 0; j < perVM; j++ {
		wg.Add(1)
		go func(j int) {
			defer wg.Done()
			_, served := clientFrom(t, fmt.Sprintf("100.64.1.%d:51000", j))
			var se *spliceError
			if fErr := refusal(t, srv, served, echo.Addr().String()); !errors.As(fErr, &se) || se.class != classNoRoute {
				errCh <- fmt.Errorf("unrouted source under load: got %v, want %s", fErr, classNoRoute)
			}
		}(j)
	}
	wg.Wait()
	close(errCh)
	for e := range errCh {
		t.Error(e)
	}
	for i := range hits {
		if got := hits[i].Load(); got != perVM {
			t.Errorf("vm %d upstream hits=%d, want %d", i, got, perVM)
		}
	}
	if hitsDefault.Load() != 0 {
		t.Errorf("configured ProxyURL took %d conns under load", hitsDefault.Load())
	}
}
