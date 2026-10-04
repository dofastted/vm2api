package proxy

import (
	"bufio"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
)

// bufferedConn keeps any tunnel bytes received alongside the CONNECT headers.
type bufferedConn struct {
	net.Conn
	reader *bufio.Reader
}

func (c *bufferedConn) Read(p []byte) (int, error) { return c.reader.Read(p) }

func (d *Dialer) connectHTTP(conn net.Conn, target string) (net.Conn, error) {
	req := &http.Request{
		Method: http.MethodConnect, URL: &url.URL{Opaque: target}, Host: target,
		Header: make(http.Header),
	}
	if d.Username != "" || d.Password != "" {
		auth := base64.StdEncoding.EncodeToString([]byte(d.Username + ":" + d.Password))
		req.Header.Set("Proxy-Authorization", "Basic "+auth)
	}
	if err := req.Write(conn); err != nil {
		return nil, fmt.Errorf("write HTTP CONNECT: %w", err)
	}
	reader := bufio.NewReader(conn)
	// Bound response headers while leaving following tunnel bytes in the reader.
	var headers strings.Builder
	for {
		line, err := reader.ReadSlice('\n')
		if err != nil {
			return nil, fmt.Errorf("read HTTP CONNECT: %w", err)
		}
		if headers.Len()+len(line) > 16384 {
			return nil, errors.New("HTTP CONNECT headers too large")
		}
		headers.Write(line)
		if string(line) == "\r\n" {
			break
		}
	}
	response, err := http.ReadResponse(bufio.NewReader(strings.NewReader(headers.String())), req)
	if err != nil {
		return nil, errors.New("invalid HTTP CONNECT response")
	}
	if response.StatusCode != http.StatusOK {
		// Never include the response body/reason: proxies may echo credentials there.
		return nil, fmt.Errorf("HTTP CONNECT proxy returned status %d", response.StatusCode)
	}
	if reader.Buffered() > 0 {
		return &bufferedConn{Conn: conn, reader: reader}, nil
	}
	return conn, nil
}
