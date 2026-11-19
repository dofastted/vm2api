package egress

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/netip"
	"os"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	kinproxy "github.com/dofastted/kin-gateway/worker/internal/proxy"
	"golang.org/x/net/dns/dnsmessage"
)

// Route sends one VM's traffic to its own upstream, keyed by the source address
// the shared bridge hands that VM. Its presence is what switches the helper from
// serving a single exit to multiplexing many: with routes configured the source
// address is the only thing that selects an upstream, and an address that is not
// in the table gets no upstream at all.
type Route struct {
	VMIP     string `json:"vm_ip"`
	ProxyURL string `json:"proxy_url"`
}

type Config struct {
	ProxyID       string   `json:"proxy_id"`
	ProxyURL      string   `json:"proxy_url"`
	ListenTCP     string   `json:"listen_tcp"`
	ListenDNS     string   `json:"listen_dns"`
	DNSUpstream   string   `json:"dns_upstream"`
	DNSEmptyTypes []uint16 `json:"dns_empty_types,omitempty"`
	// DomainForward sends a unique helper DNS answer as a SOCKS hostname.
	// Off by default: the original IP literal is unchanged.
	DomainForward    bool `json:"domain_forward,omitempty"`
	DNSCacheDisabled bool `json:"dns_cache_disabled,omitempty"`
	// Routes is empty for a per-VM helper, which keeps serving ProxyURL alone.
	// An older config therefore behaves exactly as before.
	Routes []Route `json:"routes,omitempty"`
}

// IdleClose is how long a splice may sit with no bytes before both sides
// close. Below residential NAT (~15m). Tests call spliceIdle with a shorter idle.
const IdleClose = 7 * time.Minute

const (
	classIdleClose       = "idle_close"
	classSpliceRST       = "splice_rst"
	classSocksDial       = "socks_dial"
	classAmbiguousDomain = "ambiguous_domain"
	classNoRoute         = "no_route"
)

type spliceError struct {
	class string
	dest  string
	err   error
}

func (e *spliceError) Error() string {
	if e == nil {
		return "splice"
	}
	if e.err == nil {
		return fmt.Sprintf("%s dest=%s", e.class, e.dest)
	}
	return fmt.Sprintf("%s dest=%s: %v", e.class, e.dest, e.err)
}

func (e *spliceError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.err
}

// DefaultDNSUpstreams is tried in order when dns_upstream is empty. Mixing
// DoH and plain DNS-over-TCP on two providers keeps resolution alive when a
// proxy exit cannot reach one of them (e.g. 1.1.1.1:443 blocked).
var DefaultDNSUpstreams = []string{
	"https://1.1.1.1/dns-query",
	"https://8.8.8.8/dns-query",
	"8.8.8.8:53",
	"1.1.1.1:53",
}

// dnsAttemptTimeout bounds each upstream so a dead one does not eat the
// client's whole resolver timeout before fallback kicks in.
const dnsAttemptTimeout = 4 * time.Second

type Server struct {
	// cur holds everything a SIGHUP may swap. Each connection or query reads
	// it once, so established splices stay on the exit they were dialed with.
	cur     atomic.Pointer[runtime]
	domains domainTable
	// dnsSlots caps in-flight UDP DNS queries; a full set answers SERVFAIL
	// inline so a flood cannot pile up goroutines and upstream connections.
	dnsSlots chan struct{}
}

// dnsMaxInflight bounds concurrent UDP DNS resolutions per helper.
const dnsMaxInflight = 256

// parseDNSUpstreams splits a comma-separated dns_upstream value.
func parseDNSUpstreams(v string) []string {
	var out []string
	for _, part := range strings.Split(v, ",") {
		if part = strings.TrimSpace(part); part != "" {
			out = append(out, part)
		}
	}
	return out
}

