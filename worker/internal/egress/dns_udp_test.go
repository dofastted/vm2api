package egress

import (
	"context"
	"net"
	"testing"
	"time"

	"golang.org/x/net/dns/dnsmessage"
)

func TestDNSUDPUpstreamFailReturnsServFail(t *testing.T) {
	srv, err := New(Config{
		ProxyURL:    "socks5h://127.0.0.1:1",
		ListenTCP:   "127.0.0.1:0",
		DNSUpstream: "127.0.0.1:1",
	})
	if err != nil {
		t.Fatal(err)
	}
	ln, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go srv.serveDNS(ctx, ln)
	client, err := net.Dial("udp", ln.LocalAddr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	_ = client.SetDeadline(time.Now().Add(2 * time.Second))
	query := overrideQuery(t, 1)
	binaryQueryID := uint16(0x4242)
	query[0] = byte(binaryQueryID >> 8)
	query[1] = byte(binaryQueryID)
	if _, err := client.Write(query); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, dnsMaxUDPSize)
	n, err := client.Read(buf)
	if err != nil {
		t.Fatalf("expected UDP SERVFAIL reply, got read error: %v", err)
	}
	var reply dnsmessage.Message
	if err := reply.Unpack(buf[:n]); err != nil {
		t.Fatal(err)
	}
	if reply.ID != binaryQueryID || reply.RCode != dnsmessage.RCodeServerFailure {
		t.Fatalf("expected SERVFAIL id %d, got id %d rcode %v", binaryQueryID, reply.ID, reply.RCode)
	}
}

func TestServeDNSAcceptsPacketsLargerThan4096(t *testing.T) {
	srv, err := New(Config{
		ProxyURL:      "socks5h://127.0.0.1:1",
		ListenTCP:     "127.0.0.1:0",
		DNSEmptyTypes: []uint16{1},
	})
	if err != nil {
		t.Fatal(err)
	}
	query := overrideQuery(t, 1)
	if len(query) >= 4096 {
		t.Fatalf("fixture query unexpectedly large: %d", len(query))
	}
	padding := make([]byte, 5000-len(query))
	payload := append(append([]byte{}, query...), padding...)
	ln, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go srv.serveDNS(ctx, ln)
	client, err := net.Dial("udp", ln.LocalAddr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	_ = client.SetDeadline(time.Now().Add(2 * time.Second))
	if _, err := client.Write(payload); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, dnsMaxUDPSize)
	n, err := client.Read(buf)
	if err != nil {
		t.Fatalf("expected UDP reply for oversized datagram, got: %v", err)
	}
	if n == 0 {
		t.Fatal("empty UDP reply")
	}
}

func TestServeDNSFullSlotsAnswerServFailInline(t *testing.T) {
	// An upstream that never answers: a resolution would block for dnsAttemptTimeout.
	silent, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer silent.Close()
	srv, err := New(Config{
		ProxyURL:    "socks5h://127.0.0.1:1",
		ListenTCP:   "127.0.0.1:0",
		DNSUpstream: silent.LocalAddr().String(),
	})
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < cap(srv.dnsSlots); i++ {
		srv.dnsSlots <- struct{}{}
	}
	ln, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go srv.serveDNS(ctx, ln)
	client, err := net.Dial("udp", ln.LocalAddr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	_ = client.SetDeadline(time.Now().Add(1 * time.Second))
	query := overrideQuery(t, 1)
	query[0], query[1] = 0x31, 0x32
	if _, err := client.Write(query); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, dnsMaxUDPSize)
	n, err := client.Read(buf)
	if err != nil {
		t.Fatalf("expected inline SERVFAIL with full slots, got %v", err)
	}
	var reply dnsmessage.Message
	if err := reply.Unpack(buf[:n]); err != nil {
		t.Fatal(err)
	}
	if reply.ID != 0x3132 || reply.RCode != dnsmessage.RCodeServerFailure {
		t.Fatalf("expected SERVFAIL id 0x3132, got id %#x rcode %v", reply.ID, reply.RCode)
	}
	if got := len(srv.dnsSlots); got != cap(srv.dnsSlots) {
		t.Fatalf("slots changed: %d", got)
	}
}
