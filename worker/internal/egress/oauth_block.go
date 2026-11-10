package egress

import (
	"errors"
	"io"
	"net"
	"os"
	"time"
)

// OAuthBlockBanner is written by the CRAG child preload immediately after
// connect() to an OAuth token host. kin-egress closes that socket before
// dialing the upstream proxy, so the refresh request never leaves.
// Login and kin-oauth-auth do not write it; they still reach the token host.
const OAuthBlockBanner = "KIN-BLOCK\n"

const classOAuthTokenBlocked = "oauth_token_blocked"

func oauthBlockDest(dest string) bool {
	_, port, err := net.SplitHostPort(dest)
	return err == nil && port == "443"
}

// consumeOAuthBlock reads the CRAG marker when dest is TCP/443.
// A marked socket is not dialed. Any other prefix is returned for replay.
func consumeOAuthBlock(conn net.Conn, dest string) (net.Conn, error) {
	if !oauthBlockDest(dest) {
		return conn, nil
	}
	prefix, blocked, err := readOAuthBlock(conn)
	if blocked {
		return nil, &spliceError{class: classOAuthTokenBlocked, dest: dest, err: errors.New("CRAG OAuth refresh blocked")}
	}
	if len(prefix) > 0 {
		return &prefixConn{Conn: conn, buf: prefix}, err
	}
	return conn, err
}

func readOAuthBlock(conn net.Conn) ([]byte, bool, error) {
	_ = conn.SetReadDeadline(time.Now().Add(30 * time.Millisecond))
	defer conn.SetReadDeadline(time.Time{})
	buf := make([]byte, len(OAuthBlockBanner))
	n, err := conn.Read(buf[:1])
	if n == 0 {
		if err == nil || errors.Is(err, os.ErrDeadlineExceeded) || errors.Is(err, io.EOF) {
			return nil, false, nil
		}
		return nil, false, nil
	}
	if buf[0] != OAuthBlockBanner[0] {
		return append([]byte(nil), buf[:n]...), false, nil
	}
	for n < len(OAuthBlockBanner) {
		m, readErr := conn.Read(buf[n:])
		n += m
		if readErr != nil {
			return append([]byte(nil), buf[:n]...), false, nil
		}
	}
	if string(buf[:n]) == OAuthBlockBanner {
		return nil, true, nil
	}
	return append([]byte(nil), buf[:n]...), false, nil
}

type prefixConn struct {
	net.Conn
	buf []byte
}

func (c *prefixConn) Read(p []byte) (int, error) {
	if len(c.buf) == 0 {
		return c.Conn.Read(p)
	}
	n := copy(p, c.buf)
	c.buf = c.buf[n:]
	return n, nil
}
