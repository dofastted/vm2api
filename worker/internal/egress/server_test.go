package egress

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/binary"
	"errors"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"testing"
	"time"
)

func TestForwardTCPThroughSOCKS(t *testing.T) {
	echo, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echo.Close()
	go func() {
		c, accErr := echo.Accept()
		if accErr != nil {
			return
		}
		defer c.Close()
		buf := make([]byte, 4)
		_, _ = io.ReadFull(c, buf)
		_, _ = c.Write(buf)
	}()

	socksLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer socksLn.Close()
	go serveTestSOCKS(t, socksLn)

	proxyURL := (&url.URL{Scheme: "socks5h", Host: socksLn.Addr().String()}).String()
	srv, err := New(Config{ProxyURL: proxyURL, ListenTCP: "127.0.0.1:0"})
	if err != nil {
		t.Fatal(err)
	}
	client, peer := net.Pipe()
	defer client.Close()
	go func() {
		_ = srv.ForwardTCP(context.Background(), peer, echo.Addr().String())
	}()
	if _, err = client.Write([]byte("ping")); err != nil {
		t.Fatal(err)
	}
	got := make([]byte, 4)
	_ = client.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, err = io.ReadFull(client, got); err != nil {
		t.Fatal(err)
	}
	if string(got) != "ping" {
		t.Fatalf("got %q", got)
	}
}

func TestSpliceIdleClosesBoth(t *testing.T) {
	a, b := net.Pipe()
	c, d := net.Pipe()
	defer a.Close()
	defer c.Close()
	done := make(chan error, 1)
	go func() { done <- spliceIdle(b, d, "example:443", 40*time.Millisecond) }()
	select {
	case err := <-done:
		var se *spliceError
		if !errors.As(err, &se) || se.class != classIdleClose {
			t.Fatalf("got %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("spliceIdle did not return")
	}
	if _, err := a.Write([]byte("x")); err == nil {
		t.Fatal("guest still writable after idle-close")
	}
}

func TestSpliceIdleResetsOnTraffic(t *testing.T) {
	a, b := net.Pipe()
	up, echo := net.Pipe()
	defer a.Close()
	go func() {
		buf := make([]byte, 8)
		for {
			n, err := echo.Read(buf)
			if err != nil {
				return
			}
			if _, err = echo.Write(buf[:n]); err != nil {
				return
			}
		}
	}()
	done := make(chan error, 1)
	go func() { done <- spliceIdle(b, up, "example:443", 120*time.Millisecond) }()
	for i := range 3 {
		time.Sleep(50 * time.Millisecond)
		if _, err := a.Write([]byte("ping")); err != nil {
			t.Fatalf("write %d: %v", i, err)
		}
		got := make([]byte, 4)
		_ = a.SetReadDeadline(time.Now().Add(time.Second))
		if _, err := io.ReadFull(a, got); err != nil {
			t.Fatalf("read %d: %v", i, err)
		}
		if string(got) != "ping" {
			t.Fatalf("got %q", got)
		}
	}
	_ = a.Close()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("traffic should not idle-close: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("splice did not exit after close")
	}
}

func TestResolveDNSOverSOCKSTCP(t *testing.T) {
	dnsLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer dnsLn.Close()
	go func() {
		c, accErr := dnsLn.Accept()
		if accErr != nil {
			return
		}
		defer c.Close()
		var hdr [2]byte
		if _, err := io.ReadFull(c, hdr[:]); err != nil {
			return
		}
		n := int(binary.BigEndian.Uint16(hdr[:]))
		q := make([]byte, n)
		if _, err := io.ReadFull(c, q); err != nil {
			return
		}
		reply := append([]byte{}, q...)
		if len(reply) > 2 {
			reply[2] |= 0x80
		}
		out := make([]byte, 2+len(reply))
		binary.BigEndian.PutUint16(out[:2], uint16(len(reply)))
		copy(out[2:], reply)
		_, _ = c.Write(out)
	}()

	socksLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer socksLn.Close()
	go serveTestSOCKS(t, socksLn)

	proxyURL := (&url.URL{Scheme: "socks5h", Host: socksLn.Addr().String()}).String()
	srv, err := New(Config{
		ProxyURL:    proxyURL,
		ListenTCP:   "127.0.0.1:0",
		DNSUpstream: dnsLn.Addr().String(),
	})
	if err != nil {
		t.Fatal(err)
	}
	query := []byte{0x12, 0x34, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00}
	reply, err := srv.ResolveDNS(context.Background(), query)
	if err != nil {
		t.Fatal(err)
	}
	if len(reply) < 3 || reply[0] != 0x12 || reply[2]&0x80 == 0 {
		t.Fatalf("reply=%v", reply)
	}
}

func TestResolveDNSOverDoH(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q, _ := io.ReadAll(r.Body)
		reply := append([]byte{}, q...)
		if len(reply) > 2 {
			reply[2] |= 0x80
		}
		w.Header().Set("Content-Type", "application/dns-message")
		_, _ = w.Write(reply)
	}))
	defer ts.Close()

	socksLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer socksLn.Close()
	go serveTestSOCKS(t, socksLn)

	proxyURL := (&url.URL{Scheme: "socks5h", Host: socksLn.Addr().String()}).String()
	srv, err := New(Config{
		ProxyURL:    proxyURL,
		ListenTCP:   "127.0.0.1:0",
		DNSUpstream: ts.URL + "/dns-query",
	})
	if err != nil {
		t.Fatal(err)
	}
	query := []byte{0x12, 0x34, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00}
	reply, err := srv.ResolveDNS(context.Background(), query)
	if err != nil {
		t.Fatal(err)
	}
	if len(reply) < 3 || reply[0] != 0x12 || reply[2]&0x80 == 0 {
		t.Fatalf("reply=%v", reply)
	}
}