// exit is one upstream path: the SOCKS dialer, the DoH client that rides it,
// which upstream that path prefers, and the answers it resolved.
//
// Every field is per-exit on purpose. Two VMs leaving through different SOCKS
// exits can get different addresses for the same name — geo-routing and CDNs
// make that the normal case rather than an edge case — so a cache shared
// between them would hand one VM an address only the other's exit can reach,
// and would leak which names that other VM looked up.
type exit struct {
	dialer    *kinproxy.Dialer
	http      *http.Client
	upstreams []string
	preferred atomic.Int32
	cache     dnsCache
}

// runtime is the reloadable part of the helper: the exits it can send traffic
// through, and the policy flags. Listen addresses are fixed for the process
// lifetime.
type runtime struct {
	cfg Config
	// upstreams is helper-wide policy: which resolvers to try, in order. Each
	// exit tracks for itself which one it settled on.
	upstreams []string
	// def serves every connection and query while routes is empty, which is how
	// a per-VM helper works. It is nil on a shared helper, which has no default
	// exit to fall back to — see exitFor.
	def *exit
	// routes is nil for a single-exit helper. When it is set, the source address
	// is the only thing that picks an exit: see exitFor.
	routes map[netip.Addr]*exit
}

// addrSource is the peer address, unmapped: a helper listening on a dual-stack
// socket sees an IPv4 peer as ::ffff:a.b.c.d while the route table is keyed on
// the plain form.
func addrSource(addr net.Addr) (netip.Addr, error) {
	if addr == nil {
		return netip.Addr{}, fmt.Errorf("missing source address")
	}
	ap, err := netip.ParseAddrPort(addr.String())
	if err != nil {
		return netip.Addr{}, fmt.Errorf("unparsable source address %q: %w", addr, err)
	}
	return ap.Addr().Unmap(), nil
}

// sourceAddrOf is the address the shared bridge gave the VM on the other end.
func sourceAddrOf(c net.Conn) (netip.Addr, error) {
	if c == nil {
		return netip.Addr{}, fmt.Errorf("missing connection")
	}
	return addrSource(c.RemoteAddr())
}

// exitFor picks the upstream path for one source address.
//
// Without routes the helper serves one exit and everything takes it, which is
// how a per-VM helper has always worked. With routes the source address is the
// sole selector and an unknown one is refused: falling back to a default exit
// would send an unauthorised VM's traffic out through someone else's upstream,
// which is the whole failure this design exists to prevent. A shared helper has
// no default exit to fall back to even by mistake — rt.def is nil there, and
// newRuntime refuses a config that would leave both empty.
func (rt *runtime) exitFor(src netip.Addr) (*exit, error) {
	if len(rt.routes) == 0 {
		return rt.def, nil
	}
	if e := rt.routes[src.Unmap()]; e != nil {
		return e, nil
	}
	return nil, fmt.Errorf("no route for source %s", src)
}

// exitForConn resolves the exit serving a connection. An unreadable peer
// address fails the same way an unknown one does.
func (rt *runtime) exitForConn(client net.Conn) (*exit, error) {
	if len(rt.routes) == 0 {
		return rt.def, nil
	}
	src, err := sourceAddrOf(client)
	if err != nil {
		return nil, err
	}
	return rt.exitFor(src)
}

func (s *Server) rt() *runtime { return s.cur.Load() }

func New(cfg Config) (*Server, error) {
	if cfg.ListenTCP == "" {
		return nil, fmt.Errorf("listen tcp address is required")
	}
	rt, err := newRuntime(cfg)
	if err != nil {
		return nil, err
	}
	s := &Server{dnsSlots: make(chan struct{}, dnsMaxInflight)}
	s.cur.Store(rt)
	return s, nil
}

