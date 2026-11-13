package proxy

import (
	"bufio"
	"context"
	"encoding/base64"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"
)

// fakeHTTPProxy answers one CONNECT with reply and then echoes tunnelled bytes.
func fakeHTTPProxy(t *testing.T, reply string) (string, <-chan *http.Request) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	seen := make(chan *http.Request, 1)
	go func() {
		conn, acceptErr := listener.Accept()
		if acceptErr != nil {
			return
		}
		defer conn.Close()
		req, readErr := http.ReadRequest(bufio.NewReader(conn))
		if readErr != nil {
			return
		}
		seen <- req
		_, _ = io.WriteString(conn, reply)
		_, _ = io.Copy(conn, conn)
	}()
	return listener.Addr().String(), seen
}

func TestHTTPDialerTunnelsWithBasicAuth(t *testing.T) {
	// The proxy pushes "early" right after the head; it must reach the caller.
	addr, seen := fakeHTTPProxy(t, "HTTP/1.1 200 Connection established\r\nX-Hop: 1\r\n\r\nearly")
	dialer, err := New("http://us%3Aer:p%40ss@"+addr, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if !dialer.HTTP {
		t.Fatal("http:// URL must select the CONNECT dialer")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	conn, err := dialer.DialContext(ctx, "tcp", "api.anthropic.com:443")
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	req := <-seen
	if req.Method != http.MethodConnect || req.Host != "api.anthropic.com:443" {
		t.Fatalf("got %s %s", req.Method, req.Host)
	}
	want := "Basic " + base64.StdEncoding.EncodeToString([]byte("us:er:p@ss"))
	if got := req.Header.Get("Proxy-Authorization"); got != want {
		t.Fatalf("Proxy-Authorization = %q, want %q", got, want)
	}
	early := make([]byte, 5)
	if _, err = io.ReadFull(conn, early); err != nil || string(early) != "early" {
		t.Fatalf("tunnel lost bytes after response head: %q %v", early, err)
	}
	if _, err = conn.Write([]byte("ping")); err != nil {
		t.Fatal(err)
	}
	echo := make([]byte, 4)
	if _, err = io.ReadFull(conn, echo); err != nil || string(echo) != "ping" {
		t.Fatalf("echo = %q %v", echo, err)
	}
}

func TestHTTPDialerReportsRejections(t *testing.T) {
	cases := map[string]string{
		"HTTP/1.1 407 Proxy Authentication Required\r\n\r\n": "authentication failed",
		"HTTP/1.1 403 Forbidden\r\n\r\n":                     "HTTP CONNECT failed: HTTP/1.1 403",
		"\x05\x00":                                           "not an HTTP proxy",
	}
	for reply, want := range cases {
		addr, _ := fakeHTTPProxy(t, reply)
		dialer, err := New("http://"+addr, time.Second)
		if err != nil {
			t.Fatal(err)
		}
		_, err = dialer.DialContext(context.Background(), "tcp", "example.com:443")
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Fatalf("reply %q: err = %v, want %q", reply, err, want)
		}
	}
}

func TestNewHTTPDefaultsPortAndRejectsHTTPS(t *testing.T) {
	dialer, err := New("http://proxy.example", time.Second)
	if err != nil || dialer.Address != "proxy.example:80" {
		t.Fatalf("got %+v %v", dialer, err)
	}
	if _, err = New("https://proxy.example:443", time.Second); err == nil {
		t.Fatal("https:// proxy must be rejected")
	}
	socks, err := New("socks5h://proxy.example:1080", time.Second)
	if err != nil || socks.HTTP {
		t.Fatalf("socks5h must stay SOCKS: %+v %v", socks, err)
	}
}
