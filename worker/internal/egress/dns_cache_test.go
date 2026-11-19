package egress

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/net/dns/dnsmessage"
)

func cacheQuery(t *testing.T, id uint16, name string, typ dnsmessage.Type) []byte {
	t.Helper()
	msg := dnsmessage.Message{
		Header:    dnsmessage.Header{ID: id, RecursionDesired: true},
		Questions: []dnsmessage.Question{{Name: dnsmessage.MustNewName(name), Type: typ, Class: dnsmessage.ClassINET}},
	}
	packed, err := msg.Pack()
	if err != nil {
		t.Fatal(err)
	}
	return packed
}

// answerServer replies with an A record (ttl) for every query, or NXDOMAIN
// with an SOA when nx is set.
func answerServer(t *testing.T, ttl uint32, nx bool, calls *atomic.Int32, ip *atomic.Uint32) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		body, _ := io.ReadAll(r.Body)
		var q dnsmessage.Message
		if err := q.Unpack(body); err != nil {
			t.Error(err)
			return
		}
		reply := dnsmessage.Message{
			Header:    dnsmessage.Header{ID: q.ID, Response: true, RecursionAvailable: true},
			Questions: q.Questions,
		}
		if nx {
			reply.RCode = dnsmessage.RCodeNameError
			reply.Authorities = []dnsmessage.Resource{{
				Header: dnsmessage.ResourceHeader{Name: dnsmessage.MustNewName("example.com."), Type: dnsmessage.TypeSOA, Class: dnsmessage.ClassINET, TTL: 300},
				Body: &dnsmessage.SOAResource{
					NS: dnsmessage.MustNewName("ns.example.com."), MBox: dnsmessage.MustNewName("h.example.com."),
					Serial: 1, Refresh: 1, Retry: 1, Expire: 1, MinTTL: 20,
				},
			}}
		} else {
			v := ip.Load()
			reply.Answers = []dnsmessage.Resource{{
				Header: dnsmessage.ResourceHeader{Name: q.Questions[0].Name, Type: dnsmessage.TypeA, Class: dnsmessage.ClassINET, TTL: ttl},
				Body:   &dnsmessage.AResource{A: [4]byte{10, 0, byte(v >> 8), byte(v)}},
			}}
		}
		packed, _ := reply.Pack()
		w.Header().Set("Content-Type", "application/dns-message")
		_, _ = w.Write(packed)
	}))
}

func testCacheServer(url string, client *http.Client) *Server {
	server := &Server{dnsSlots: make(chan struct{}, dnsMaxInflight)}
	server.cur.Store(&runtime{def: &exit{upstreams: []string{url}, http: client}})
	return server
}

func unpackReply(t *testing.T, reply []byte) dnsmessage.Message {
	t.Helper()
	var msg dnsmessage.Message
	if err := msg.Unpack(reply); err != nil {
		t.Fatal(err)
	}
	return msg
}

func TestDNSCacheServesRepeatsLocally(t *testing.T) {
	var calls atomic.Int32
	var ip atomic.Uint32
	ip.Store(1)
	up := answerServer(t, 60, false, &calls, &ip)
	defer up.Close()
	s := testCacheServer(up.URL, up.Client())

	for i, id := range []uint16{0x1111, 0x2222, 0x3333} {
		reply, err := s.ResolveDNS(context.Background(), cacheQuery(t, id, "api.anthropic.com.", dnsmessage.TypeA))
		if err != nil {
			t.Fatal(err)
		}
		msg := unpackReply(t, reply)
		if msg.ID != id {
			t.Fatalf("reply %d: id %#x, want %#x", i, msg.ID, id)
		}
		if len(msg.Answers) != 1 || msg.Answers[0].Header.TTL == 0 || msg.Answers[0].Header.TTL > 60 {
			t.Fatalf("reply %d: bad answers %#v", i, msg.Answers)
		}
	}
	if got := calls.Load(); got != 1 {
		t.Fatalf("upstream calls = %d, want 1", got)
	}
	// A different type is a different key.
	if _, err := s.ResolveDNS(context.Background(), cacheQuery(t, 1, "api.anthropic.com.", dnsmessage.TypeAAAA)); err != nil {
		t.Fatal(err)
	}
	if got := calls.Load(); got != 2 {
		t.Fatalf("upstream calls = %d, want 2", got)
	}
}

