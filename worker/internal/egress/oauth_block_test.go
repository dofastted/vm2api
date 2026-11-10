package egress

import (
	"errors"
	"io"
	"net"
	"testing"
	"time"
)

func TestOAuthBlockBannerIsNotAPrefixOfTLS(t *testing.T) {
	if OAuthBlockBanner[0] == 0x16 {
		t.Fatal("marker collides with a TLS handshake record")
	}
}

func TestConsumeOAuthBlockDropsMarked443(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	done := make(chan error, 1)
	go func() {
		_, err := client.Write([]byte(OAuthBlockBanner))
		done <- err
	}()
	got, err := consumeOAuthBlock(server, "203.0.113.10:443")
	if err == nil {
		t.Fatal("marked token connect was forwarded")
	}
	var splice *spliceError
	if !errors.As(err, &splice) || splice.class != classOAuthTokenBlocked {
		t.Fatalf("err=%v", err)
	}
	if got != nil {
		t.Fatal("blocked conn was returned")
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("writer did not finish")
	}
}

func TestConsumeOAuthBlockReplaysOrdinary443(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	payload := []byte{0x16, 0x03, 0x01, 0x00, 0x05}
	go func() { _, _ = client.Write(payload) }()
	got, err := consumeOAuthBlock(server, "203.0.113.10:443")
	if err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, len(payload))
	_ = got.SetReadDeadline(time.Now().Add(time.Second))
	if _, err = io.ReadFull(got, buf); err != nil {
		t.Fatal(err)
	}
	if string(buf) != string(payload) {
		t.Fatalf("replay=%x", buf)
	}
}

func TestConsumeOAuthBlockIgnoresOtherPorts(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()
	got, err := consumeOAuthBlock(server, "203.0.113.10:80")
	if err != nil {
		t.Fatal(err)
	}
	if got != server {
		t.Fatal("non-443 connect was inspected")
	}
}
