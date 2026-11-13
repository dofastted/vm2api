package proxy

import (
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
)

// maxConnectResponse bounds the HTTP CONNECT response head we are willing to read.
const maxConnectResponse = 16 << 10

func (d *Dialer) kind() string {
	if d.HTTP {
		return "HTTP"
	}
	return "SOCKS5"
}

// httpConnect opens a CONNECT tunnel to target. The response head is read one
// byte at a time so no tunnelled bytes are consumed past the blank line.
func (d *Dialer) httpConnect(conn net.Conn, target string) error {
	if _, _, err := net.SplitHostPort(target); err != nil {
		return fmt.Errorf("split target address: %w", err)
	}
	var b strings.Builder
	fmt.Fprintf(&b, "CONNECT %s HTTP/1.1\r\nHost: %s\r\n", target, target)
	if d.Username != "" || d.Password != "" {
		token := base64.StdEncoding.EncodeToString([]byte(d.Username + ":" + d.Password))
		fmt.Fprintf(&b, "Proxy-Authorization: Basic %s\r\n", token)
	}
	b.WriteString("\r\n")
	if _, err := io.WriteString(conn, b.String()); err != nil {
		return fmt.Errorf("write HTTP CONNECT: %w", err)
	}
	head, err := readResponseHead(conn)
	if err != nil {
		return fmt.Errorf("read HTTP CONNECT response: %w", err)
	}
	statusLine, _, _ := strings.Cut(head, "\r\n")
	fields := strings.Fields(statusLine)
	if len(fields) < 2 || !strings.HasPrefix(fields[0], "HTTP/") {
		return fmt.Errorf("not an HTTP proxy: unexpected response %q", truncate(statusLine, 64))
	}
	code, err := strconv.Atoi(fields[1])
	if err != nil {
		return fmt.Errorf("not an HTTP proxy: bad status %q", truncate(statusLine, 64))
	}
	switch {
	case code >= 200 && code < 300:
		return nil
	case code == 407:
		return errors.New("HTTP proxy authentication failed (407)")
	default:
		return fmt.Errorf("HTTP CONNECT failed: %s", truncate(statusLine, 128))
	}
}

func readResponseHead(r io.Reader) (string, error) {
	buf := make([]byte, 0, 256)
	one := make([]byte, 1)
	for len(buf) < maxConnectResponse {
		if _, err := io.ReadFull(r, one); err != nil {
			return "", err
		}
		buf = append(buf, one[0])
		if len(buf) == 1 && buf[0] != 'H' {
			return "", fmt.Errorf("not an HTTP proxy: first byte 0x%02x", buf[0])
		}
		if len(buf) >= 4 && string(buf[len(buf)-4:]) == "\r\n\r\n" {
			return string(buf), nil
		}
	}
	return "", errors.New("response head exceeds 16 KiB")
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}
