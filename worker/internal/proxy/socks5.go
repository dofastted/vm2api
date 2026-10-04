package proxy

import (
	"context"
	"crypto/tls"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type Dialer struct {
	Scheme   string
	Address  string
	Username string
	Password string
	Timeout  time.Duration
}

func New(rawURL string, timeout time.Duration) (*Dialer, error) {
	u, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil {
		return nil, errors.New("invalid proxy URL")
	}
	if u.Scheme != "socks5" && u.Scheme != "socks5h" && u.Scheme != "http" && u.Scheme != "https" {
		return nil, fmt.Errorf("unsupported proxy scheme %q", u.Scheme)
	}
	if (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
		return nil, errors.New("proxy URL must contain only host, port and optional credentials")
	}
	host := u.Hostname()
	port := u.Port()
	if port == "" && u.Scheme == "http" {
		port = "80"
	}
	if port == "" && u.Scheme == "https" {
		port = "443"
	}
	n, portErr := strconv.Atoi(port)
	if host == "" || portErr != nil || n < 1 || n > 65535 {
		return nil, errors.New("proxy URL requires a valid host and port")
	}
	username := ""
	password := ""
	if u.User != nil {
		username = u.User.Username()
		password, _ = u.User.Password()
	}
	if strings.ContainsAny(username+password, "\r\n") || ((u.Scheme == "http" || u.Scheme == "https") && strings.Contains(username, ":")) {
		return nil, errors.New("invalid proxy credentials")
	}
	if (u.Scheme == "socks5" || u.Scheme == "socks5h") && (len(username) > 255 || len(password) > 255) {
		return nil, errors.New("SOCKS5 username/password exceeds 255 bytes")
	}
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	return &Dialer{
		Scheme:   u.Scheme,
		Address:  net.JoinHostPort(host, port),
		Username: username,
		Password: password,
		Timeout:  timeout,
	}, nil
}

func (d *Dialer) DialContext(ctx context.Context, network, address string) (net.Conn, error) {
	if d == nil {
		return nil, errors.New("SOCKS5 dialer is nil")
	}
	if network != "tcp" && network != "tcp4" && network != "tcp6" {
		return nil, fmt.Errorf("SOCKS5 only supports TCP, got %q", network)
	}
	if sameHostPort(address, d.Address) {
		return nil, fmt.Errorf("refusing SOCKS CONNECT to the proxy address %s; DialContext must receive the upstream host", d.Address)
	}
	if d.Scheme == "http" || d.Scheme == "https" {
		if _, _, err := net.SplitHostPort(address); err != nil || strings.ContainsAny(address, "\r\n\t /@?#") {
			return nil, errors.New("invalid HTTP CONNECT target")
		}
	}
	base := &net.Dialer{Timeout: d.Timeout}
	conn, err := base.DialContext(ctx, "tcp", d.Address)
	if err != nil {
		return nil, fmt.Errorf("connect proxy: %w", err)
	}
	ok := false
	defer func() {
		if !ok {
			_ = conn.Close()
		}
	}()
	rawConn := conn
	ApplyTCPKeepAlive(rawConn)
	stopCancel := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			_ = rawConn.SetDeadline(time.Now())
		case <-stopCancel:
		}
	}()
	defer close(stopCancel)
	deadline := time.Now().Add(d.Timeout)
	if ctxDeadline, has := ctx.Deadline(); has && ctxDeadline.Before(deadline) {
		deadline = ctxDeadline
	}
	_ = conn.SetDeadline(deadline)
	if d.Scheme == "https" {
		host, _, _ := net.SplitHostPort(d.Address)
		secure := tls.Client(conn, &tls.Config{ServerName: host, MinVersion: tls.VersionTLS12})
		if err = secure.HandshakeContext(ctx); err != nil {
			return nil, fmt.Errorf("HTTPS proxy TLS: %w", err)
		}
		conn = secure
	}
	if d.Scheme == "http" || d.Scheme == "https" {
		var tunnel net.Conn
		tunnel, err = d.connectHTTP(conn, address)
		if err == nil {
			conn = tunnel
		}
	} else {
		err = d.negotiate(conn, address)
	}
	if err != nil {
		return nil, err
	}
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	_ = conn.SetDeadline(time.Time{})
	ApplyTCPKeepAlive(conn)
	ok = true
	return conn, nil
}

