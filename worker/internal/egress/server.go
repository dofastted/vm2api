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
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	kinproxy "github.com/dofastted/kin-gateway/worker/internal/proxy"
)

type Config struct {
	ProxyID     string `json:"proxy_id"`
	ProxyURL    string `json:"proxy_url"`
	ListenTCP   string `json:"listen_tcp"`
	ListenDNS   string `json:"listen_dns"`
	DNSUpstream string `json:"dns_upstream"`
}

// IdleClose is how long a splice may sit with no bytes before both sides
// close. Below residential NAT (~15m). Tests call spliceIdle with a shorter idle.
const IdleClose = 7 * time.Minute

const (
	classIdleClose = "idle_close"
	classSpliceRST = "splice_rst"
	classSocksDial = "socks_dial"
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
	cfg       Config
	dialer    *kinproxy.Dialer
	http      *http.Client
	upstreams []string
	preferred atomic.Int32
}

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

func New(cfg Config) (*Server, error) {
	if cfg.ListenTCP == "" {
		return nil, fmt.Errorf("listen tcp address is required")
	}
	upstreams := parseDNSUpstreams(cfg.DNSUpstream)
	if len(upstreams) == 0 {
		upstreams = append([]string(nil), DefaultDNSUpstreams...)
	}
	dialer, err := kinproxy.New(cfg.ProxyURL, 15*time.Second)
	if err != nil {
		return nil, err
	}
	return &Server{
		cfg:       cfg,
		dialer:    dialer,
		upstreams: upstreams,
		http: &http.Client{
			Timeout: 10 * time.Second,
			Transport: &http.Transport{
				DialContext: dialer.DialContext,
			},
		},
	}, nil
}

func (s *Server) Serve(ctx context.Context) error {
	tcpLn, err := net.Listen("tcp", s.cfg.ListenTCP)
	if err != nil {
		return fmt.Errorf("listen tcp: %w", err)
	}
	defer tcpLn.Close()

	var dnsUDP net.PacketConn
	var dnsTCP net.Listener
	if s.cfg.ListenDNS != "" {
		dnsUDP, err = net.ListenPacket("udp", s.cfg.ListenDNS)
		if err != nil {
			return fmt.Errorf("listen dns udp: %w", err)
		}
		defer dnsUDP.Close()
		go s.serveDNS(ctx, dnsUDP)
		dnsTCP, err = net.Listen("tcp", s.cfg.ListenDNS)
		if err != nil {
			return fmt.Errorf("listen dns tcp: %w", err)
		}
		defer dnsTCP.Close()
		go s.serveDNSTCP(ctx, dnsTCP)
	}

	log.Printf("kin-egress ready proxy_id=%s tcp=%s dns=%s dns_upstreams=%s", s.cfg.ProxyID, s.cfg.ListenTCP, s.cfg.ListenDNS, strings.Join(s.upstreams, ","))
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
	up, err := s.dialer.DialContext(ctx, "tcp", dest)
	if err != nil {
		return &spliceError{class: classSocksDial, dest: dest, err: err}
	}
	defer up.Close()
	kinproxy.ApplyTCPKeepAlive(client)
	kinproxy.ApplyTCPKeepAlive(up)
	return spliceIdle(client, up, dest, IdleClose)
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

func (s *Server) serveDNS(ctx context.Context, ln net.PacketConn) {
	buf := make([]byte, 4096)
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
		go s.handleDNS(ctx, ln, addr, query)
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
	reply, err := s.ResolveDNS(ctx, query)
	if err != nil {
		log.Printf("kin-egress dns: %v", err)
		return
	}
	_, _ = ln.WriteTo(reply, addr)
}

func (s *Server) handleDNSTCP(ctx context.Context, conn net.Conn) {
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(10 * time.Second))
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
	reply, err := s.ResolveDNS(ctx, query)
	if err != nil {
		log.Printf("kin-egress dns tcp: %v", err)
		return
	}
	out := make([]byte, 2+len(reply))
	binary.BigEndian.PutUint16(out[:2], uint16(len(reply)))
	copy(out[2:], reply)
	_, _ = conn.Write(out)
}

// ResolveDNS tries each upstream in order, starting from the last one that
// succeeded, and returns the first valid reply.
func (s *Server) ResolveDNS(ctx context.Context, query []byte) ([]byte, error) {
	n := len(s.upstreams)
	start := int(s.preferred.Load())
	var errs []error
	for i := 0; i < n; i++ {
		idx := (start + i) % n
		upstream := s.upstreams[idx]
		attemptCtx, cancel := context.WithTimeout(ctx, dnsAttemptTimeout)
		reply, err := s.resolveOne(attemptCtx, upstream, query)
		cancel()
		if err == nil {
			if idx != start {
				s.preferred.Store(int32(idx))
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

func (s *Server) resolveOne(ctx context.Context, upstream string, query []byte) ([]byte, error) {
	if strings.HasPrefix(upstream, "https://") || strings.HasPrefix(upstream, "http://") {
		return s.resolveDoH(ctx, upstream, query)
	}
	return s.resolveDNSTCP(ctx, upstream, query)
}

func (s *Server) resolveDoH(ctx context.Context, upstream string, query []byte) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, upstream, bytes.NewReader(query))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/dns-message")
	req.Header.Set("Accept", "application/dns-message")
	resp, err := s.http.Do(req)
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

func (s *Server) resolveDNSTCP(ctx context.Context, upstream string, query []byte) ([]byte, error) {
	up, err := s.dialer.DialContext(ctx, "tcp", upstream)
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