func TestResolveDNSOverDomainTLSDoH(t *testing.T) {
	const hostname = "nonresolvable.example.invalid"
	query := []byte{0x12, 0x34, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0,
		7, 'e', 'x', 'a', 'm', 'p', 'l', 'e', 3, 'c', 'o', 'm', 0, 0, 1, 0, 1}
	reply := append([]byte(nil), query...)
	reply[2], reply[3], reply[7] = 0x81, 0x80, 1
	reply = append(reply, 0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 192, 0, 2, 1)
	for _, tc := range []struct {
		name     string
		certHost string
		trust    bool
	}{
		{"trusted", hostname, true},
		{"untrusted", hostname, false},
		{"wrong-hostname", "different.example.invalid", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cert, roots := testDoHCertificate(t, tc.certHost)
			sni := make(chan string, 1)
			ts := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				host, _, err := net.SplitHostPort(r.Host)
				if err != nil || host != hostname || r.Method != http.MethodPost || r.URL.Path != "/dns-query" {
					t.Errorf("unexpected DoH request: %s %s host=%s", r.Method, r.URL, r.Host)
				}
				q, err := io.ReadAll(r.Body)
				if err != nil || !bytes.Equal(q, query) {
					t.Errorf("DoH query=%x err=%v", q, err)
				}
				w.Header().Set("Content-Type", "application/dns-message")
				_, _ = w.Write(reply)
			}))
			ts.TLS = &tls.Config{Certificates: []tls.Certificate{cert},
				GetConfigForClient: func(hello *tls.ClientHelloInfo) (*tls.Config, error) {
					sni <- hello.ServerName
					return nil, nil
				},
			}
			ts.StartTLS()
			defer ts.Close()
			_, port, err := net.SplitHostPort(ts.Listener.Addr().String())
			if err != nil {
				t.Fatal(err)
			}
			socksLn, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			defer socksLn.Close()
			target := make(chan string, 1)
			go serveTestSOCKSWithTarget(t, socksLn, func(atyp byte, host string, targetPort uint16) (string, error) {
				if atyp != 0x03 || host != hostname || formatPort(targetPort) != port {
					target <- "unexpected SOCKS target: " + net.JoinHostPort(host, formatPort(targetPort)) + " ATYP=" + strconv.Itoa(int(atyp))
					return "", errors.New("unexpected SOCKS target")
				}
				target <- ""
				return ts.Listener.Addr().String(), nil
			})
			srv, err := New(Config{
				ProxyURL: "socks5h://" + socksLn.Addr().String(), ListenTCP: "127.0.0.1:0",
				DNSUpstream: "https://" + net.JoinHostPort(hostname, port) + "/dns-query",
			})
			if err != nil {
				t.Fatal(err)
			}
			transport := srv.rt().def.http.Transport.(*http.Transport)
			defer transport.CloseIdleConnections()
			// Install only the fixture CA, keeping normal TLS hostname verification.
			transport.TLSClientConfig = &tls.Config{RootCAs: x509.NewCertPool()}
			if tc.trust {
				transport.TLSClientConfig.RootCAs = roots
			}
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			got, err := srv.ResolveDNS(ctx, query)
			switch tc.name {
			case "trusted":
				if err != nil || !bytes.Equal(got, reply) {
					t.Fatalf("DNS reply=%x err=%v", got, err)
				}
			case "untrusted":
				var certErr x509.UnknownAuthorityError
				if !errors.As(err, &certErr) {
					t.Fatalf("want unknown certificate authority, got %v", err)
				}
			case "wrong-hostname":
				var certErr x509.HostnameError
				if !errors.As(err, &certErr) {
					t.Fatalf("want certificate hostname rejection, got %v", err)
				}
			}
			select {
			case problem := <-target:
				if problem != "" {
					t.Fatal(problem)
				}
			case <-ctx.Done():
				t.Fatal("no SOCKS CONNECT observed")
			}
			select {
			case got := <-sni:
				if got != hostname {
					t.Fatalf("TLS SNI=%q want %q", got, hostname)
				}
			case <-ctx.Done():
				t.Fatal("no TLS ClientHello observed")
			}
		})
	}
}

