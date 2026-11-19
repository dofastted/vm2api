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

// srcConn fixes the peer address the helper sees. On a shared bridge that
// address is the VM's own IP and it is the only thing that selects an upstream,
// so every routing test has to be able to state it.
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

// clientFrom returns the test's end of a connection plus the end ForwardTCP
// serves, which reports src as its peer. A src of "" leaves net.Pipe's own
// unparsable "pipe" address in place.
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
// A helper that forwards an unrouted conn instead of refusing it would sit in a
// splice until IdleClose, so without a deadline here a wrong decision hangs the
// test for seven minutes instead of failing it.
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

func TestForwardTCPRoutesEachSourceToItsOwnUpstream(t *testing.T) {
	echo := routeEcho(t)
	var hitsDefault, hitsA, hitsB atomic.Int32
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
	} {
		client, served := clientFrom(t, tc.src)
		go func() { _ = srv.ForwardTCP(ctx, served, echo.Addr().String()) }()
		routeRoundTrip(t, client, tc.msg)
	}

	if hitsA.Load() != 1 || hitsB.Load() != 1 {
		t.Fatalf("per-route hits a=%d b=%d, want 1 each", hitsA.Load(), hitsB.Load())
	}
	// ProxyURL stays unused while routes are configured: a shared helper that
	// quietly falls back to it sends one VM's traffic out of another's exit.
	if hitsDefault.Load() != 0 {
		t.Fatalf("configured ProxyURL took %d conns while routes are set", hitsDefault.Load())
	}
}

func TestForwardTCPRefusesASourceWithNoRoute(t *testing.T) {
	echo := routeEcho(t)
	var hitsDefault, hitsA atomic.Int32
	srv, err := New(Config{
		ListenTCP: "127.0.0.1:0",
		ProxyURL:  countingSOCKS(t, &hitsDefault),
		Routes:    []Route{{VMIP: "100.64.0.10", ProxyURL: countingSOCKS(t, &hitsA)}},
	})
	if err != nil {
		t.Fatal(err)
	}
	_, served := clientFrom(t, "100.64.0.99:51000")
	err = refusal(t, srv, served, echo.Addr().String())
	var se *spliceError
	if !errors.As(err, &se) || se.class != classNoRoute {
		t.Fatalf("got %v, want a %s spliceError", err, classNoRoute)
	}
	if !strings.Contains(err.Error(), "100.64.0.99") {
		t.Fatalf("error %q does not name the refused source", err)
	}
	// Fail-closed: no upstream at all saw the connection.
	if hitsDefault.Load() != 0 || hitsA.Load() != 0 {
		t.Fatalf("refused conn still reached an upstream: default=%d a=%d", hitsDefault.Load(), hitsA.Load())
	}
}

func TestForwardTCPRefusesAnUnparsableSourceWhenRoutesAreConfigured(t *testing.T) {
	echo := routeEcho(t)
	var hitsDefault, hitsA atomic.Int32
	srv, err := New(Config{
		ListenTCP: "127.0.0.1:0",
		ProxyURL:  countingSOCKS(t, &hitsDefault),
		Routes:    []Route{{VMIP: "100.64.0.10", ProxyURL: countingSOCKS(t, &hitsA)}},
	})
	if err != nil {
		t.Fatal(err)
	}
	// A peer address the helper cannot read is not a reason to pick an exit for
	// it: unreadable has to fail the same way unknown does.
	_, served := clientFrom(t, "")
	err = refusal(t, srv, served, echo.Addr().String())
	var se *spliceError
	if !errors.As(err, &se) || se.class != classNoRoute {
		t.Fatalf("got %v, want a %s spliceError", err, classNoRoute)
	}
	if hitsDefault.Load() != 0 || hitsA.Load() != 0 {
		t.Fatalf("refused conn still reached an upstream: default=%d a=%d", hitsDefault.Load(), hitsA.Load())
	}
}