// Reload swaps proxy, DNS and policy settings without closing listeners or
// established connections; new connections use the new settings. A bad config
// leaves the running one untouched.
func (s *Server) Reload(cfg Config) error {
	old := s.rt()
	if cfg.ListenTCP != old.cfg.ListenTCP || cfg.ListenDNS != old.cfg.ListenDNS {
		return fmt.Errorf("reload cannot change listen addresses (tcp %s->%s dns %s->%s)",
			old.cfg.ListenTCP, cfg.ListenTCP, old.cfg.ListenDNS, cfg.ListenDNS)
	}
	next, err := newRuntime(cfg)
	if err != nil {
		return err
	}
	// An exit that did not change keeps the resolver it had settled on, so a
	// reload does not make every exit re-probe its upstreams.
	if next.cfg.DNSUpstream == old.cfg.DNSUpstream {
		if next.cfg.ProxyURL == old.cfg.ProxyURL && next.def != nil && old.def != nil {
			next.def.preferred.Store(old.def.preferred.Load())
		}
		oldURL := make(map[netip.Addr]string, len(old.cfg.Routes))
		for _, r := range old.cfg.Routes {
			if addr, parseErr := netip.ParseAddr(strings.TrimSpace(r.VMIP)); parseErr == nil {
				oldURL[addr.Unmap()] = r.ProxyURL
			}
		}
		for _, r := range next.cfg.Routes {
			addr, parseErr := netip.ParseAddr(strings.TrimSpace(r.VMIP))
			if parseErr != nil || oldURL[addr.Unmap()] != r.ProxyURL {
				continue
			}
			if prev, kept := old.routes[addr.Unmap()]; kept {
				next.routes[addr.Unmap()].preferred.Store(prev.preferred.Load())
			}
		}
	}
	s.cur.Store(next)
	// Idle DoH connections still go through the old proxy; in-flight ones finish.
	old.closeIdle()
	log.Printf("kin-egress reloaded proxy_id=%s dns_upstreams=%s domain_forward=%t routes=%d",
		next.cfg.ProxyID, strings.Join(next.upstreams, ","), next.cfg.DomainForward, len(next.routes))
	return nil
}

// closeIdle drops idle DoH connections on every exit this runtime owned.
func (rt *runtime) closeIdle() {
	if rt.def != nil {
		rt.def.http.CloseIdleConnections()
	}
	for _, e := range rt.routes {
		e.http.CloseIdleConnections()
	}
}

// newExit builds one upstream path. The resolver list is shared policy; which
// resolver this path prefers, and what it answered, are not.
func newExit(proxyURL string, upstreams []string) (*exit, error) {
	dialer, err := kinproxy.New(proxyURL, 15*time.Second)
	if err != nil {
		return nil, err
	}
	return &exit{
		dialer:    dialer,
		upstreams: upstreams,
		http: &http.Client{
			Timeout: 10 * time.Second,
			CheckRedirect: func(req *http.Request, via []*http.Request) error {
				if req.URL.Scheme != "https" {
					return fmt.Errorf("refusing DoH redirect to non-HTTPS URL")
				}
				if len(via) >= 10 {
					return fmt.Errorf("stopped after 10 redirects")
				}
				return nil
			},
			Transport: &http.Transport{
				DialContext: dialer.DialContext,
			},
		},
	}, nil
}

// buildRoutes turns the configured table into one exit per VM address.
//
// A duplicate or unparsable address is a hard error rather than a skipped entry:
// a route silently dropped here becomes a VM whose traffic is refused at dial
// time, and the reload that introduced it would have reported success.
func buildRoutes(routes []Route, upstreams []string) (map[netip.Addr]*exit, error) {
	if len(routes) == 0 {
		return nil, nil
	}
	out := make(map[netip.Addr]*exit, len(routes))
	for _, r := range routes {
		addr, err := netip.ParseAddr(strings.TrimSpace(r.VMIP))
		if err != nil {
			return nil, fmt.Errorf("route %q: unparsable vm_ip: %w", r.VMIP, err)
		}
		addr = addr.Unmap()
		if _, dup := out[addr]; dup {
			return nil, fmt.Errorf("route %s: duplicate vm_ip", addr)
		}
		if strings.TrimSpace(r.ProxyURL) == "" {
			return nil, fmt.Errorf("route %s: proxy_url is required", addr)
		}
		e, err := newExit(r.ProxyURL, upstreams)
		if err != nil {
			return nil, fmt.Errorf("route %s: %w", addr, err)
		}
		out[addr] = e
	}
	return out, nil
}

