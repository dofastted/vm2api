//go:build linux

package egress

import (
	"context"
	"net"
	"testing"
	"time"
)

func TestDirectTCPProbeNeverDialsProxy(t *testing.T) {
	for _, listen := range []string{"127.0.0.1:0", "0.0.0.0:0"} {
		t.Run(listen, func(t *testing.T) {
			proxy, err := net.Listen("tcp4", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			defer proxy.Close()
			dialed := make(chan struct{}, 1)
			go func() {
				conn, err := proxy.Accept()
				if err == nil {
					dialed <- struct{}{}
					conn.Close()
				}
			}()
			listener, err := net.Listen("tcp4", listen)
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			srv, err := New(Config{ListenTCP: listen, ProxyURL: "socks5h://" + proxy.Addr().String()})
			if err != nil {
				t.Fatal(err)
			}
			done := make(chan struct{})
			go func() {
				defer close(done)
				conn, err := listener.Accept()
				if err == nil {
					srv.handleTCP(context.Background(), conn)
				}
			}()
			port := listener.Addr().(*net.TCPAddr).Port
			client, err := net.DialTCP("tcp4", nil, &net.TCPAddr{IP: net.ParseIP("127.0.0.1"), Port: port})
			if err != nil {
				t.Fatal(err)
			}
			defer client.Close()
			select {
			case <-done:
			case <-time.After(2 * time.Second):
				t.Fatal("direct probe was not closed promptly")
			}
			select {
			case <-dialed:
				t.Fatal("self-destined connection reached the SOCKS proxy")
			default:
			}
			client.SetReadDeadline(time.Now().Add(time.Second))
			var buf [1]byte
			if _, err := client.Read(buf[:]); err == nil {
				t.Fatal("direct probe connection remained open")
			}
		})
	}
}
