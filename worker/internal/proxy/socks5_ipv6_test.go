package proxy

import (
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"net/url"
	"strconv"
	"testing"
	"time"
)

func TestDialerIPv6LoopbackTransport(t *testing.T) {
	cases := []struct {
		name       string
		proxyHost  string
		listenHost string
		targetHost string
		atyp       byte
	}{
		{"ipv6_proxy_domain_target", "::1", "::1", "transport.example.invalid", 3},
		{"ipv6_proxy_ipv4_target", "::1", "::1", "127.0.0.1", 1},
		{"ipv6_proxy_ipv6_target", "::1", "::1", "::1", 4},
		{"ipv4_proxy_ipv6_target", "127.0.0.1", "127.0.0.1", "::1", 4},
		{"hostname_proxy_ipv6_only", "localhost", "::1", "transport.example.invalid", 3},
	}
	for _, tc := range cases {
		for _, scheme := range []string{"socks5", "socks5h"} {
			for _, authenticated := range []bool{false, true} {
				t.Run(fmt.Sprintf("%s/%s/auth=%t", tc.name, scheme, authenticated), func(t *testing.T) {
					ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
					defer cancel()
					targetListenHost := tc.targetHost
					if net.ParseIP(targetListenHost) == nil {
						targetListenHost = "::1"
					}
					target := loopbackListener(t, targetListenHost)
					peer := loopbackListener(t, tc.listenHost)
					results := make(chan error, 2)
					go func() {
						conn, err := target.Accept()
						if err != nil {
							results <- err
							return
						}
						defer conn.Close()
						_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
						payload := make([]byte, 4)
						_, err = io.ReadFull(conn, payload)
						if err == nil && string(payload) != "ping" {
							err = fmt.Errorf("upstream did not receive the tunneled payload")
						}
						if err == nil {
							_, err = conn.Write([]byte("pong"))
						}
						results <- err
					}()
					go func() {
						conn, err := peer.Accept()
						if err == nil {
							defer conn.Close()
							_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
							err = relayLoopbackSOCKS(conn, target.Addr().String(), tc.targetHost, tc.atyp, authenticated)
						}
						results <- err
					}()
					_, proxyPort, _ := net.SplitHostPort(peer.Addr().String())
					proxyURL := &url.URL{Scheme: scheme, Host: net.JoinHostPort(tc.proxyHost, proxyPort)}
					if authenticated {
						proxyURL.User = url.UserPassword("test:@/%", "test%/@:secret")
					}
					dialer, err := New(proxyURL.String(), 5*time.Second)
					if err != nil {
						t.Fatal(err)
					}
					_, targetPort, _ := net.SplitHostPort(target.Addr().String())
					conn, err := dialer.DialContext(ctx, "tcp", net.JoinHostPort(tc.targetHost, targetPort))
					if err != nil {
						t.Fatal(err)
					}
					defer conn.Close()
					_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
					if _, err := conn.Write([]byte("ping")); err != nil {
						t.Fatal(err)
					}
					payload := make([]byte, 4)
					if _, err := io.ReadFull(conn, payload); err != nil {
						t.Fatal(err)
					}
					if string(payload) != "pong" {
						t.Fatal("upstream reply did not traverse the SOCKS tunnel")
					}
					for range 2 {
						select {
						case err := <-results:
							if err != nil {
								t.Fatal(err)
							}
						case <-ctx.Done():
							t.Fatal(ctx.Err())
						}
					}
				})
			}
		}
	}
}

func loopbackListener(t *testing.T, host string) net.Listener {
	t.Helper()
	listener, err := net.Listen("tcp", net.JoinHostPort(host, "0"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	return listener
}

func relayLoopbackSOCKS(conn net.Conn, upstreamAddress, targetHost string, atyp byte, authenticated bool) error {
	var head [2]byte
	if _, err := io.ReadFull(conn, head[:]); err != nil {
		return err
	}
	if head[0] != 5 {
		return fmt.Errorf("invalid SOCKS greeting")
	}
	methods := make([]byte, head[1])
	if _, err := io.ReadFull(conn, methods); err != nil {
		return err
	}
	method := byte(0)
	if authenticated {
		method = 2
	}
	found := false
	for _, candidate := range methods {
		found = found || candidate == method
	}
	if !found {
		return fmt.Errorf("expected authentication method was not offered")
	}
	if _, err := conn.Write([]byte{5, method}); err != nil {
		return err
	}
	if authenticated {
		if _, err := io.ReadFull(conn, head[:]); err != nil {
			return err
		}
		user := make([]byte, head[1])
		if _, err := io.ReadFull(conn, user); err != nil {
			return err
		}
		var length [1]byte
		if _, err := io.ReadFull(conn, length[:]); err != nil {
			return err
		}
		password := make([]byte, length[0])
		if _, err := io.ReadFull(conn, password); err != nil {
			return err
		}
		if head[0] != 1 || string(user) != "test:@/%" || string(password) != "test%/@:secret" {
			return fmt.Errorf("escaped test credentials were not preserved")
		}
		if _, err := conn.Write([]byte{1, 0}); err != nil {
			return err
		}
	}
	var header [4]byte
	if _, err := io.ReadFull(conn, header[:]); err != nil {
		return err
	}
	if header[0] != 5 || header[1] != 1 || header[2] != 0 || header[3] != atyp {
		return fmt.Errorf("unexpected CONNECT address family: %d", header[3])
	}
	length := 4
	if atyp == 4 {
		length = 16
	} else if atyp == 3 {
		var size [1]byte
		if _, err := io.ReadFull(conn, size[:]); err != nil {
			return err
		}
		length = int(size[0])
	}
	address := make([]byte, length)
	if _, err := io.ReadFull(conn, address); err != nil {
		return err
	}
	gotHost := string(address)
	if atyp != 3 {
		gotHost = net.IP(address).String()
	}
	if gotHost != targetHost {
		return fmt.Errorf("CONNECT host = %q, want %q", gotHost, targetHost)
	}
	if _, err := io.ReadFull(conn, head[:]); err != nil {
		return err
	}
	_, port, _ := net.SplitHostPort(upstreamAddress)
	if strconv.Itoa(int(binary.BigEndian.Uint16(head[:]))) != port {
		return fmt.Errorf("CONNECT port was not preserved")
	}
	// The domain maps only inside this controlled peer; no external DNS or dial.
	upstream, err := net.DialTimeout("tcp", upstreamAddress, 5*time.Second)
	if err != nil {
		return err
	}
	defer upstream.Close()
	_ = upstream.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err := conn.Write([]byte{5, 0, 0, 1, 127, 0, 0, 1, 0, 0}); err != nil {
		return err
	}
	if _, err := io.CopyN(upstream, conn, 4); err != nil {
		return err
	}
	_, err = io.CopyN(conn, upstream, 4)
	return err
}