func newRuntime(cfg Config) (*runtime, error) {
	cfg.DNSEmptyTypes = append([]uint16(nil), cfg.DNSEmptyTypes...)
	cfg.Routes = append([]Route(nil), cfg.Routes...)
	upstreams := parseDNSUpstreams(cfg.DNSUpstream)
	if len(upstreams) == 0 {
		upstreams = append([]string(nil), DefaultDNSUpstreams...)
	}
	// The observed domain table is one table for the whole helper, so on a
	// shared helper it would mix the names every VM looked up: one VM's
	// connection to a bare IP could be rewritten to a hostname another VM
	// resolved, and two VMs resolving different names to one address would make
	// each other's destinations ambiguous. Refuse the combination rather than
	// serve traffic shaped by another tenant's lookups.
	if len(cfg.Routes) > 0 && cfg.DomainForward {
		return nil, fmt.Errorf("domain_forward cannot be combined with routes: the observed domain table is shared across all routes")
	}
	// A shared helper has no default exit: every VM leaves through its own, and
	// proxy_url is left empty rather than holding a placeholder that looks
	// usable. Without routes there is nothing to route on, so one is required.
	if len(cfg.Routes) == 0 && strings.TrimSpace(cfg.ProxyURL) == "" {
		return nil, fmt.Errorf("proxy_url is required when no routes are configured")
	}
	var def *exit
	if strings.TrimSpace(cfg.ProxyURL) != "" {
		var err error
		def, err = newExit(cfg.ProxyURL, upstreams)
		if err != nil {
			return nil, err
		}
	}
	routes, err := buildRoutes(cfg.Routes, upstreams)
	if err != nil {
		return nil, err
	}
	return &runtime{cfg: cfg, upstreams: upstreams, def: def, routes: routes}, nil
}

func (s *Server) Serve(ctx context.Context) error {
	rt := s.rt()
	tcpLn, err := net.Listen("tcp", rt.cfg.ListenTCP)
	if err != nil {
		return fmt.Errorf("listen tcp: %w", err)
	}
	defer tcpLn.Close()

	var dnsUDP net.PacketConn
	var dnsTCP net.Listener
	if rt.cfg.ListenDNS != "" {
		dnsUDP, err = net.ListenPacket("udp", rt.cfg.ListenDNS)
		if err != nil {
			return fmt.Errorf("listen dns udp: %w", err)
		}
		defer dnsUDP.Close()
		go s.serveDNS(ctx, dnsUDP)
		dnsTCP, err = net.Listen("tcp", rt.cfg.ListenDNS)
		if err != nil {
			return fmt.Errorf("listen dns tcp: %w", err)
		}
		defer dnsTCP.Close()
		go s.serveDNSTCP(ctx, dnsTCP)
	}

	log.Printf("kin-egress ready proxy_id=%s tcp=%s dns=%s dns_upstreams=%s routes=%d", rt.cfg.ProxyID, rt.cfg.ListenTCP, rt.cfg.ListenDNS, strings.Join(rt.upstreams, ","), len(rt.routes))
	go func() {
		<-ctx.Done()
		_ = tcpLn.Close()
		if dnsUDP != nil {
			_ = dnsUDP.Close()
		}
		if dnsTCP != nil {
			_ = dnsTCP.Close()
		}
	}()
	for {
		conn, acceptErr := tcpLn.Accept()
		if acceptErr != nil {
			if ctx.Err() != nil {
				return nil
			}
			return acceptErr
		}
		go s.handleTCP(ctx, conn)
	}
}

