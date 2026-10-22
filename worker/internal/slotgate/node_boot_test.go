package slotgate

import (
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"net/http"
	"path/filepath"
	"sync/atomic"
	"testing"
)

func oldBootGate(t *testing.T) (string, string, *Server, AuthorityState) {
	t.Helper()
	socket, _, executor := engineForTest(t)
	executor.NodeBootID = "previous-node-boot"
	root := shortRoot(t)
	s, err := New(Config{Listen: "127.0.0.1:0", Root: root, Token: testToken, TLSDir: filepath.Join(root, "tls"), Fenced: true, AuthorityDir: filepath.Join(root, "authority"), DockerSocket: socket})
	if err != nil {
		t.Fatal(err)
	}
	// A trusted test adapter represents an ACTIVE journal surviving a host boot.
	// The actual server captures this test host's current boot independently.
	state := launchForTest(t, s.authority, "v", executor)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- s.ServeListener(ctx, tls.NewListener(ln, s.TLSConfig())) }()
	t.Cleanup(func() {
		cancel()
		if err := <-done; err != nil {
			t.Error(err)
		}
	})
	return ln.Addr().String(), root, s, state
}

func TestNodeBootChangeRejectsPrepareWithoutCreatingCommand(t *testing.T) {
	addr, _, s, state := oldBootGate(t)
	before, _ := s.authority.State("v")
	reply := gate2Control(t, addr, gate2Request{Op: "prepare", VMID: "v", Fence: state.Fence, CommandID: "delayed-old-owner", Kind: "kernel"})
	after, _ := s.authority.State("v")
	if reply.OK || reply.Ticket != "" || len(after.Commands) != len(before.Commands) {
		t.Fatalf("old boot authorized a new command: reply=%+v commands=%d->%d", reply, len(before.Commands), len(after.Commands))
	}
	if after.Phase != PhaseActive || after.Fence != before.Fence {
		t.Fatal("boot mismatch was treated as termination or automatic adoption")
	}
}

func TestNodeBootChangeRejectsCapturedForwardWithoutTouchingSocket(t *testing.T) {
	addr, root, s, state := oldBootGate(t)
	handle, err := s.authority.BeginCommand("v", state.Fence, "old-prepared-job", CommandForward)
	if err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int64
	unixHTTP(t, filepath.Join(root, "vms", "v", "incarnations", state.Fence.Incarnation, "run", "kernel.sock"), http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		fmt.Fprint(w, `{}`)
	}))
	request := gate2Request{Op: "forward", VMID: "v", Fence: state.Fence, CommandID: handle.ID, Kind: "kernel"}
	request.Ticket = gate2Ticket(handle.token, request)
	c, reader := gate2Connect(t, addr, testToken, request, "GET /old-socket HTTP/1.1\r\nHost: kernel\r\nConnection: close\r\n\r\n")
	defer c.Close()
	line, err := reader.ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	after, _ := s.authority.State("v")
	if line == "OK\n" || calls.Load() != 0 || after.Commands[handle.ID].Dispatched {
		t.Fatalf("old boot touched a replacement socket: line=%q calls=%d dispatched=%v", line, calls.Load(), after.Commands[handle.ID].Dispatched)
	}
}

func TestNodeBootChangeRejectsHealthWithoutCallingKernel(t *testing.T) {
	f := publishingFixture(t)
	f.publish(t)
	f.l.boot = "previous-node-boot"
	state, _ := f.a.State("v")
	if _, err := f.l.LaunchManifest(context.Background(), launchIntentForTest(state, "old-boot-launch"), allowNodeCommandForTest); err != nil {
		t.Fatal(err)
	}
	addr, s := publishingGate(t, f)
	state, _ = s.authority.State("v")
	var calls atomic.Int64
	unixHTTP(t, filepath.Join(f.private(), "run", "kernel.sock"), http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"ok":true,"healthy":true}`)
	}))
	reply := readNodeHealth(t, addr, capturedHealthRequest(state))
	if reply.OK || calls.Load() != 0 || reply.Health != nil {
		t.Fatalf("old boot returned running health: reply=%+v calls=%d", reply, calls.Load())
	}
}

func TestNodeBootChangePreservesOriginalCompletedRecovery(t *testing.T) {
	addr, _, s, state := oldBootGate(t)
	handle, err := s.authority.BeginCommand("v", state.Fence, "completed-on-old-boot", CommandForward)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.authority.DispatchCommand(handle, func(ExecutorIdentity) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if err = s.authority.CompleteCommand(handle); err != nil {
		t.Fatal(err)
	}
	reply := readRecoveryStatus(t, addr, gate2Request{Op: "recovery-status", VMID: "v", Fence: state.Fence, CommandID: handle.ID})
	if !reply.OK || reply.Command == nil || reply.Command.Status != CommandCompleted || reply.Command.Fence != state.Fence {
		t.Fatalf("historical completion was replaced by current boot identity: %+v", reply)
	}
}