func (d *Dialer) negotiate(conn net.Conn, target string) error {
	methods := []byte{0x00}
	if d.Username != "" || d.Password != "" {
		methods = append(methods, 0x02)
	}
	greeting := append([]byte{0x05, byte(len(methods))}, methods...)
	if _, err := conn.Write(greeting); err != nil {
		return fmt.Errorf("write SOCKS5 greeting: %w", err)
	}
	reply := make([]byte, 2)
	if _, err := io.ReadFull(conn, reply); err != nil {
		return fmt.Errorf("read SOCKS5 greeting: %w", err)
	}
	if reply[0] != 0x05 {
		return fmt.Errorf("unexpected SOCKS version %d", reply[0])
	}
	switch reply[1] {
	case 0x00:
	case 0x02:
		if err := d.authenticate(conn); err != nil {
			return err
		}
	case 0xff:
		return errors.New("SOCKS5 proxy rejected all authentication methods")
	default:
		return fmt.Errorf("unsupported SOCKS5 authentication method %d", reply[1])
	}
	request, err := connectRequest(target)
	if err != nil {
		return err
	}
	if _, err = conn.Write(request); err != nil {
		return fmt.Errorf("write SOCKS5 connect: %w", err)
	}
	header := make([]byte, 4)
	if _, err = io.ReadFull(conn, header); err != nil {
		return fmt.Errorf("read SOCKS5 connect header: %w", err)
	}
	if header[0] != 0x05 {
		return fmt.Errorf("unexpected SOCKS version %d", header[0])
	}
	if header[1] != 0x00 {
		return fmt.Errorf("SOCKS5 connect failed: %s", replyMessage(header[1]))
	}
	if err = discardAddress(conn, header[3]); err != nil {
		return fmt.Errorf("read SOCKS5 bound address: %w", err)
	}
	return nil
}

func (d *Dialer) authenticate(conn net.Conn) error {
	user := []byte(d.Username)
	pass := []byte(d.Password)
	request := make([]byte, 0, 3+len(user)+len(pass))
	request = append(request, 0x01, byte(len(user)))
	request = append(request, user...)
	request = append(request, byte(len(pass)))
	request = append(request, pass...)
	if _, err := conn.Write(request); err != nil {
		return fmt.Errorf("write SOCKS5 authentication: %w", err)
	}
	reply := make([]byte, 2)
	if _, err := io.ReadFull(conn, reply); err != nil {
		return fmt.Errorf("read SOCKS5 authentication: %w", err)
	}
	if reply[1] != 0x00 {
		return errors.New("SOCKS5 authentication failed")
	}
	return nil
}

func connectRequest(target string) ([]byte, error) {
	host, portRaw, err := net.SplitHostPort(target)
	if err != nil {
		return nil, fmt.Errorf("split target address: %w", err)
	}
	port, err := strconv.Atoi(portRaw)
	if err != nil || port < 1 || port > 65535 {
		return nil, fmt.Errorf("invalid target port %q", portRaw)
	}
	request := []byte{0x05, 0x01, 0x00}
	if ip := net.ParseIP(host); ip != nil {
		if v4 := ip.To4(); v4 != nil {
			request = append(request, 0x01)
			request = append(request, v4...)
		} else {
			request = append(request, 0x04)
			request = append(request, ip.To16()...)
		}
	} else {
		if len(host) == 0 || len(host) > 255 {
			return nil, errors.New("target hostname must contain 1-255 bytes")
		}
		request = append(request, 0x03, byte(len(host)))
		request = append(request, host...)
	}
	portBytes := make([]byte, 2)
	binary.BigEndian.PutUint16(portBytes, uint16(port))
	request = append(request, portBytes...)
	return request, nil
}

func discardAddress(reader io.Reader, addressType byte) error {
	var length int
	switch addressType {
	case 0x01:
		length = 4
	case 0x04:
		length = 16
	case 0x03:
		size := make([]byte, 1)
		if _, err := io.ReadFull(reader, size); err != nil {
			return err
		}
		length = int(size[0])
	default:
		return fmt.Errorf("unknown SOCKS5 address type %d", addressType)
	}
	_, err := io.CopyN(io.Discard, reader, int64(length+2))
	return err
}

func replyMessage(code byte) string {
	switch code {
	case 0x01:
		return "general failure"
	case 0x02:
		return "connection not allowed"
	case 0x03:
		return "network unreachable"
	case 0x04:
		return "host unreachable"
	case 0x05:
		return "connection refused"
	case 0x06:
		return "TTL expired"
	case 0x07:
		return "command not supported"
	case 0x08:
		return "address type not supported"
	default:
		return fmt.Sprintf("error code %d", code)
	}
}

func sameHostPort(left, right string) bool {
	hostA, portA, errA := net.SplitHostPort(left)
	hostB, portB, errB := net.SplitHostPort(right)
	if errA != nil || errB != nil {
		return left == right
	}
	return hostA == hostB && portA == portB
}