func (s *Server) handleTCP(ctx context.Context, conn net.Conn) {
	defer conn.Close()
	kinproxy.ApplyTCPKeepAlive(conn)
	dest, err := OriginalDst(conn)
	if err != nil {
		log.Printf("kin-egress original dest: %v", err)
		return
	}
	// A direct probe has no REDIRECT target: forwarding it through a local
	// SOCKS proxy would connect back here and recursively create new sockets.
	if dest == conn.LocalAddr().String() {
		log.Printf("kin-egress refuse self-destined conn from %s dest=%s", conn.RemoteAddr(), dest)
		return
	}
	if err = s.ForwardTCP(ctx, conn, dest); err != nil {
		log.Printf("kin-egress %v", err)
	}
}

func (s *Server) ForwardTCP(ctx context.Context, client net.Conn, dest string) error {
	client, err := consumeOAuthBlock(client, dest)
	if err != nil {
		return err
	}
	rt := s.rt()
	dialDest, err := s.dialDestFor(rt, dest)
	if err != nil {
		return err
	}
	ex, err := rt.exitForConn(client)
	if err != nil {
		return &spliceError{class: classNoRoute, dest: dialDest, err: err}
	}
	up, err := ex.dialer.DialContext(ctx, "tcp", dialDest)
	if err != nil {
		return &spliceError{class: classSocksDial, dest: dialDest, err: err}
	}
	defer up.Close()
	kinproxy.ApplyTCPKeepAlive(client)
	kinproxy.ApplyTCPKeepAlive(up)
	return spliceIdle(client, up, dialDest, IdleClose)
}

func splice(a, b net.Conn) error {
	return spliceIdle(a, b, "", IdleClose)
}

func spliceIdle(a, b net.Conn, dest string, idle time.Duration) error {
	defer func() {
		_ = a.Close()
		_ = b.Close()
	}()
	arm := func() {
		if idle <= 0 {
			return
		}
		deadline := time.Now().Add(idle)
		_ = a.SetReadDeadline(deadline)
		_ = b.SetReadDeadline(deadline)
	}
	arm()
	var wg sync.WaitGroup
	errCh := make(chan error, 2)
	copyOne := func(dst, src net.Conn) {
		defer wg.Done()
		buf := make([]byte, 32*1024)
		var err error
		for {
			var n int
			n, err = src.Read(buf)
			if n > 0 {
				arm()
				if _, werr := dst.Write(buf[:n]); werr != nil {
					err = werr
					break
				}
			}
			if err != nil {
				break
			}
		}
		if tcp, ok := dst.(*net.TCPConn); ok {
			_ = tcp.CloseWrite()
		} else {
			_ = dst.Close()
		}
		errCh <- err
	}
	wg.Add(2)
	go copyOne(a, b)
	go copyOne(b, a)
	wg.Wait()
	close(errCh)
	var errs []error
	for err := range errCh {
		errs = append(errs, err)
	}
	return classifySplice(dest, errs)
}

func isIdleTimeout(err error) bool {
	if errors.Is(err, os.ErrDeadlineExceeded) {
		return true
	}
	var ne net.Error
	return errors.As(err, &ne) && ne.Timeout()
}

func isBenignSpliceEnd(err error) bool {
	if err == nil || errors.Is(err, io.EOF) || errors.Is(err, io.ErrClosedPipe) || errors.Is(err, net.ErrClosed) {
		return true
	}
	msg := err.Error()
	return strings.Contains(msg, "closed pipe") || strings.Contains(msg, "use of closed network connection")
}

func classifySplice(dest string, errs []error) error {
	var firstBad error
	for _, err := range errs {
		if isIdleTimeout(err) {
			return &spliceError{class: classIdleClose, dest: dest, err: err}
		}
		if isBenignSpliceEnd(err) {
			continue
		}
		if firstBad == nil {
			firstBad = err
		}
	}
	if firstBad == nil {
		return nil
	}
	return &spliceError{class: classSpliceRST, dest: dest, err: firstBad}
}