func testDoHCertificate(t *testing.T, hostname string) (tls.Certificate, *x509.CertPool) {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	ca := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "DoH test CA"},
		NotBefore: time.Unix(0, 0), NotAfter: time.Date(2100, 1, 1, 0, 0, 0, 0, time.UTC),
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign,
	}
	caDER, err := x509.CreateCertificate(rand.Reader, ca, ca, public, private)
	if err != nil {
		t.Fatal(err)
	}
	root, err := x509.ParseCertificate(caDER)
	if err != nil {
		t.Fatal(err)
	}
	leaf := &x509.Certificate{
		SerialNumber: big.NewInt(2), DNSNames: []string{hostname},
		NotBefore: ca.NotBefore, NotAfter: ca.NotAfter,
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	leafDER, err := x509.CreateCertificate(rand.Reader, leaf, root, public, private)
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AddCert(root)
	return tls.Certificate{Certificate: [][]byte{leafDER, caDER}, PrivateKey: private}, roots
}

func TestDoHRedirectRequiresHTTPS(t *testing.T) {
	for _, status := range []int{http.StatusTemporaryRedirect, http.StatusPermanentRedirect} {
		for _, downgrade := range []bool{false, true} {
			t.Run(strconv.Itoa(status)+"/downgrade="+strconv.FormatBool(downgrade), func(t *testing.T) {
				plaintext := make(chan struct{}, 1)
				httpServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					plaintext <- struct{}{}
					w.WriteHeader(http.StatusNoContent)
				}))
				defer httpServer.Close()
				query := []byte{0x12, 0x34, 0x01, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1}
				reply := append([]byte(nil), query...)
				reply[2] |= 0x80
				ts := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if r.URL.Path == "/dns-query" {
						target := "/answer"
						if downgrade {
							target = httpServer.URL + "/answer"
						}
						http.Redirect(w, r, target, status)
						return
					}
					q, err := io.ReadAll(r.Body)
					if r.Method != http.MethodPost || err != nil || !bytes.Equal(q, query) {
						t.Errorf("redirect lost DNS POST: method=%s body=%x err=%v", r.Method, q, err)
					}
					w.Header().Set("Content-Type", "application/dns-message")
					_, _ = w.Write(reply)
				}))
				defer ts.Close()
				socksLn, err := net.Listen("tcp", "127.0.0.1:0")
				if err != nil {
					t.Fatal(err)
				}
				defer socksLn.Close()
				// A second CONNECT would expose a rejected downgrade to the HTTP fixture.
				go serveTestSOCKS(t, socksLn)
				go serveTestSOCKS(t, socksLn)
				srv, err := New(Config{ProxyURL: "socks5h://" + socksLn.Addr().String(),
					ListenTCP: "127.0.0.1:0", DNSUpstream: ts.URL + "/dns-query"})
				if err != nil {
					t.Fatal(err)
				}
				transport := srv.rt().def.http.Transport.(*http.Transport)
				defer transport.CloseIdleConnections()
				transport.TLSClientConfig = ts.Client().Transport.(*http.Transport).TLSClientConfig.Clone()
				ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
				defer cancel()
				got, err := srv.ResolveDNS(ctx, query)
				if downgrade {
					if err == nil {
						t.Fatal("HTTPS to HTTP redirect was accepted")
					}
				} else if err != nil || !bytes.Equal(got, reply) {
					t.Fatalf("HTTPS redirect reply=%x err=%v", got, err)
				}
				select {
				case <-plaintext:
					t.Fatal("DNS request leaked to plaintext HTTP redirect")
				default:
				}
			})
		}
	}
}

