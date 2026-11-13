package proxy

import (
	"context"
	"encoding/binary"
	"io"
	"net"
	"net/url"
	"testing"
	"time"
)

func TestDialerUsesRemoteHostnameAndAuthentication(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	targets := make(chan string, 1)
	go func() {
		conn, acceptErr := listener.Accept()
		if acceptErr != nil {
			return
		}
		defer conn.Close()
		greeting := make([]byte, 4)
		if _, readErr := io.ReadFull(conn, greeting); readErr != nil {
			return
		}
		_, _ = conn.Write([]byte{0x05, 0x02})
		authHead := make([]byte, 2)
		if _, readErr := io.ReadFull(conn, authHead); readErr != nil {
			return
		}
		user := make([]byte, int(authHead[1]))
		_, _ = io.ReadFull(conn, user)
		passLen := make([]byte, 1)
		_, _ = io.ReadFull(conn, passLen)
		pass := make([]byte, int(passLen[0]))
		_, _ = io.ReadFull(conn, pass)
		if string(user) != "user" || string(pass) != "pass" {
			return
		}
		_, _ = conn.Write([]byte{0x01, 0x00})
		header := make([]byte, 5)
		if _, readErr := io.ReadFull(conn, header); readErr != nil {
			return
		}
		host := make([]byte, int(header[4]))
		_, _ = io.ReadFull(conn, host)
		portBytes := make([]byte, 2)
		_, _ = io.ReadFull(conn, portBytes)
		targets <- net.JoinHostPort(string(host), formatPort(binary.BigEndian.Uint16(portBytes)))
		_, _ = conn.Write([]byte{0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 1})
		<-time.After(50 * time.Millisecond)
	}()
	proxyURL := (&url.URL{
		Scheme: "socks5h",
		Host:   listener.Addr().String(),
		User:   url.UserPassword("user", "pass"),
	}).String()
	dialer, err := New(proxyURL, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	conn, err := dialer.DialContext(context.Background(), "tcp", "api.anthropic.com:443")
	if err != nil {
		t.Fatal(err)
	}
	_ = conn.Close()
	select {
	case target := <-targets:
		if target != "api.anthropic.com:443" {
			t.Fatalf("SOCKS target = %q", target)
		}
	case <-time.After(time.Second):
		t.Fatal("SOCKS server did not observe target")
	}
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

func TestDialerRejectsProxyAddressAsTarget(t *testing.T) {
	proxyURL := "socks5://user:pass@127.0.0.1:6067"
	dialer, err := New(proxyURL, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	_, err = dialer.DialContext(context.Background(), "tcp", "127.0.0.1:6067")
	if err == nil {
		t.Fatal("expected error when CONNECT target is the proxy itself")
	}
	if got := err.Error(); !contains(got, "refusing proxy CONNECT") {
		t.Fatalf("error = %q", got)
	}
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub || len(sub) == 0 || search(s, sub))
}

func search(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