const dnsMaxUDPSize = 65535

func (s *Server) serveDNS(ctx context.Context, ln net.PacketConn) {
	buf := make([]byte, dnsMaxUDPSize)
	for {
		_ = ln.SetReadDeadline(time.Now().Add(2 * time.Second))
		n, addr, err := ln.ReadFrom(buf)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			if ne, ok := err.(net.Error); ok && ne.Timeout() {
				continue
			}
			return
		}
		query := make([]byte, n)
		copy(query, buf[:n])
		select {
		case s.dnsSlots <- struct{}{}:
			go func() {
				defer func() { <-s.dnsSlots }()
				s.handleDNS(ctx, ln, addr, query)
			}()
		default:
			if servfail, ok := dnsServFail(query); ok {
				_, _ = ln.WriteTo(servfail, addr)
			}
		}
	}
}

func (s *Server) serveDNSTCP(ctx context.Context, ln net.Listener) {
	for {
		conn, err := ln.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			return
		}
		go s.handleDNSTCP(ctx, conn)
	}
}

func (s *Server) handleDNS(ctx context.Context, ln net.PacketConn, addr net.Addr, query []byte) {
	reply, err := s.ResolveDNSFrom(ctx, query, addr)
	if err != nil {
		log.Printf("kin-egress dns: %v", err)
		if ctx.Err() != nil {
			return
		}
		// SERVFAIL rather than silence: a refused source learns its resolver
		// failed instead of waiting out its own timeout, and the reply carries
		// no address either way.
		servfail, ok := dnsServFail(query)
		if !ok {
			return
		}
		reply = servfail
	}
	_, _ = ln.WriteTo(reply, addr)
}

func (s *Server) handleDNSTCP(ctx context.Context, conn net.Conn) {
	defer conn.Close()
	// Resolvers pipeline A and AAAA, or reuse the TCP connection. One reply
	// per accept drops the second query as EOF / reset.
	for ctx.Err() == nil {
		if err := conn.SetDeadline(time.Now().Add(10 * time.Second)); err != nil {
			return
		}
		var hdr [2]byte
		if _, err := io.ReadFull(conn, hdr[:]); err != nil {
			return
		}
		n := int(binary.BigEndian.Uint16(hdr[:]))
		if n <= 0 || n > 65535 {
			return
		}
		query := make([]byte, n)
		if _, err := io.ReadFull(conn, query); err != nil {
			return
		}
		// Upstream attempts carry their own timeout. A client deadline left
		// running here expires during lookup and the reply is never written.
		if err := conn.SetDeadline(time.Time{}); err != nil {
			return
		}
		reply, err := s.ResolveDNSFrom(ctx, query, conn.RemoteAddr())
		if err != nil {
			log.Printf("kin-egress dns tcp: %v", err)
			if ctx.Err() != nil {
				return
			}
			servfail, ok := dnsServFail(query)
			if !ok {
				return
			}
			reply = servfail
		}
		if err := conn.SetDeadline(time.Now().Add(10 * time.Second)); err != nil {
			return
		}
		if err := writeDNSFrame(conn, reply); err != nil {
			return
		}
	}
}

func writeDNSFrame(conn net.Conn, reply []byte) error {
	if len(reply) == 0 || len(reply) > 65535 {
		return fmt.Errorf("dns tcp reply length %d", len(reply))
	}
	out := make([]byte, 2+len(reply))
	binary.BigEndian.PutUint16(out[:2], uint16(len(reply)))
	copy(out[2:], reply)
	_, err := conn.Write(out)
	return err
}

