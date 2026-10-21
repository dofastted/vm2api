package slotgate

import (
	"bufio"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

func sealWire(addr string, request gate2Request) (recoveryStatusReply, error) {
	var reply recoveryStatusReply
	c, err := tls.Dial("tcp", addr, &tls.Config{InsecureSkipVerify: true, MinVersion: tls.VersionTLS13})
	if err != nil {
		return reply, err
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(5 * time.Second))
	data, _ := json.Marshal(request)
	if _, err = fmt.Fprintf(c, "KSG2 %s\n%s\n", testToken, data); err != nil {
		return reply, err
	}
	err = json.NewDecoder(c).Decode(&reply)
	return reply, err
}

func readSeal(t *testing.T, addr string, request gate2Request) recoveryStatusReply {
	t.Helper()
	reply, err := sealWire(addr, request)
	if err != nil {
		t.Fatal(err)
	}
	return reply
}

func requireNotStarted(t *testing.T, reply recoveryStatusReply, request gate2Request) {
	t.Helper()
	if !reply.OK || reply.Found == nil || !*reply.Found || reply.Command == nil || reply.Command.ID != request.CommandID || reply.Command.Fence != request.Fence || reply.Command.Status != "not_started" || reply.Command.Dispatched || reply.Unknown || len(reply.State) != 0 {
		t.Fatalf("no original durable not_started proof: %+v", reply)
	}
}

func TestNodeSealNotStartedPersistsAbsentCommandAndRejectsLatePrepare(t *testing.T) {
	_, addr, s, state := activeHealthGate(t)
	request := gate2Request{Op: "seal-not-started", VMID: "v", Fence: state.Fence, CommandID: "absent-sealed-command"}
	before := readRecoveryStatus(t, addr, gate2Request{Op: "recovery-status", VMID: "v", Fence: state.Fence, CommandID: request.CommandID})
	if before.Found == nil || *before.Found || !before.Unknown {
		t.Fatal("fixture already contains command")
	}
	requireNotStarted(t, readSeal(t, addr, request), request)
	requireNotStarted(t, readSeal(t, addr, request), request)
	late := gate2Control(t, addr, gate2Request{Op: "prepare", VMID: "v", Fence: state.Fence, CommandID: request.CommandID, Kind: "kernel"})
	if late.OK || late.Ticket != "" {
		t.Fatal("sealed ID authorized delayed prepare")
	}
	if err := s.authority.Close(); err != nil {
		t.Fatal(err)
	}
	reopened := authorityForTest(t, s.cfg.AuthorityDir, terminatedExecutor)
	historical, err := reopened.recoveryStatus("v", state.Fence, request.CommandID)
	if err != nil || historical == nil || historical.Status != "not_started" || historical.Dispatched {
		t.Fatalf("restart lost tombstone: %+v %v", historical, err)
	}
	if _, err = reopened.BeginCommand("v", state.Fence, request.CommandID, CommandForward); err == nil {
		t.Fatal("restarted daemon reissued sealed ID")
	}
}

func TestNodeSealNotStartedPreventsAnAlreadyPreparedDelayedForward(t *testing.T) {
	f, addr, s, state := activeHealthGate(t)
	request := forwardRequest(t, addr, state, "prepared-sealed-command")
	seal := gate2Request{Op: "seal-not-started", VMID: "v", Fence: request.Fence, CommandID: request.CommandID}
	requireNotStarted(t, readSeal(t, addr, seal), seal)
	var calls atomic.Int64
	unixHTTP(t, filepath.Join(f.private(), "run", "kernel.sock"), http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		fmt.Fprint(w, normalClaudeJSON)
	}))
	c, reader := gate2Connect(t, addr, testToken, request, claudeWire(request.CommandID))
	defer c.Close()
	line, err := reader.ReadString('\n')
	if err != nil || line == "OK\n" || calls.Load() != 0 {
		t.Fatalf("sealed prepared request reached kernel: %q %v calls=%d", line, err, calls.Load())
	}
	current, _ := s.authority.State("v")
	if current.Commands[request.CommandID].Dispatched {
		t.Fatal("delayed forward changed sealed command")
	}
}

