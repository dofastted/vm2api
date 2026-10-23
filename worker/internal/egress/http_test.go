package egress

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestHTTPProxyForwardPreservesHalfClose(t *testing.T) {
	targets := make(chan string, 1)
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		targets <- r.Host
		conn, rw, err := w.(http.Hijacker).Hijack()
		if err != nil {
			return
		}
		defer conn.Close()
		_, _ = rw.WriteString("HTTP/1.1 200 OK\r\n\r\n")
		_ = rw.Flush()
		// Reply only after the client has sent EOF, exercising half-close through
		// the CONNECT wrapper rather than dropping the response on request EOF.
		body, _ := io.ReadAll(rw)
		_, _ = conn.Write(append([]byte("reply:"), body...))
	}))
	defer proxy.Close()
	srv, err := New(Config{ProxyURL: proxy.URL, ListenTCP: "127.0.0.1:0", DomainForward: true})
	if err != nil {
		t.Fatal(err)
	}
	srv.domains.observe(dnsA(t, "api.example.test.", 60, net.IPv4(192, 0, 2, 123)), time.Now())
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	result := make(chan error, 1)
	go func() {
		peer, err := listener.Accept()
		if err != nil {
			result <- err
			return
		}
		defer peer.Close()
		result <- srv.ForwardTCP(context.Background(), peer, "192.0.2.123:443")
	}()
	conn, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
	_, _ = conn.Write([]byte("request"))
	_ = conn.(*net.TCPConn).CloseWrite()
	body, err := io.ReadAll(conn)
	if err != nil || string(body) != "reply:request" {
		t.Fatalf("reply %q: %v", body, err)
	}
	if target := <-targets; target != "api.example.test:443" {
		t.Fatalf("CONNECT target %q", target)
	}
	if err := <-result; err != nil {
		t.Fatal(err)
	}
}