func dnsServFail(query []byte) ([]byte, bool) {
	var msg dnsmessage.Message
	if err := msg.Unpack(query); err != nil {
		return nil, false
	}
	reply := dnsmessage.Message{
		Header: dnsmessage.Header{
			ID: msg.ID, Response: true, OpCode: msg.OpCode,
			RecursionDesired: msg.RecursionDesired, RecursionAvailable: true,
			RCode: dnsmessage.RCodeServerFailure,
		},
		Questions: msg.Questions,
	}
	packed, err := reply.Pack()
	if err != nil {
		return nil, false
	}
	return packed, true
}

// ResolveDNS answers from the helper's single exit.
//
// It is only valid while no routes are configured. A shared helper has no
// default answer to give, and resolving one here would be the bypass the route
// table exists to prevent — an exported entry point that reaches rt.def
// regardless of who asked. Shared helpers use ResolveDNSFrom.
func (s *Server) ResolveDNS(ctx context.Context, query []byte) ([]byte, error) {
	rt := s.rt()
	if len(rt.routes) > 0 {
		return nil, fmt.Errorf("resolve without a source address while %d routes are configured", len(rt.routes))
	}
	return s.resolveVia(ctx, rt, rt.def, query)
}

// ResolveDNSFrom answers a query using the exit that owns src.
//
// With routes configured an unknown source gets no answer at all. Serving it
// from the default exit would return addresses that VM's traffic cannot reach,
// and would tell it what another VM's exit resolves — the same leak the TCP
// path refuses, in the form that is easier to miss because a wrong answer still
// looks like a working resolver.
func (s *Server) ResolveDNSFrom(ctx context.Context, query []byte, src net.Addr) ([]byte, error) {
	rt := s.rt()
	if len(rt.routes) == 0 {
		return s.resolveVia(ctx, rt, rt.def, query)
	}
	addr, err := addrSource(src)
	if err != nil {
		return nil, err
	}
	ex, err := rt.exitFor(addr)
	if err != nil {
		return nil, err
	}
	return s.resolveVia(ctx, rt, ex, query)
}

// resolveVia applies the helper's DNS policy, then answers from one exit's
// cache and upstreams. Policy is helper-wide; the cache is not.
func (s *Server) resolveVia(ctx context.Context, rt *runtime, ex *exit, query []byte) ([]byte, error) {
	if len(rt.cfg.DNSEmptyTypes) > 0 {
		var msg dnsmessage.Message
		if err := msg.Unpack(query); err != nil {
			return nil, fmt.Errorf("decode DNS query for override: %w", err)
		}
		if msg.Response || msg.OpCode != 0 || len(msg.Questions) == 0 {
			return nil, fmt.Errorf("DNS override requires a standard query with questions")
		}
		blocked := 0
		for _, question := range msg.Questions {
			if slices.Contains(rt.cfg.DNSEmptyTypes, uint16(question.Type)) {
				blocked++
			}
		}
		if blocked > 0 {
			reply := dnsmessage.Message{
				Header: dnsmessage.Header{
					ID: msg.ID, Response: true, RecursionDesired: msg.RecursionDesired,
					RecursionAvailable: true, CheckingDisabled: msg.CheckingDisabled,
				},
				Questions: msg.Questions,
			}
			// Mixed questions cannot be forwarded without leaking an overridden type.
			if blocked != len(msg.Questions) {
				reply.RCode = dnsmessage.RCodeFormatError
			}
			return reply.Pack()
		}
	}
	parsed, key, cacheable := dnsQueryKey(query)
	cacheable = cacheable && !rt.cfg.DNSCacheDisabled
	if cacheable {
		if reply, stale, ok := ex.cache.lookup(key, parsed, time.Now()); ok {
			if stale {
				s.startDNSRefresh(ex, key, parsed.ID, query)
			}
			s.observeDNS(rt, reply)
			return reply, nil
		}
	}
	reply, err := ex.resolveUpstream(ctx, query)
	if err != nil {
		return nil, err
	}
	if cacheable {
		ex.cache.store(key, parsed.ID, reply, time.Now())
	}
	s.observeDNS(rt, reply)
	return reply, nil
}

