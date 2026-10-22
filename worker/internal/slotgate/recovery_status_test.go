package slotgate

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"net"
	"path/filepath"
	"testing"
)

type recoveryStatusReply struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
	Found   *bool  `json:"found"`
	Unknown bool   `json:"unknown"`
	Command *struct {
		ID         string        `json:"id"`
		Fence      Fence         `json:"fence"`
		Status     CommandStatus `json:"status"`
		Dispatched bool          `json:"dispatched"`
	} `json:"command"`
	State json.RawMessage `json:"state"`
}

func readRecoveryStatus(t *testing.T, addr string, request gate2Request) recoveryStatusReply {
	t.Helper()
	c, reader := gate2Connect(t, addr, testToken, request, "")
	defer c.Close()
	var reply recoveryStatusReply
	if err := json.NewDecoder(reader).Decode(&reply); err != nil {
		t.Fatal(err)
	}
	return reply
}

func historicalRecoveryGate(t *testing.T, completed, advance bool) (string, *Server, Fence) {
	t.Helper()
	socket, _, executor := engineForTest(t)
	root := shortRoot(t)
	a := authorityForTest(t, filepath.Join(root, "authority"), terminatedExecutor)
	state := launchForTest(t, a, "v", executor)
	handle, err := a.BeginCommand("v", state.Fence, "original-job", CommandForward)
	if err != nil {
		t.Fatal(err)
	}
	if err = a.DispatchCommand(handle, func(ExecutorIdentity) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if completed {
		if err = a.CompleteCommand(handle); err != nil {
			t.Fatal(err)
		}
	}
	if advance {
		if _, err = a.Revoke("v", state.Fence); err != nil {
			t.Fatal(err)
		}
		if _, err = a.Advance(context.Background(), "v", state.Fence); err != nil {
			t.Fatal(err)
		}
	}
	if err = a.Close(); err != nil {
		t.Fatal(err)
	}
	s, err := New(Config{Listen: "127.0.0.1:0", Root: root, Token: testToken, TLSDir: filepath.Join(root, "tls"), Fenced: true, AuthorityDir: a.root, DockerSocket: socket})
	if err != nil {
		t.Fatal(err)
	}
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
	return ln.Addr().String(), s, state.Fence
}

func TestNodeRecoveryStatusReadsOriginalCompletedCommandAcrossNodeRestartAndGeneration(t *testing.T) {
	addr, s, original := historicalRecoveryGate(t, true, true)
	before, _ := s.authority.State("v")
	if before.Fence == original {
		t.Fatal("fixture did not advance the current generation")
	}
	reply := readRecoveryStatus(t, addr, gate2Request{Op: "recovery-status", VMID: "v", Fence: original, CommandID: "original-job"})
	if !reply.OK || reply.Found == nil || !*reply.Found || reply.Command == nil || reply.Command.ID != "original-job" || reply.Command.Fence != original || reply.Command.Status != CommandCompleted || !reply.Command.Dispatched {
		t.Fatalf("historical completion unavailable without a dead controller ticket: %+v", reply)
	}
	if len(reply.State) != 0 {
		t.Fatal("historical query returned latest state as new authorization")
	}
	after, _ := s.authority.State("v")
	if len(before.Commands) != len(after.Commands) || before.Fence != after.Fence {
		t.Fatal("recovery observation mutated node state")
	}
}

func TestNodeRecoveryStatusRetainsRestartedUnknownAndNotFound(t *testing.T) {
	addr, s, original := historicalRecoveryGate(t, false, false)
	reply := readRecoveryStatus(t, addr, gate2Request{Op: "recovery-status", VMID: "v", Fence: original, CommandID: "original-job"})
	if !reply.OK || reply.Found == nil || !*reply.Found || reply.Command == nil || reply.Command.Status != CommandUnknown || !reply.Command.Dispatched {
		t.Fatalf("restarted pending command was lost: %+v", reply)
	}
	reply = readRecoveryStatus(t, addr, gate2Request{Op: "recovery-status", VMID: "v", Fence: original, CommandID: "not-found"})
	if !reply.OK || reply.Found == nil || *reply.Found || !reply.Unknown || reply.Command != nil {
		t.Fatalf("notfound must remain unknown: %+v", reply)
	}
	state, _ := s.authority.State("v")
	if _, ok := state.Commands["not-found"]; ok {
		t.Fatal("readonly lookup minted or sealed a command")
	}
}

func TestNodeRecoveryStatusRejectsRelabeledFenceAndMutationFields(t *testing.T) {
	addr, _, original := historicalRecoveryGate(t, true, false)
	wrong := original
	wrong.Generation++
	for _, request := range []gate2Request{
		{Op: "recovery-status", VMID: "v", Fence: wrong, CommandID: "original-job"},
		{Op: "recovery-status", VMID: "v", Fence: original, CommandID: "original-job", Ticket: "not-required-nonce"},
		{Op: "recovery-status", VMID: "v", Fence: original, CommandID: "original-job", Kind: "kernel"},
	} {
		reply := readRecoveryStatus(t, addr, request)
		if reply.OK || reply.Command != nil {
			t.Fatalf("relabeled/mutation request accepted: %+v", reply)
		}
	}
}
