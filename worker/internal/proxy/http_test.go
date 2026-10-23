package proxy

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestHTTPConnectTunnel(t *testing.T) {
	for _, secure := range []bool{false, true} {
		name := "http"
		if secure {
			name = "https"
		}
		t.Run(name, func(t *testing.T) {
			requests := make(chan *http.Request, 1)
			server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests <- r
				conn, rw, err := w.(http.Hijacker).Hijack()
				if err != nil {
					return
				}
				defer conn.Close()
				// First tunnel bytes may share the same read as the CONNECT headers.
				_, _ = rw.WriteString("HTTP/1.1 200 Connection established\r\n\r\nhello")
				_ = rw.Flush()
				_, _ = io.Copy(conn, rw)
			}))
			if secure {
				server.StartTLS()
			} else {
				server.Start()
			}
			defer server.Close()
			d, err := New(strings.Replace(server.URL, "://", "://user:p%40ss@", 1), time.Second)
			if err != nil {
				t.Fatal(err)
			}
			if secure {
				roots := x509.NewCertPool()
				roots.AddCert(server.Certificate())
				d.tlsConfig = &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}
			}
			ctx, cancel := context.WithCancel(context.Background())
			conn, err := d.DialContext(ctx, "tcp", "remote.invalid:443")
			cancel() // Dial cancellation must not terminate an established tunnel.
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			_ = conn.SetDeadline(time.Now().Add(time.Second))
			initial := make([]byte, 5)
			if _, err := io.ReadFull(conn, initial); err != nil || string(initial) != "hello" {
				t.Fatalf("initial bytes %q: %v", initial, err)
			}
			_, _ = conn.Write([]byte("stream"))
			echo := make([]byte, 6)
			if _, err := io.ReadFull(conn, echo); err != nil || string(echo) != "stream" {
				t.Fatalf("echo %q: %v", echo, err)
			}
			r := <-requests
			if r.Method != "CONNECT" || r.Host != "remote.invalid:443" {
				t.Fatalf("request: %s %s", r.Method, r.Host)
			}
			if r.Header.Get("Proxy-Authorization") != "Basic "+base64.StdEncoding.EncodeToString([]byte("user:p@ss")) {
				t.Fatal("missing authentication")
			}
		})
	}
}

func TestHTTPConnectRejectsFailure(t *testing.T) {
	for _, status := range []int{407, 403, 502} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(status) }))
		d, _ := New(server.URL, time.Second)
		conn, err := d.DialContext(context.Background(), "tcp", "remote.invalid:443")
		server.Close()
		if err == nil || conn != nil {
			t.Fatalf("status %d accepted", status)
		}
	}
}

func TestHTTPSConnectVerifiesCertificate(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("untrusted proxy received CONNECT") }))
	defer server.Close()
	d, _ := New(server.URL, time.Second)
	if conn, err := d.DialContext(context.Background(), "tcp", "remote.invalid:443"); err == nil || conn != nil {
		t.Fatal("untrusted certificate accepted")
	}
}

func TestHTTPConnectCancellation(t *testing.T) {
	accepted := make(chan struct{})
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { close(accepted); <-release }))
	defer server.Close()
	defer close(release)
	d, _ := New(server.URL, 5*time.Second)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := make(chan error, 1)
	go func() { _, err := d.DialContext(ctx, "tcp", "remote.invalid:443"); result <- err }()
	<-accepted
	cancel()
	select {
	case err := <-result:
		if err == nil {
			t.Fatal("cancel succeeded")
		}
	case <-time.After(time.Second):
		t.Fatal("CONNECT ignored cancellation")
	}
}
