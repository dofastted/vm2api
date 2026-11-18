package egress

import (
	"bytes"
	"context"
	"encoding/binary"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/net/dns/dnsmessage"
)

func overrideQuery(t *testing.T, types ...uint16) []byte {
	t.Helper()
	msg := dnsmessage.Message{Header: dnsmessage.Header{ID: 0x1234, RecursionDesired: true, CheckingDisabled: true}}
	for _, typ := range types {
		msg.Questions = append(msg.Questions, dnsmessage.Question{
			Name: dnsmessage.MustNewName("example.com."), Type: dnsmessage.Type(typ), Class: dnsmessage.ClassINET,
		})
	}
	// EDNS DNSSEC requests must still receive an unsigned empty answer.
	msg.Additionals = []dnsmessage.Resource{{
		Header: dnsmessage.ResourceHeader{Name: dnsmessage.MustNewName("."), Type: dnsmessage.TypeOPT, Class: 1232, TTL: 0x8000},
		Body:   &dnsmessage.OPTResource{},
	}}
	query, err := msg.Pack()
	if err != nil {
		t.Fatal(err)
	}
	return query
}

func assertEmptyOverride(t *testing.T, query, reply []byte, code dnsmessage.RCode) {
	t.Helper()
	var request, response dnsmessage.Message
	if err := request.Unpack(query); err != nil {
		t.Fatal(err)
	}
	if err := response.Unpack(reply); err != nil {
		t.Fatal(err)
	}
	if response.ID != request.ID || !response.Response || !response.RecursionAvailable ||
		!response.RecursionDesired || !response.CheckingDisabled || response.AuthenticData ||
		response.RCode != code || len(response.Answers)+len(response.Authorities)+len(response.Additionals) != 0 {
		t.Fatalf("unexpected DNS override response: %#v", response)
	}
	if len(response.Questions) != len(request.Questions) {
		t.Fatal("question count changed")
	}
	for i := range request.Questions {
		if response.Questions[i] != request.Questions[i] {
			t.Fatalf("question %d changed", i)
		}
	}
}

func TestDNSEmptyTypesOverride(t *testing.T) {
	socks, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer socks.Close()
	for range 2 {
		go serveTestSOCKS(t, socks)
	}
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
			return
		}
		body[2] |= 0x80
		_, _ = w.Write(body)
	}))
	defer upstream.Close()
	for _, enabled := range []bool{true, false} {
		cfg := Config{ProxyURL: "socks5h://" + socks.Addr().String(), ListenTCP: "127.0.0.1:0", DNSUpstream: upstream.URL}
		if enabled {
			cfg.DNSEmptyTypes = []uint16{64, 65}
		}
		srv, err := New(cfg)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(srv.rt().http.CloseIdleConnections)
		// The server owns its immutable override config even if the caller changes the slice.
		if enabled {
			cfg.DNSEmptyTypes[0] = 1
		}
		for _, typ := range []uint16{64, 65, 1, 28, 16} {
			query := overrideQuery(t, typ)
			before := calls.Load()
			reply, err := srv.ResolveDNS(context.Background(), query)
			if err != nil {
				t.Fatal(err)
			}
			if enabled && (typ == 64 || typ == 65) {
				assertEmptyOverride(t, query, reply, dnsmessage.RCodeSuccess)
				if calls.Load() != before {
					t.Fatal("overridden query reached upstream")
				}
				continue
			}
			want := bytes.Clone(query)
			want[2] |= 0x80
			if calls.Load() != before+1 || !bytes.Equal(reply, want) {
				t.Fatalf("type %d enabled=%v was not forwarded unchanged", typ, enabled)
			}
		}
		if enabled {
			query := overrideQuery(t, 64, 1)
			before := calls.Load()
			reply, err := srv.ResolveDNS(context.Background(), query)
			if err != nil {
				t.Fatal(err)
			}
			assertEmptyOverride(t, query, reply, dnsmessage.RCodeFormatError)
			if calls.Load() != before {
				t.Fatal("mixed query leaked to upstream")
			}
			if _, err := srv.ResolveDNS(context.Background(), query[:14]); err == nil {
				t.Fatal("malformed query was accepted")
			}
		}
	}
}

func TestDNSEmptyTypesOverUDPAndTCP(t *testing.T) {
	srv, err := New(Config{ProxyURL: "socks5h://127.0.0.1:1", ListenTCP: "127.0.0.1:0", DNSEmptyTypes: []uint16{64, 65}, DNSUpstream: "127.0.0.1:1"})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ln, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go srv.serveDNS(ctx, ln)
	udp, err := net.Dial("udp", ln.LocalAddr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer udp.Close()
	_ = udp.SetDeadline(time.Now().Add(2 * time.Second))
	query := overrideQuery(t, 64)
	if _, err := udp.Write(query); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 4096)
	n, err := udp.Read(buf)
	if err != nil {
		t.Fatal(err)
	}
	assertEmptyOverride(t, query, buf[:n], dnsmessage.RCodeSuccess)
	client, server := net.Pipe()
	defer client.Close()
	go srv.handleDNSTCP(ctx, server)
	_ = client.SetDeadline(time.Now().Add(2 * time.Second))
	query = overrideQuery(t, 65)
	frame := make([]byte, len(query)+2)
	binary.BigEndian.PutUint16(frame, uint16(len(query)))
	copy(frame[2:], query)
	if _, err := client.Write(frame); err != nil {
		t.Fatal(err)
	}
	var hdr [2]byte
	if _, err := io.ReadFull(client, hdr[:]); err != nil {
		t.Fatal(err)
	}
	reply := make([]byte, binary.BigEndian.Uint16(hdr[:]))
	if _, err := io.ReadFull(client, reply); err != nil {
		t.Fatal(err)
	}
	assertEmptyOverride(t, query, reply, dnsmessage.RCodeSuccess)
}
