package slotgate

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/pem"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const testToken = "0123456789abcdef0123456789abcdef"

// Unix socket paths are capped near 104 bytes, so the tree lives in a short /tmp dir.
func shortRoot(t *testing.T) string {
	t.Helper()
	base := os.Getenv("VM2API_SLOTGATE_TEST_ROOT")
	if base == "" {
		base = "/tmp"
	}
	dir, err := os.MkdirTemp(base, "ksg")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return dir
}

// slotSocket serves an upper-casing echo that half-closes after the client does.
func slotSocket(t *testing.T, root, vm, name string) {
	t.Helper()
	dir := filepath.Join(root, "vms", vm, "run")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("unix", filepath.Join(dir, name))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				data, _ := io.ReadAll(c)
				c.Write([]byte(strings.ToUpper(string(data))))
			}()
		}
	}()
}

func certFingerprint(t *testing.T, root string) [32]byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(root, "tls", "cert.pem"))
	if err != nil {
		t.Fatal(err)
	}
	block, _ := pem.Decode(data)
	return sha256.Sum256(block.Bytes)
}

func startGate(t *testing.T, root string) string {
	t.Helper()
	srv, err := New(Config{Listen: "127.0.0.1:0", Root: root, Token: testToken, TLSDir: filepath.Join(root, "tls")})
	if err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		srv.ServeListener(ctx, tls.NewListener(ln, srv.TLSConfig()))
		close(done)
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})
	testRoot[ln.Addr().String()] = root
	return ln.Addr().String()
}

var testRoot = map[string]string{}

// dialGate pins the gate's certificate the way the control plane does.
func dialGate(t *testing.T, addr, preface string) (net.Conn, *bufio.Reader, string) {
	t.Helper()
	want := certFingerprint(t, testRoot[addr])
	c, err := tls.DialWithDialer(&net.Dialer{Timeout: 2 * time.Second}, "tcp", addr, &tls.Config{
		InsecureSkipVerify: true,
		MinVersion:         tls.VersionTLS13,
		VerifyConnection: func(cs tls.ConnectionState) error {
			if got := sha256.Sum256(cs.PeerCertificates[0].Raw); !bytes.Equal(got[:], want[:]) {
				t.Errorf("gate certificate %x, pinned %x", got, want)
			}
			return nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	c.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err = io.WriteString(c, preface); err != nil {
		t.Fatal(err)
	}
	br := bufio.NewReader(c)
	reply, _ := br.ReadString('\n')
	return c, br, reply
}

func TestSplicesToSlotSocketWithHalfClose(t *testing.T) {
	root := shortRoot(t)
	slotSocket(t, root, "vm-1", "kernel.sock")
	addr := startGate(t, root)
	c, br, reply := dialGate(t, addr, "KSG1 "+testToken+" vm-1 kernel\n")
	if reply != "OK\n" {
		t.Fatalf("reply = %q", reply)
	}
	io.WriteString(c, "hello slot")
	c.(*tls.Conn).CloseWrite()
	got, err := io.ReadAll(br)
	if err != nil || string(got) != "HELLO SLOT" {
		t.Fatalf("got %q err %v", got, err)
	}
}

func TestRejectsBadPrefaces(t *testing.T) {
	root := shortRoot(t)
	slotSocket(t, root, "vm-1", "worker.sock")
	addr := startGate(t, root)
	for _, tc := range []struct{ preface, want string }{
		{"KSG1 wrong-token-wrong-token-wrong-token vm-1 worker\n", "ERR auth\n"},
		{"KSG1 " + testToken + " ../vm-1 worker\n", "ERR bad_request\n"},
		{"KSG1 " + testToken + " vm-1 docker\n", "ERR bad_request\n"},
		{"KSG0 " + testToken + " vm-1 worker\n", "ERR bad_request\n"},
		{"KSG1 " + testToken + " vm-2 worker\n", "ERR no_socket\n"},
		{"KSG1 " + testToken + " - ping\n", "OK\n"},
	} {
		if _, _, reply := dialGate(t, addr, tc.preface); reply != tc.want {
			t.Errorf("%q: reply %q, want %q", tc.preface, reply, tc.want)
		}
	}
}

func TestDoesNotFollowPlantedSymlink(t *testing.T) {
	root := shortRoot(t)
	slotSocket(t, root, "victim", "worker.sock")
	run := filepath.Join(root, "vms", "guest", "run")
	if err := os.MkdirAll(run, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, "vms", "victim", "run", "worker.sock"), filepath.Join(run, "worker.sock")); err != nil {
		t.Fatal(err)
	}
	addr := startGate(t, root)
	if _, _, reply := dialGate(t, addr, "KSG1 "+testToken+" guest worker\n"); reply != "ERR no_socket\n" {
		t.Fatalf("symlinked socket reply = %q", reply)
	}
}

func TestCertificateSurvivesRestartAndIsRecreatedWhenLost(t *testing.T) {
	root := shortRoot(t)
	cfg := Config{Listen: "127.0.0.1:1", Root: root, Token: testToken, TLSDir: filepath.Join(root, "tls")}
	if _, err := New(cfg); err != nil {
		t.Fatal(err)
	}
	first := certFingerprint(t, root)
	if st, _ := os.Stat(filepath.Join(root, "tls", "key.pem")); st.Mode().Perm() != 0o600 {
		t.Fatalf("key mode %v", st.Mode().Perm())
	}
	if _, err := New(cfg); err != nil {
		t.Fatal(err)
	}
	if certFingerprint(t, root) != first {
		t.Fatal("certificate changed across restart")
	}
	os.Remove(filepath.Join(root, "tls", "key.pem"))
	if _, err := New(cfg); err != nil {
		t.Fatal(err)
	}
	if certFingerprint(t, root) == first {
		t.Fatal("lost key did not produce a new certificate")
	}
}

func TestPlainTCPClientGetsNothing(t *testing.T) {
	root := shortRoot(t)
	slotSocket(t, root, "vm-1", "kernel.sock")
	addr := startGate(t, root)
	c, err := net.DialTimeout("tcp", addr, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(3 * time.Second))
	io.WriteString(c, "KSG1 "+testToken+" vm-1 kernel\n")
	reply, _ := bufio.NewReader(c).ReadString('\n')
	if strings.HasPrefix(reply, "OK") {
		t.Fatalf("plaintext preface accepted: %q", reply)
	}
}

func TestNewValidatesConfig(t *testing.T) {
	for _, cfg := range []Config{
		{Listen: "", Root: "/r", Token: testToken, TLSDir: "/t"},
		{Listen: "127.0.0.1:1", Root: "rel", Token: testToken, TLSDir: "/t"},
		{Listen: "127.0.0.1:1", Root: "/r", Token: "short", TLSDir: "/t"},
		{Listen: "127.0.0.1:1", Root: "/r", Token: testToken, TLSDir: "rel"},
	} {
		if _, err := New(cfg); err == nil {
			t.Errorf("New(%+v) accepted", cfg)
		}
	}
}
