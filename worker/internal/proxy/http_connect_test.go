package proxy

import (
	"bufio"
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestHTTPConnectUsesAuthAndRemoteHost(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	seen := make(chan *http.Request, 1)
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		r, err := http.ReadRequest(bufio.NewReader(c))
		if err != nil {
			return
		}
		seen <- r
		// Send tunnel payload with headers: a buffered reader must not discard it.
		fmt.Fprint(c, "HTTP/1.1 200 OK\r\n\r\nprefetched")
		b := make([]byte, 4)
		if _, err := io.ReadFull(c, b); err == nil {
			_, _ = c.Write(b)
		}
	}()
	d, err := New("http://alice:p%40ss%3Aword@"+ln.Addr().String(), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	c, err := d.DialContext(context.Background(), "tcp", "not-in-local-dns.invalid:443")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	b := make([]byte, len("prefetched"))
	if _, err := io.ReadFull(c, b); err != nil || string(b) != "prefetched" {
		t.Fatalf("buffered tunnel data: %q %v", b, err)
	}
	_, _ = c.Write([]byte("ping"))
	b = make([]byte, 4)
	if _, err := io.ReadFull(c, b); err != nil || string(b) != "ping" {
		t.Fatalf("tunnel echo: %q %v", b, err)
	}
	r := <-seen
	if r.Method != "CONNECT" || r.Host != "not-in-local-dns.invalid:443" {
		t.Fatalf("bad CONNECT target: %s %s", r.Method, r.Host)
	}
	if r.Header.Get("Proxy-Authorization") != "Basic "+base64.StdEncoding.EncodeToString([]byte("alice:p@ss:word")) {
		t.Fatal("proxy credentials changed")
	}
}

func TestHTTPConnectRejectsResponsesAndHonorsCancellation(t *testing.T) {
	for _, response := range []string{"HTTP/1.1 407 password-must-not-leak\r\n\r\n", "HTTP/1.1 302 Found\r\nLocation: http://direct.invalid\r\n\r\n", "not HTTP\r\n\r\n", "HTTP/1.1 200 OK\r\nX-Large: " + strings.Repeat("x", 20000) + "\r\n\r\n", ""} {
		t.Run(fmt.Sprint(len(response)), func(t *testing.T) {
			ln, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			defer ln.Close()
			done := make(chan struct{})
			go func() {
				defer close(done)
				c, err := ln.Accept()
				if err != nil {
					return
				}
				defer c.Close()
				if _, err := http.ReadRequest(bufio.NewReader(c)); err != nil {
					return
				}
				if response != "" {
					_, _ = io.WriteString(c, response)
				} else {
					_ = c.SetReadDeadline(time.Now().Add(time.Second))
					_, _ = c.Read(make([]byte, 1))
				}
			}()
			d, err := New("http://"+ln.Addr().String(), time.Second)
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
			defer cancel()
			c, err := d.DialContext(ctx, "tcp", "target.invalid:443")
			if c != nil {
				c.Close()
				t.Fatal("unexpected tunnel")
			}
			if err == nil || strings.Contains(err.Error(), "password-must-not-leak") {
				t.Fatalf("unsafe/missing error: %v", err)
			}
			<-done
		})
	}
}

func TestHTTPSProxyVerifiesCertificate(t *testing.T) {
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("untrusted TLS proxy was used") }))
	server.Config.ErrorLog = nil
	server.StartTLS()
	defer server.Close()
	d, err := New(server.URL, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	c, err := d.DialContext(context.Background(), "tcp", "target.invalid:443")
	if c != nil {
		c.Close()
		t.Fatal("untrusted HTTPS proxy accepted")
	}
	if err == nil || !strings.Contains(err.Error(), "certificate") {
		t.Fatalf("expected TLS validation failure: %v", err)
	}
}

func TestHTTPProxyValidation(t *testing.T) {
	for _, raw := range []string{"ftp://host:21", "http://host:0", "http://host:65536", "http://host/path", "https://host/?a=b", "http://host/#f", "http://u%3Aname:p@host:80"} {
		if _, err := New(raw, time.Second); err == nil {
			t.Fatalf("accepted %q", raw)
		}
	}
	for _, raw := range []string{"http://host", "https://host", "socks5://host:1080"} {
		if _, err := New(raw, time.Second); err != nil {
			t.Fatalf("rejected %q: %v", raw, err)
		}
	}
	d, _ := New("http://127.0.0.1:12345", time.Second)
	for _, target := range []string{"target:443\r\nX: injected", "target/path:443", "127.0.0.1:12345"} {
		if c, err := d.DialContext(context.Background(), "tcp", target); err == nil {
			c.Close()
			t.Fatalf("accepted target %q", target)
		}
	}
}