func TestDNSCacheServesStaleAndRefreshes(t *testing.T) {
	var calls atomic.Int32
	var ip atomic.Uint32
	ip.Store(1)
	up := answerServer(t, 60, false, &calls, &ip)
	defer up.Close()
	s := testCacheServer(up.URL, up.Client())
	query := cacheQuery(t, 7, "api.anthropic.com.", dnsmessage.TypeA)
	if _, err := s.ResolveDNS(context.Background(), query); err != nil {
		t.Fatal(err)
	}
	// Age the entry past its TTL but inside the stale window.
	_, key, _ := dnsQueryKey(query)
	cache := &s.rt().def.cache
	cache.mu.Lock()
	e := cache.entries[key]
	e.expires = time.Now().Add(-time.Second)
	cache.mu.Unlock()
	ip.Store(2)

	reply, err := s.ResolveDNS(context.Background(), query)
	if err != nil {
		t.Fatal(err)
	}
	msg := unpackReply(t, reply)
	if a := msg.Answers[0].Body.(*dnsmessage.AResource).A; a[3] != 1 {
		t.Fatalf("stale reply served %v, want old address", a)
	}
	if ttl := msg.Answers[0].Header.TTL; ttl != dnsCacheStaleTTL {
		t.Fatalf("stale ttl = %d", ttl)
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		reply, err = s.ResolveDNS(context.Background(), query)
		if err != nil {
			t.Fatal(err)
		}
		if unpackReply(t, reply).Answers[0].Body.(*dnsmessage.AResource).A[3] == 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("background refresh never replaced the stale answer")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if got := calls.Load(); got != 2 {
		t.Fatalf("upstream calls = %d, want 2 (one refresh)", got)
	}
}

func TestDNSCacheNegativeNotServedStale(t *testing.T) {
	var calls atomic.Int32
	var ip atomic.Uint32
	up := answerServer(t, 0, true, &calls, &ip)
	defer up.Close()
	s := testCacheServer(up.URL, up.Client())
	query := cacheQuery(t, 9, "missing.example.com.", dnsmessage.TypeA)
	for range 2 {
		reply, err := s.ResolveDNS(context.Background(), query)
		if err != nil {
			t.Fatal(err)
		}
		if unpackReply(t, reply).RCode != dnsmessage.RCodeNameError {
			t.Fatal("want NXDOMAIN")
		}
	}
	if got := calls.Load(); got != 1 {
		t.Fatalf("upstream calls = %d, want 1", got)
	}
	_, key, _ := dnsQueryKey(query)
	cache := &s.rt().def.cache
	cache.mu.Lock()
	e := cache.entries[key]
	if d := time.Until(e.expires); d > 20*time.Second {
		t.Errorf("negative lifetime %v, want <= SOA minimum 20s", d)
	}
	e.expires = time.Now().Add(-time.Second)
	e.staleUntil = e.expires
	cache.mu.Unlock()
	if _, err := s.ResolveDNS(context.Background(), query); err != nil {
		t.Fatal(err)
	}
	if got := calls.Load(); got != 2 {
		t.Fatalf("expired negative must go upstream; calls = %d", got)
	}
}

func TestDNSCacheZeroTTLAndDisabled(t *testing.T) {
	var calls atomic.Int32
	var ip atomic.Uint32
	up := answerServer(t, 0, false, &calls, &ip)
	defer up.Close()
	s := testCacheServer(up.URL, up.Client())
	query := cacheQuery(t, 3, "zero.example.com.", dnsmessage.TypeA)
	for range 2 {
		if _, err := s.ResolveDNS(context.Background(), query); err != nil {
			t.Fatal(err)
		}
	}
	if got := calls.Load(); got != 2 {
		t.Fatalf("ttl 0 must not be cached; calls = %d", got)
	}

	var calls2 atomic.Int32
	up2 := answerServer(t, 60, false, &calls2, &ip)
	defer up2.Close()
	s2 := testCacheServer(up2.URL, up2.Client())
	s2.rt().cfg.DNSCacheDisabled = true
	for range 2 {
		if _, err := s2.ResolveDNS(context.Background(), query); err != nil {
			t.Fatal(err)
		}
	}
	if got := calls2.Load(); got != 2 {
		t.Fatalf("disabled cache still cached; calls = %d", got)
	}
}

func TestDNSCacheReloadUsesOnlyNewUpstream(t *testing.T) {
	var oldCalls, newCalls, proxyCalls atomic.Int32
	var oldIP, newIP atomic.Uint32
	oldIP.Store(1)
	newIP.Store(2)
	oldUpstream := answerServer(t, 60, false, &oldCalls, &oldIP)
	t.Cleanup(oldUpstream.Close)
	newUpstream := answerServer(t, 60, false, &newCalls, &newIP)
	t.Cleanup(newUpstream.Close)
	config := Config{ListenTCP: "127.0.0.1:0", ProxyURL: countingSOCKS(t, &proxyCalls), DNSUpstream: oldUpstream.URL}
	server, err := New(config)
	if err != nil {
		t.Fatal(err)
	}
	query := cacheQuery(t, 7, "cache.example.test.", dnsmessage.TypeA)
	assertReply := func(want byte) {
		t.Helper()
		reply, err := server.ResolveDNS(context.Background(), query)
		if err != nil {
			t.Fatal(err)
		}
		if got := unpackReply(t, reply).Answers[0].Body.(*dnsmessage.AResource).A[3]; got != want {
			t.Fatalf("answer address ends in %d, want %d", got, want)
		}
	}
	assertReply(1)
	assertReply(1)
	config.DNSUpstream = newUpstream.URL
	if err := server.Reload(config); err != nil {
		t.Fatal(err)
	}
	assertReply(2)
	assertReply(2)
	if oldCalls.Load() != 1 || newCalls.Load() != 1 {
		t.Fatalf("upstream calls old=%d new=%d, want one each", oldCalls.Load(), newCalls.Load())
	}
}

func TestDNSCacheQuerySeparatesEDNSAndCheckingDisabled(t *testing.T) {
	wire := cacheQuery(t, 9, "cache.example.test.", dnsmessage.TypeA)
	msg := unpackReply(t, wire)
	_, ordinary, _ := dnsQueryKey(wire)
	getKey := func() (dnsCacheKey, bool) {
		t.Helper()
		packed, err := msg.Pack()
		if err != nil {
			t.Fatal(err)
		}
		_, key, ok := dnsQueryKey(packed)
		return key, ok
	}
	msg.CheckingDisabled = true
	if key, ok := getKey(); !ok || key == ordinary {
		t.Fatal("CD must use a different cache key")
	}
	msg.CheckingDisabled = false
	opt := &dnsmessage.OPTResource{}
	msg.Additionals = []dnsmessage.Resource{{
		Header: dnsmessage.ResourceHeader{Name: dnsmessage.MustNewName("."), Type: dnsmessage.TypeOPT, Class: 1232},
		Body:   opt,
	}}
	edns, ok := getKey()
	if !ok || edns == ordinary {
		t.Fatal("EDNS must use a different cache key")
	}
	msg.Additionals[0].Header.TTL = 0x8000
	if key, ok := getKey(); !ok || key == edns {
		t.Fatal("EDNS DO must use a different cache key")
	}
	opt.Options = []dnsmessage.Option{{Code: 10, Data: []byte("test-cookie")}}
	if _, ok := getKey(); ok {
		t.Fatal("request-specific EDNS options must bypass the cache")
	}
}
