package proxy

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/base64"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// bufferedTunnel preserves tunnel bytes read alongside the CONNECT response.
type bufferedTunnel struct {
	net.Conn
	reader *bufio.Reader
}

func (c *bufferedTunnel) Read(p []byte) (int, error) { return c.reader.Read(p) }

func (c *bufferedTunnel) CloseWrite() error {
	if half, ok := c.Conn.(interface{ CloseWrite() error }); ok {
		return half.CloseWrite()
	}
	return c.Conn.Close()
}

func (d *Dialer) dialHTTP(ctx context.Context, address string) (net.Conn, error) {
	handshakeCtx, cancel := context.WithTimeout(ctx, d.Timeout)
	defer cancel()
	raw, err := (&net.Dialer{Timeout: d.Timeout}).DialContext(handshakeCtx, "tcp", d.Address)
	if err != nil {
		return nil, fmt.Errorf("connect proxy: %w", err)
	}
	ApplyTCPKeepAlive(raw)
	conn := raw
	ok := false
	defer func() {
		if !ok {
			_ = raw.Close()
		}
	}()
	deadline, _ := handshakeCtx.Deadline()
	_ = raw.SetDeadline(deadline)
	// Synchronize cancellation before clearing deadlines for the returned tunnel.
	stopped := make(chan struct{})
	stop := context.AfterFunc(handshakeCtx, func() { _ = raw.SetDeadline(time.Now()); close(stopped) })
	var stopOnce sync.Once
	stopCancellation := func() {
		stopOnce.Do(func() {
			if !stop() {
				<-stopped
			}
		})
	}
	defer stopCancellation()
	if d.Scheme == "https" {
		host, _, _ := net.SplitHostPort(d.Address)
		cfg := &tls.Config{MinVersion: tls.VersionTLS12, ServerName: host, NextProtos: []string{"http/1.1"}}
		if d.tlsConfig != nil {
			cfg = d.tlsConfig.Clone()
			cfg.ServerName = host
			cfg.NextProtos = []string{"http/1.1"}
		}
		secure := tls.Client(raw, cfg)
		if err := secure.HandshakeContext(handshakeCtx); err != nil {
			return nil, fmt.Errorf("proxy TLS handshake: %w", err)
		}
		conn = secure
	}
	req := &http.Request{Method: http.MethodConnect, URL: &url.URL{Opaque: address}, Host: address, Header: make(http.Header)}
	if d.Username != "" {
		req.Header.Set("Proxy-Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(d.Username+":"+d.Password)))
	}
	if err := req.Write(conn); err != nil {
		return nil, fmt.Errorf("write proxy CONNECT: %w", err)
	}
	reader := bufio.NewReader(conn)
	// Bound untrusted response headers without imposing a limit on tunnel data.
	var header strings.Builder
	for {
		line, err := reader.ReadSlice('\n')
		if err != nil {
			return nil, fmt.Errorf("read proxy CONNECT: %w", err)
		}
		if header.Len()+len(line) > 32768 {
			return nil, fmt.Errorf("proxy CONNECT response headers too large")
		}
		header.Write(line)
		if string(line) == "\r\n" {
			break
		}
	}
	response, err := http.ReadResponse(bufio.NewReader(strings.NewReader(header.String())), req)
	if err != nil {
		return nil, fmt.Errorf("invalid proxy CONNECT response: %w", err)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		if response.StatusCode == http.StatusProxyAuthRequired {
			return nil, fmt.Errorf("proxy authentication rejected (407)")
		}
		return nil, fmt.Errorf("proxy CONNECT rejected (%d)", response.StatusCode)
	}
	stopCancellation()
	if err := handshakeCtx.Err(); err != nil {
		return nil, err
	}
	_ = raw.SetDeadline(time.Time{})
	ok = true
	return &bufferedTunnel{Conn: conn, reader: reader}, nil
}
