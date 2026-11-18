package egress

import (
	"context"
	"io"
	"net"
	"net/url"
	"sync/atomic"
	"testing"
	"time"
)

func echoRoundTrip(t *testing.T, c net.Conn, msg string) {
	t.Helper()
	if _, err := c.Write([]byte(msg)); err != nil {
		t.Fatal(err)
	}
	got := make([]byte, len(msg))
	_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, err := io.ReadFull(c, got); err != nil {
		t.Fatal(err)
	}
	if string(got) != msg {
		t.Fatalf("got %q want %q", got, msg)
	}
}

func countingSOCKS(t *testing.T, hits *atomic.Int32) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			// Hand one accepted conn to the single-accept test SOCKS server.
			one := &oneConnListener{c: c, addr: ln.Addr()}
			go serveTestSOCKSWithTarget(t, one, func(_ byte, host string, port uint16) (string, error) {
				hits.Add(1)
				return net.JoinHostPort(host, formatPort(port)), nil
			})
		}
	}()
	return (&url.URL{Scheme: "socks5h", Host: ln.Addr().String()}).String()
}

func TestReloadSwapsProxyForNewConnsAndKeepsOld(t *testing.T) {
	echo, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echo.Close()
	go func() {
		for {
			c, accErr := echo.Accept()
			if accErr != nil {
				return
			}
			go func() { defer c.Close(); _, _ = io.Copy(c, c) }()
		}
	}()
	var hitsA, hitsB atomic.Int32
	proxyA := countingSOCKS(t, &hitsA)
	proxyB := countingSOCKS(t, &hitsB)

	srv, err := New(Config{ProxyURL: proxyA, ListenTCP: "127.0.0.1:0"})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	old, peer := net.Pipe()
	defer old.Close()
	go func() { _ = srv.ForwardTCP(ctx, peer, echo.Addr().String()) }()
	echoRoundTrip(t, old, "via-a")

	if err := srv.Reload(Config{ProxyURL: proxyB, ListenTCP: "127.0.0.1:0", ProxyID: "b"}); err != nil {
		t.Fatal(err)
	}
	fresh, peer2 := net.Pipe()
	defer fresh.Close()
	go func() { _ = srv.ForwardTCP(ctx, peer2, echo.Addr().String()) }()
	echoRoundTrip(t, fresh, "via-b")
	if hitsA.Load() != 1 || hitsB.Load() != 1 {
		t.Fatalf("hits a=%d b=%d", hitsA.Load(), hitsB.Load())
	}
	// The splice dialed before the reload is still open on proxy A.
	echoRoundTrip(t, old, "still-a")
}

func TestReloadRejectsBadConfigAndListenChange(t *testing.T) {
	srv, err := New(Config{ProxyURL: "socks5h://127.0.0.1:1", ListenTCP: "127.0.0.1:0", ProxyID: "a"})
	if err != nil {
		t.Fatal(err)
	}
	before := srv.rt()
	if err := srv.Reload(Config{ProxyURL: "ftp://bad", ListenTCP: "127.0.0.1:0"}); err == nil {
		t.Fatal("bad proxy url accepted")
	}
	if err := srv.Reload(Config{ProxyURL: "socks5h://127.0.0.1:2", ListenTCP: "127.0.0.1:9"}); err == nil {
		t.Fatal("listen change accepted")
	}
	if srv.rt() != before {
		t.Fatal("runtime replaced by a rejected reload")
	}
}

type oneConnListener struct {
	c    net.Conn
	addr net.Addr
	used atomic.Bool
}

func (l *oneConnListener) Accept() (net.Conn, error) {
	if l.used.Swap(true) {
		return nil, net.ErrClosed
	}
	return l.c, nil
}
func (l *oneConnListener) Close() error   { return nil }
func (l *oneConnListener) Addr() net.Addr { return l.addr }