func TestForwardTCPMatchesAnIPv4MappedSource(t *testing.T) {
	echo := routeEcho(t)
	var hitsDefault, hitsA atomic.Int32
	srv, err := New(Config{
		ListenTCP: "127.0.0.1:0",
		ProxyURL:  countingSOCKS(t, &hitsDefault),
		Routes:    []Route{{VMIP: "100.64.0.10", ProxyURL: countingSOCKS(t, &hitsA)}},
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	// A helper on a dual-stack socket sees the same VM as ::ffff:100.64.0.10.
	client, served := clientFrom(t, "[::ffff:100.64.0.10]:51000")
	go func() { _ = srv.ForwardTCP(ctx, served, echo.Addr().String()) }()
	routeRoundTrip(t, client, "mapped")
	if hitsA.Load() != 1 || hitsDefault.Load() != 0 {
		t.Fatalf("mapped source hits a=%d default=%d, want 1 and 0", hitsA.Load(), hitsDefault.Load())
	}
}

func TestForwardTCPWithoutRoutesKeepsTheSingleExit(t *testing.T) {
	echo := routeEcho(t)
	var hitsDefault atomic.Int32
	srv, err := New(Config{ListenTCP: "127.0.0.1:0", ProxyURL: countingSOCKS(t, &hitsDefault)})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	// A per-VM helper has no route table and its peer address is never read, so
	// an address that routing could not parse must still be forwarded.
	client, served := clientFrom(t, "")
	go func() { _ = srv.ForwardTCP(ctx, served, echo.Addr().String()) }()
	routeRoundTrip(t, client, "single-exit")
	if hitsDefault.Load() != 1 {
		t.Fatalf("single-exit hits=%d, want 1", hitsDefault.Load())
	}
}

func TestNewRejectsAnInvalidRouteTable(t *testing.T) {
	// Each of these would otherwise become a VM refused at dial time by a
	// reload that reported success.
	for _, tc := range []struct {
		name   string
		routes []Route
		want   string
	}{
		{
			name:   "duplicate vm ip",
			routes: []Route{{VMIP: "100.64.0.10", ProxyURL: "socks5h://127.0.0.1:1"}, {VMIP: "100.64.0.10", ProxyURL: "socks5h://127.0.0.1:2"}},
			want:   "duplicate",
		},
		{
			name:   "duplicate across mapped form",
			routes: []Route{{VMIP: "100.64.0.10", ProxyURL: "socks5h://127.0.0.1:1"}, {VMIP: "::ffff:100.64.0.10", ProxyURL: "socks5h://127.0.0.1:2"}},
			want:   "duplicate",
		},
		{
			name:   "unparsable vm ip",
			routes: []Route{{VMIP: "100.64.0.10/28", ProxyURL: "socks5h://127.0.0.1:1"}},
			want:   "unparsable vm_ip",
		},
		{
			name:   "empty vm ip",
			routes: []Route{{VMIP: "", ProxyURL: "socks5h://127.0.0.1:1"}},
			want:   "unparsable vm_ip",
		},
		{
			name:   "missing proxy url",
			routes: []Route{{VMIP: "100.64.0.10", ProxyURL: "   "}},
			want:   "proxy_url is required",
		},
		{
			name:   "unsupported proxy scheme",
			routes: []Route{{VMIP: "100.64.0.10", ProxyURL: "ftp://127.0.0.1:1"}},
			want:   "100.64.0.10",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := New(Config{ListenTCP: "127.0.0.1:0", ProxyURL: "socks5h://127.0.0.1:1", Routes: tc.routes})
			if err == nil {
				t.Fatalf("invalid route table accepted: %+v", tc.routes)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error %q does not mention %q", err, tc.want)
			}
		})
	}
}

func TestReloadSwapsRoutesAndKeepsRunningOnABadTable(t *testing.T) {
	echo := routeEcho(t)
	var hitsSingle, hitsA, hitsB atomic.Int32
	single := countingSOCKS(t, &hitsSingle)
	srv, err := New(Config{ListenTCP: "127.0.0.1:0", ProxyURL: single})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Single exit -> shared: the same helper starts selecting by source.
	shared := Config{
		ListenTCP: "127.0.0.1:0",
		ProxyURL:  single,
		Routes: []Route{
			{VMIP: "100.64.0.10", ProxyURL: countingSOCKS(t, &hitsA)},
			{VMIP: "100.64.0.11", ProxyURL: countingSOCKS(t, &hitsB)},
		},
	}
	if err := srv.Reload(shared); err != nil {
		t.Fatal(err)
	}
	client, served := clientFrom(t, "100.64.0.11:51000")
	go func() { _ = srv.ForwardTCP(ctx, served, echo.Addr().String()) }()
	routeRoundTrip(t, client, "after-reload")
	if hitsB.Load() != 1 || hitsSingle.Load() != 0 {
		t.Fatalf("after reload b=%d single=%d, want 1 and 0", hitsB.Load(), hitsSingle.Load())
	}

	before := srv.rt()
	bad := shared
	bad.Routes = append(append([]Route(nil), shared.Routes...), Route{VMIP: "100.64.0.11", ProxyURL: "socks5h://127.0.0.1:9"})
	if err := srv.Reload(bad); err == nil {
		t.Fatal("reload accepted a duplicate route")
	}
	if srv.rt() != before {
		t.Fatal("a rejected reload replaced the running routes")
	}

	// Shared -> single exit is the rollback path: routes gone, ProxyURL serves
	// every source again.
	if err := srv.Reload(Config{ListenTCP: "127.0.0.1:0", ProxyURL: single}); err != nil {
		t.Fatal(err)
	}
	rollback, servedBack := clientFrom(t, "100.64.0.99:51000")
	go func() { _ = srv.ForwardTCP(ctx, servedBack, echo.Addr().String()) }()
	routeRoundTrip(t, rollback, "rolled-back")
	if hitsSingle.Load() != 1 {
		t.Fatalf("after rollback single=%d, want 1", hitsSingle.Load())
	}
}

func TestForwardTCPRoutesConcurrentlyAcrossSources(t *testing.T) {
	echo := routeEcho(t)
	const vms = 8
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
			_, served := clientFrom(t, fmt.Sprintf("100.64.1.%d:%d", j, 51000))
			fErr := refusal(t, srv, served, echo.Addr().String())
			var se *spliceError
			if !errors.As(fErr, &se) || se.class != classNoRoute {
				errCh <- fmt.Errorf("unrouted source under load: got %v, want a %s spliceError", fErr, classNoRoute)
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