func TestResolveDNSFallsBackToNextUpstream(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q, _ := io.ReadAll(r.Body)
		reply := append([]byte{}, q...)
		if len(reply) > 2 {
			reply[2] |= 0x80
		}
		w.Header().Set("Content-Type", "application/dns-message")
		_, _ = w.Write(reply)
	}))
	defer ts.Close()
	dead := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "blocked", http.StatusBadGateway)
	}))
	defer dead.Close()

	socksLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer socksLn.Close()
	for i := 0; i < 3; i++ {
		go serveTestSOCKS(t, socksLn)
	}

	proxyURL := (&url.URL{Scheme: "socks5h", Host: socksLn.Addr().String()}).String()
	srv, err := New(Config{
		ProxyURL:    proxyURL,
		ListenTCP:   "127.0.0.1:0",
		DNSUpstream: dead.URL + "/dns-query, " + ts.URL + "/dns-query",
	})
	if err != nil {
		t.Fatal(err)
	}
	query := []byte{0x12, 0x34, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00}
	reply, err := srv.ResolveDNS(context.Background(), query)
	if err != nil {
		t.Fatal(err)
	}
	if len(reply) < 3 || reply[0] != 0x12 || reply[2]&0x80 == 0 {
		t.Fatalf("reply=%v", reply)
	}
	if got := srv.rt().def.preferred.Load(); got != 1 {
		t.Fatalf("preferred=%d want 1", got)
	}
}

func TestDefaultDNSUpstreamsWhenEmpty(t *testing.T) {
	srv, err := New(Config{ProxyURL: "socks5h://127.0.0.1:1", ListenTCP: "127.0.0.1:0"})
	if err != nil {
		t.Fatal(err)
	}
	if len(srv.rt().def.upstreams) != len(DefaultDNSUpstreams) || srv.rt().def.upstreams[0] != DefaultDNSUpstreams[0] {
		t.Fatalf("upstreams=%v", srv.rt().def.upstreams)
	}
}

func serveTestSOCKS(t *testing.T, ln net.Listener) {
	serveTestSOCKSWithTarget(t, ln, func(_ byte, host string, port uint16) (string, error) {
		return net.JoinHostPort(host, formatPort(port)), nil
	})
}

func serveTestSOCKSWithTarget(t *testing.T, ln net.Listener, target func(byte, string, uint16) (string, error)) {
	t.Helper()
	c, err := ln.Accept()
	if err != nil {
		return
	}
	defer c.Close()
	head := make([]byte, 2)
	if _, err = io.ReadFull(c, head); err != nil {
		return
	}
	nmethod := int(head[1])
	if nmethod > 0 {
		_, _ = io.ReadFull(c, make([]byte, nmethod))
	}
	_, _ = c.Write([]byte{0x05, 0x00})
	req := make([]byte, 4)
	if _, err = io.ReadFull(c, req); err != nil {
		return
	}
	var host string
	var port uint16
	switch req[3] {
	case 0x01:
		addr := make([]byte, 4)
		_, _ = io.ReadFull(c, addr)
		host = net.IP(addr).String()
	case 0x03:
		l := make([]byte, 1)
		_, _ = io.ReadFull(c, l)
		name := make([]byte, l[0])
		_, _ = io.ReadFull(c, name)
		host = string(name)
	default:
		return
	}
	pb := make([]byte, 2)
	_, _ = io.ReadFull(c, pb)
	port = binary.BigEndian.Uint16(pb)
	address, err := target(req[3], host, port)
	if err != nil {
		return
	}
	up, err := net.Dial("tcp", address)
	if err != nil {
		_, _ = c.Write([]byte{0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0})
		return
	}
	defer up.Close()
	_, _ = c.Write([]byte{0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0})
	go func() { _, _ = io.Copy(up, c) }()
	_, _ = io.Copy(c, up)
}

func formatPort(port uint16) string {
	var digits [5]byte
	index := len(digits)
	value := int(port)
	for {
		index--
		digits[index] = byte('0' + value%10)
		value /= 10
		if value == 0 {
			break
		}
	}
	return string(digits[index:])
}
