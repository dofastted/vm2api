// Local interoperability fixture. Synthetic state is installed by trusted test
// code; no Docker daemon or provider is contacted and no container is launched.
package main

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/dofastted/kin-gateway/worker/internal/slotgate"
)

func check(err error) {
	if err != nil {
		panic(err)
	}
}

func main() {
	root := os.Args[1]
	journal := filepath.Join(root, "authority")
	authority, err := slotgate.OpenAuthority(journal, nil)
	check(err)
	state, err := authority.CreateSlot("vm-synthetic")
	check(err)
	launch, err := authority.BeginLaunch("vm-synthetic", state.Fence, "synthetic-bootstrap")
	check(err)
	check(authority.StartLaunch(launch))
	boot, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	check(err)
	state, err = authority.BindExecutor(launch, slotgate.ExecutorIdentity{
		Kind: "container", NodeBootID: strings.TrimSpace(string(boot)), ContainerID: strings.Repeat("a", 64),
		DockerDaemonID: "synthetic-engine", StartedAt: "2026-10-21T00:00:00.000000001Z",
	})
	check(err)
	check(authority.Close())
	run := filepath.Join(root, "vms", "vm-synthetic", "incarnations", state.Fence.Incarnation, "run")
	check(os.MkdirAll(run, 0700))
	unix, err := net.Listen("unix", filepath.Join(run, "kernel.sock"))
	check(err)
	kernel := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Kin-Internal-Token") != "synthetic-kernel-internal-token" || r.Header.Get("X-Internal-Token") != "synthetic-kernel-internal-token" {
			w.WriteHeader(http.StatusUnauthorized)
			fmt.Fprint(w, `{"type":"error","error":{"code":"internal_unauthorized"}}`)
			return
		}
		var envelope struct {
			Body struct {
				Mode string `json:"mode"`
			} `json:"body"`
		}
		check(json.NewDecoder(r.Body).Decode(&envelope))
		w.Header().Set("Content-Type", "application/json")
		if envelope.Body.Mode == "unknown" {
			w.WriteHeader(502)
			fmt.Fprint(w, `{"type":"error","error":{"code":"provider_error","message":"client disconnected"}}`)
			return
		}
		fmt.Fprint(w, `{"id":"synthetic-message","type":"message","role":"assistant","content":[{"type":"text","text":"synthetic answer"}],"stop_reason":"end_turn"}`)
	})}
	go kernel.Serve(unix)
	defer kernel.Close()
	const token = "synthetic-local-node-gate-token-000000"
	server, err := slotgate.New(slotgate.Config{Listen: "127.0.0.1:0", Root: root, Token: token,
		TLSDir: filepath.Join(root, "tls"), Fenced: true, AuthorityDir: journal,
		DockerSocket: filepath.Join(root, "never-opened-docker.sock")})
	check(err)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	check(err)
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- server.ServeListener(ctx, tls.NewListener(listener, server.TLSConfig())) }()
	cert := server.TLSConfig().Certificates[0].Certificate[0]
	pin := sha256.Sum256(cert)
	check(json.NewEncoder(os.Stdout).Encode(map[string]any{
		"trusted": true, "pgBindingReady": true, "nodeId": "node-synthetic", "vmId": "vm-synthetic", "fence": state.Fence,
		"link": map[string]any{"address": "127.0.0.1", "port": listener.Addr().(*net.TCPAddr).Port, "token": token, "certSha256": hex.EncodeToString(pin[:])},
	}))
	<-ctx.Done()
	check(<-done)
}