func (s *Server) observeDNS(rt *runtime, reply []byte) {
	if rt.cfg.DomainForward && s.rt() == rt {
		s.domains.observe(reply, time.Now())
	}
}

func (s *Server) startDNSRefresh(ex *exit, key dnsCacheKey, queryID uint16, query []byte) {
	select {
	case s.dnsSlots <- struct{}{}:
	default:
		return
	}
	if !ex.cache.beginRefresh(key) {
		<-s.dnsSlots
		return
	}
	query = bytes.Clone(query)
	go func() {
		defer func() { <-s.dnsSlots }()
		defer ex.cache.endRefresh(key)
		ctx, cancel := context.WithTimeout(context.Background(), dnsRefreshTimeout)
		defer cancel()
		// The refresh goes back out of the exit that cached the entry, so a
		// stale answer is never replaced by one from another VM's upstream.
		reply, err := ex.resolveUpstream(ctx, query)
		if err != nil {
			log.Printf("kin-egress dns refresh %s: %v", key.name, err)
			return
		}
		ex.cache.store(key, queryID, reply, time.Now())
	}()
}

func (e *exit) resolveUpstream(ctx context.Context, query []byte) ([]byte, error) {
	n := len(e.upstreams)
	start := int(e.preferred.Load())
	var errs []error
	for i := 0; i < n; i++ {
		idx := (start + i) % n
		upstream := e.upstreams[idx]
		attemptCtx, cancel := context.WithTimeout(ctx, dnsAttemptTimeout)
		reply, err := e.resolveOne(attemptCtx, upstream, query)
		cancel()
		if err == nil {
			if idx != start {
				e.preferred.Store(int32(idx))
				log.Printf("kin-egress dns upstream switched to %s", upstream)
			}
			return reply, nil
		}
		errs = append(errs, fmt.Errorf("%s: %w", upstream, err))
		if ctx.Err() != nil {
			break
		}
	}
	return nil, errors.Join(errs...)
}

func (e *exit) resolveOne(ctx context.Context, upstream string, query []byte) ([]byte, error) {
	if strings.HasPrefix(upstream, "https://") || strings.HasPrefix(upstream, "http://") {
		return e.resolveDoH(ctx, upstream, query)
	}
	return e.resolveDNSTCP(ctx, upstream, query)
}

func (e *exit) resolveDoH(ctx context.Context, upstream string, query []byte) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, upstream, bytes.NewReader(query))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/dns-message")
	req.Header.Set("Accept", "application/dns-message")
	resp, err := e.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("doh status %s", resp.Status)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 65535))
	if err != nil {
		return nil, err
	}
	if len(body) < 12 {
		return nil, fmt.Errorf("doh short reply %d", len(body))
	}
	return body, nil
}

func (e *exit) resolveDNSTCP(ctx context.Context, upstream string, query []byte) ([]byte, error) {
	up, err := e.dialer.DialContext(ctx, "tcp", upstream)
	if err != nil {
		return nil, err
	}
	defer up.Close()
	deadline := time.Now().Add(10 * time.Second)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	_ = up.SetDeadline(deadline)
	frame := make([]byte, 2+len(query))
	binary.BigEndian.PutUint16(frame[:2], uint16(len(query)))
	copy(frame[2:], query)
	if _, err = up.Write(frame); err != nil {
		return nil, err
	}
	var hdr [2]byte
	if _, err = io.ReadFull(up, hdr[:]); err != nil {
		return nil, err
	}
	size := int(binary.BigEndian.Uint16(hdr[:]))
	if size <= 0 || size > 65535 {
		return nil, fmt.Errorf("bad dns tcp length %d", size)
	}
	body := make([]byte, size)
	if _, err = io.ReadFull(up, body); err != nil {
		return nil, err
	}
	return body, nil
}