func TestNodeSealNotStartedAndDispatchAreMutuallyExclusive(t *testing.T) {
	f, addr, s, state := activeHealthGate(t)
	var calls atomic.Int64
	unixHTTP(t, filepath.Join(f.private(), "run", "kernel.sock"), http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, normalClaudeJSON)
	}))
	for i := 0; i < 12; i++ {
		request := forwardRequest(t, addr, state, fmt.Sprintf("seal-dispatch-race-%d", i))
		seal := gate2Request{Op: "seal-not-started", VMID: "v", Fence: request.Fence, CommandID: request.CommandID}
		start := make(chan struct{})
		type result struct {
			reply recoveryStatusReply
			line  string
			err   error
		}
		sealDone, forwardDone := make(chan result, 1), make(chan result, 1)
		go func() {
			<-start
			reply, err := sealWire(addr, seal)
			sealDone <- result{reply: reply, err: err}
		}()
		go func() {
			<-start
			c, err := tls.Dial("tcp", addr, &tls.Config{InsecureSkipVerify: true, MinVersion: tls.VersionTLS13})
			if err != nil {
				forwardDone <- result{err: err}
				return
			}
			defer c.Close()
			c.SetDeadline(time.Now().Add(5 * time.Second))
			data, _ := json.Marshal(request)
			_, err = fmt.Fprintf(c, "KSG2 %s\n%s\n%s", testToken, data, claudeWire(request.CommandID))
			reader := bufio.NewReader(c)
			var line string
			if err == nil {
				line, err = reader.ReadString('\n')
			}
			if err == nil && line == "OK\n" {
				_, err = io.Copy(io.Discard, reader)
			}
			forwardDone <- result{line: line, err: err}
		}()
		before := calls.Load()
		close(start)
		sealed, forwarded := <-sealDone, <-forwardDone
		if sealed.err != nil || forwarded.err != nil {
			t.Fatalf("race transport failed: %v / %v", sealed.err, forwarded.err)
		}
		if sealed.reply.OK {
			requireNotStarted(t, sealed.reply, seal)
			if forwarded.line == "OK\n" || calls.Load() != before {
				t.Fatal("not_started proof overlapped an actual dispatch")
			}
		} else {
			if forwarded.line != "OK\n" || calls.Load() != before+1 {
				t.Fatalf("neither dispatch nor seal won: %+v / %+v", sealed, forwarded)
			}
			waitCommandStatus(t, s.authority, request.CommandID, CommandCompleted)
		}
	}
}

func TestNodeSealNotStartedRejectsEveryDispatchedState(t *testing.T) {
	_, addr, s, state := activeHealthGate(t)
	for _, completed := range []bool{false, true} {
		id := fmt.Sprintf("already-dispatched-%t", completed)
		handle, err := s.authority.BeginCommand("v", state.Fence, id, CommandForward)
		if err != nil {
			t.Fatal(err)
		}
		if err = s.authority.DispatchCommand(handle, func(ExecutorIdentity) error { return nil }); err != nil {
			t.Fatal(err)
		}
		if completed {
			if err = s.authority.CompleteCommand(handle); err != nil {
				t.Fatal(err)
			}
		}
		reply := readSeal(t, addr, gate2Request{Op: "seal-not-started", VMID: "v", Fence: state.Fence, CommandID: id})
		if reply.OK || reply.Command != nil {
			t.Fatalf("dispatched execution was relabeled not_started: %+v", reply)
		}
	}
}

func TestNodeSealNotStartedRejectsNonManagedOrRelabeledAuthority(t *testing.T) {
	addr, _, _, legacy, _ := fencedGate(t)
	if reply := readSeal(t, addr, gate2Request{Op: "seal-not-started", VMID: "v", Fence: legacy.Fence, CommandID: "unmanaged-deny"}); reply.OK {
		t.Fatal("runtime token gained unconfigured management authority")
	}
	_, addr, s, state := activeHealthGate(t)
	wrong := state.Fence
	wrong.Generation++
	for _, request := range []gate2Request{
		{Op: "seal-not-started", VMID: "v", Fence: wrong, CommandID: "wrong-generation"},
		{Op: "seal-not-started", VMID: "v", Fence: state.Fence, CommandID: "wrong-kind", Kind: "worker"},
		{Op: "seal-not-started", VMID: "v", Fence: state.Fence, CommandID: "wrong-ticket", Ticket: "arbitrary"},
	} {
		if reply := readSeal(t, addr, request); reply.OK || reply.Command != nil {
			t.Fatalf("relabeled/expanded deny request accepted: %+v", reply)
		}
	}
	current, _ := s.authority.State("v")
	if len(current.Commands) != len(state.Commands) {
		t.Fatal("rejected request created a tombstone")
	}
}

func TestNodeSealNotStartedPersistenceFailureNeverReturnsProof(t *testing.T) {
	_, addr, s, state := activeHealthGate(t)
	journal := filepath.Join(s.cfg.AuthorityDir, "authority.json")
	if err := os.Rename(journal, journal+".saved"); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(journal, 0o700); err != nil {
		t.Fatal(err)
	}
	request := gate2Request{Op: "seal-not-started", VMID: "v", Fence: state.Fence, CommandID: "seal-fsync-failure"}
	reply := readSeal(t, addr, request)
	if reply.OK || reply.Command != nil {
		t.Fatalf("failed journal write returned a proof: %+v", reply)
	}
	request.Op = "recovery-status"
	reply = readRecoveryStatus(t, addr, request)
	if reply.OK || reply.Command != nil {
		t.Fatalf("failed seal remained authoritative: %+v", reply)
	}
}
