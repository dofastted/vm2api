package slotgate

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakeEngine struct {
	mu              sync.Mutex
	executor        ExecutorIdentity
	absent          bool
	status          int
	keepAfterRemove bool
	infoEmptyAfter  int
	infoCalls       int
	truncated404    bool
	huge404         bool
	calls           []string
}

func (f *fakeEngine) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, r.Method+" "+r.URL.Path)
	if f.status != 0 {
		w.WriteHeader(f.status)
		return
	}
	if r.URL.Path == "/info" {
		f.infoCalls++
		if f.infoEmptyAfter > 0 && f.infoCalls > f.infoEmptyAfter {
			fmt.Fprint(w, `{}`)
			return
		}
		fmt.Fprint(w, `{"ID":"test-daemon"}`)
		return
	}
	if r.Method == "GET" {
		if f.absent {
			if f.truncated404 {
				w.Header().Set("Content-Length", "1000")
			}
			w.WriteHeader(404)
			if f.huge404 {
				fmt.Fprint(w, strings.Repeat("x", (1<<20)+1))
				return
			}
			fmt.Fprint(w, `{"message":"No such container"}`)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"Id": f.executor.ContainerID, "State": map[string]any{"Running": true, "Restarting": false, "StartedAt": f.executor.StartedAt}})
		return
	}
	if r.Method == "DELETE" && !f.keepAfterRemove {
		f.absent = true
	}
	w.WriteHeader(204)
}

func unixHTTP(t *testing.T, socket string, handler http.Handler) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(socket), 0o700); err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: handler}
	go server.Serve(ln)
	t.Cleanup(func() { server.Close() })
}

func engineForTest(t *testing.T) (string, *fakeEngine, ExecutorIdentity) {
	t.Helper()
	boot, err := nodeBootID()
	if err != nil {
		t.Fatal(err)
	}
	executor := testExecutor("a")
	executor.NodeBootID = boot
	executor.DockerDaemonID = "test-daemon"
	fake := &fakeEngine{executor: executor}
	socket := filepath.Join(shortRoot(t), "docker.sock")
	unixHTTP(t, socket, fake)
	return socket, fake, executor
}

func fencedGate(t *testing.T) (string, string, *Server, AuthorityState, *fakeEngine) {
	t.Helper()
	socket, engine, executor := engineForTest(t)
	root := shortRoot(t)
	s, err := New(Config{Listen: "127.0.0.1:0", Root: root, Token: testToken, TLSDir: filepath.Join(root, "tls"), Fenced: true, AuthorityDir: filepath.Join(root, "authority"), DockerSocket: socket})
	if err != nil {
		t.Fatal(err)
	}
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
	return ln.Addr().String(), root, s, state, engine
}

type controlReply struct {
	OK     bool   `json:"ok"`
	Error  string `json:"error"`
	Ticket string `json:"ticket"`
	State  *struct {
		Fence Fence          `json:"fence"`
		Phase AuthorityPhase `json:"phase"`
	} `json:"state"`
}

func gate2Connect(t *testing.T, addr, token string, request gate2Request, httpBytes string) (net.Conn, *bufio.Reader) {
	t.Helper()
	c, err := tls.Dial("tcp", addr, &tls.Config{InsecureSkipVerify: true, MinVersion: tls.VersionTLS13})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	c.SetDeadline(time.Now().Add(5 * time.Second))
	data, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = fmt.Fprintf(c, "KSG2 %s\n%s\n%s", token, data, httpBytes); err != nil {
		t.Fatal(err)
	}
	return c, bufio.NewReader(c)
}

func gate2Control(t *testing.T, addr string, request gate2Request) controlReply {
	t.Helper()
	c, reader := gate2Connect(t, addr, testToken, request, "")
	defer c.Close()
	line, err := reader.ReadBytes('\n')
	if err != nil {
		t.Fatal(err)
	}
	var reply controlReply
	if err = json.Unmarshal(line, &reply); err != nil {
		t.Fatalf("control reply %q: %v", line, err)
	}
	return reply
}

func forwardRequest(t *testing.T, addr string, state AuthorityState, id string) gate2Request {
	t.Helper()
	req := gate2Request{Op: "prepare", VMID: "v", Fence: state.Fence, CommandID: id, Kind: "kernel"}
	reply := gate2Control(t, addr, req)
	if !reply.OK || reply.Ticket == "" {
		t.Fatalf("prepare failed: %+v", reply)
	}
	req.Op = "forward"
	req.Ticket = reply.Ticket
	return req
}

func TestKSG2FencedModeRejectsKSG1AndUnauthenticatedState(t *testing.T) {
	addr, _, _, state, _ := fencedGate(t)
	c, reader := gate2Connect(t, addr, "wrong-token", gate2Request{Op: "state", VMID: "v"}, "")
	line, _ := reader.ReadString('\n')
	c.Close()
	if line != "ERR auth\n" {
		t.Fatalf("unauthenticated state response: %q", line)
	}
	c, err := tls.Dial("tcp", addr, &tls.Config{InsecureSkipVerify: true, MinVersion: tls.VersionTLS13})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(3 * time.Second))
	fmt.Fprintf(c, "KSG1 %s v kernel\n", testToken)
	line, _ = bufio.NewReader(c).ReadString('\n')
	if line != "ERR protocol\n" {
		t.Fatalf("fenced mode accepted KSG1: %q", line)
	}
	reply := gate2Control(t, addr, gate2Request{Op: "state", VMID: "v"})
	if !reply.OK || reply.State == nil || reply.State.Fence != state.Fence {
		t.Fatalf("authenticated state: %+v", reply)
	}
	reply = gate2Control(t, addr, gate2Request{Op: "complete", VMID: "v", Fence: state.Fence})
	if reply.OK {
		t.Fatal("client completed a node command without a verifier")
	}
	reply = gate2Control(t, addr, gate2Request{Op: "prepare", VMID: "v", CommandID: "no-captured-fence", Kind: "kernel"})
	if reply.OK {
		t.Fatal("prepare omitted its captured fence")
	}
}

func TestKSG2ParsesExactlyOneHTTPRequestAndRetainsForwardPending(t *testing.T) {
	addr, root, s, state, _ := fencedGate(t)
	var mu sync.Mutex
	requests := 0
	unixHTTP(t, filepath.Join(root, "vms", "v", "incarnations", state.Fence.Incarnation, "run", "kernel.sock"), http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		requests++
		mu.Unlock()
		body, _ := io.ReadAll(r.Body)
		if r.URL.Path != "/messages" || string(body) != "first" {
			t.Errorf("forwarded request: %s %q", r.URL.Path, body)
		}
		fmt.Fprint(w, `{"ok":true}`)
	}))
	req := forwardRequest(t, addr, state, "one-http-request")
	c, reader := gate2Connect(t, addr, testToken, req, "POST /messages HTTP/1.1\r\nHost: kernel\r\nContent-Length: 5\r\n\r\nfirstGET /must-not-run HTTP/1.1\r\nHost: kernel\r\n\r\n")
	line, err := reader.ReadString('\n')
	if err != nil || line != "OK\n" {
		t.Fatalf("forward: %q %v", line, err)
	}
	response, err := http.ReadResponse(reader, nil)
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, response.Body)
	response.Body.Close()
	c.Close()
	mu.Lock()
	count := requests
	mu.Unlock()
	if count != 1 {
		t.Fatalf("HTTP requests forwarded = %d, want 1", count)
	}
	current, err := s.authority.State("v")
	if err != nil || current.Commands[req.CommandID].Status != CommandPending || !current.Commands[req.CommandID].Dispatched {
		t.Fatalf("EOF released forward: %+v %v", current, err)
	}
	c, reader = gate2Connect(t, addr, testToken, req, "GET /messages HTTP/1.1\r\nHost: kernel\r\n\r\n")
	line, _ = reader.ReadString('\n')
	c.Close()
	if line != "ERR command_dispatched\n" {
		t.Fatalf("ticket replay: %q", line)
	}
}

func TestKSG2MissingOrStaleFenceTicketCannotSendAndNoLegacySocketFallback(t *testing.T) {
	addr, root, s, state, _ := fencedGate(t)
	legacyRequests := 0
	unixHTTP(t, filepath.Join(root, "vms", "v", "run", "kernel.sock"), http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { legacyRequests++; fmt.Fprint(w, "legacy") }))
	req := forwardRequest(t, addr, state, "legacy-path-forbidden")
	missing := req
	missing.Ticket = ""
	c, reader := gate2Connect(t, addr, testToken, missing, "GET / HTTP/1.1\r\nHost: kernel\r\n\r\n")
	line, _ := reader.ReadString('\n')
	c.Close()
	if line != "ERR ticket_invalid\n" {
		t.Fatalf("missing ticket: %q", line)
	}
	c, reader = gate2Connect(t, addr, testToken, req, "GET / HTTP/1.1\r\nHost: kernel\r\n\r\n")
	line, _ = reader.ReadString('\n')
	c.Close()
	if line != "ERR no_socket\n" {
		t.Fatalf("incarnation socket unavailable: %q", line)
	}
	if legacyRequests != 0 {
		t.Fatalf("fell back to legacy socket: %d", legacyRequests)
	}
	late := forwardRequest(t, addr, state, "late-command")
	if _, err := s.authority.Revoke("v", state.Fence); err != nil {
		t.Fatal(err)
	}
	c, reader = gate2Connect(t, addr, testToken, late, "GET / HTTP/1.1\r\nHost: kernel\r\n\r\n")
	line, _ = reader.ReadString('\n')
	c.Close()
	if line != "ERR authority_phase\n" {
		t.Fatalf("late command dispatched: %q", line)
	}
	reply := gate2Control(t, addr, gate2Request{Op: "advance", VMID: "v", Fence: state.Fence})
	if !reply.OK || reply.State == nil || reply.State.Fence.Generation != state.Fence.Generation+1 {
		t.Fatalf("verified advance: %+v", reply)
	}
	c, reader = gate2Connect(t, addr, testToken, late, "GET / HTTP/1.1\r\nHost: kernel\r\n\r\n")
	line, _ = reader.ReadString('\n')
	c.Close()
	if line != "ERR fence_mismatch\n" {
		t.Fatalf("old generation dispatched after takeover: %q", line)
	}
}

func TestKSG2MalformedHTTPAndWrongTargetTicketAreNotDispatched(t *testing.T) {
	addr, _, s, state, _ := fencedGate(t)
	req := forwardRequest(t, addr, state, "invalid-http")
	c, reader := gate2Connect(t, addr, testToken, req, "not-an-http-request\r\n\r\n")
	line, _ := reader.ReadString('\n')
	c.Close()
	if line != "ERR http_request\n" {
		t.Fatalf("malformed HTTP response: %q", line)
	}
	current, _ := s.authority.State("v")
	if current.Commands[req.CommandID].Dispatched {
		t.Fatal("malformed HTTP was dispatched")
	}
	req.Kind = "worker"
	c, reader = gate2Connect(t, addr, testToken, req, "GET / HTTP/1.1\r\nHost: kernel\r\n\r\n")
	line, _ = reader.ReadString('\n')
	c.Close()
	if line != "ERR ticket_invalid\n" {
		t.Fatalf("ticket reused on a different target: %q", line)
	}
}

func TestDockerVerifierRequiresMatchingImmutableIdentityAndTrustedAbsence(t *testing.T) {
	socket, engine, executor := engineForTest(t)
	verifier, err := newDockerVerifier(socket, executor.NodeBootID)
	if err != nil {
		t.Fatal(err)
	}
	wrong := executor
	wrong.StartedAt = "2026-10-22T00:00:00Z"
	if _, err = verifier(context.Background(), wrong); err == nil {
		t.Fatal("different container incarnation was terminated")
	}
	engine.mu.Lock()
	calls := append([]string(nil), engine.calls...)
	engine.calls = nil
	engine.mu.Unlock()
	for _, call := range calls {
		if !strings.HasPrefix(call, "GET ") {
			t.Fatalf("mutated mismatching target: %s", call)
		}
	}
	proof, err := verifier(context.Background(), executor)
	if err != nil || proof.Executor != executor || proof.Scope != "container_removed" {
		t.Fatalf("termination proof: %+v %v", proof, err)
	}
	engine.mu.Lock()
	calls = append([]string(nil), engine.calls...)
	engine.mu.Unlock()
	if !strings.Contains(strings.Join(calls, "\n"), "DELETE /containers/"+executor.ContainerID) {
		t.Fatalf("immutable ID not removed: %v", calls)
	}
	if _, err = verifier(context.Background(), executor); err != nil {
		t.Fatalf("trusted 404 for tracked old identity: %v", err)
	}
}

func TestDockerVerifierErrorsCannotAdvanceOrReleasePendingForward(t *testing.T) {
	for _, status := range []int{401, 500} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			addr, _, s, state, engine := fencedGate(t)
			req := forwardRequest(t, addr, state, "pending")
			if _, err := s.authority.Revoke("v", state.Fence); err != nil {
				t.Fatal(err)
			}
			engine.mu.Lock()
			engine.status = status
			engine.mu.Unlock()
			reply := gate2Control(t, addr, gate2Request{Op: "advance", VMID: "v", Fence: state.Fence})
			if reply.OK {
				t.Fatal("Engine error advanced generation")
			}
			current, _ := s.authority.State("v")
			if current.Fence != state.Fence || current.Commands[req.CommandID].Status != CommandPending {
				t.Fatalf("Engine error cleared pending: %+v", current)
			}
		})
	}
	socket, engine, executor := engineForTest(t)
	verifier, _ := newDockerVerifier(socket, executor.NodeBootID)
	wrong := executor
	wrong.DockerDaemonID = "different-daemon"
	if _, err := verifier(context.Background(), wrong); err == nil {
		t.Fatal("different daemon 404 could become termination proof")
	}
	wrong = executor
	wrong.NodeBootID = "another-boot"
	if _, err := verifier(context.Background(), wrong); err == nil {
		t.Fatal("different host boot accepted")
	}
	engine.mu.Lock()
	engine.keepAfterRemove = true
	engine.mu.Unlock()
	if _, err := verifier(context.Background(), executor); err == nil {
		t.Fatal("remove response alone became termination proof")
	}
}

func TestDockerVerifierFinalDaemonObservationCannotReuseEarlierFields(t *testing.T) {
	socket, engine, executor := engineForTest(t)
	engine.mu.Lock()
	engine.infoEmptyAfter = 1
	engine.mu.Unlock()
	verifier, _ := newDockerVerifier(socket, executor.NodeBootID)
	if _, err := verifier(context.Background(), executor); err == nil {
		t.Fatal("missing final daemon ID reused an earlier observation")
	}
}

func TestDockerVerifierIncompleteOrOversized404IsUnknown(t *testing.T) {
	for _, which := range []string{"truncated", "oversized"} {
		t.Run(which, func(t *testing.T) {
			socket, engine, executor := engineForTest(t)
			engine.mu.Lock()
			engine.absent = true
			engine.truncated404 = which == "truncated"
			engine.huge404 = which == "oversized"
			engine.mu.Unlock()
			verifier, _ := newDockerVerifier(socket, executor.NodeBootID)
			if _, err := verifier(context.Background(), executor); err == nil {
				t.Fatal("incomplete/unbounded Engine response became absence proof")
			}
		})
	}
}

func TestKSG2TwoControllersCanForwardWhileFirstResponseIsStillPending(t *testing.T) {
	addr, root, _, state, _ := fencedGate(t)
	entered := make(chan struct{}, 2)
	release := make(chan struct{})
	defer close(release)
	unixHTTP(t, filepath.Join(root, "vms", "v", "incarnations", state.Fence.Incarnation, "run", "kernel.sock"), http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { entered <- struct{}{}; <-release; fmt.Fprint(w, "done") }))
	for _, id := range []string{"controller-a", "controller-b"} {
		req := forwardRequest(t, addr, state, id)
		_, reader := gate2Connect(t, addr, testToken, req, "GET / HTTP/1.1\r\nHost: kernel\r\n\r\n")
		if line, err := reader.ReadString('\n'); err != nil || line != "OK\n" {
			t.Fatalf("send %s: %q %v", id, line, err)
		}
	}
	for range 2 {
		select {
		case <-entered:
		case <-time.After(time.Second):
			t.Fatal("second controller waited for the first response")
		}
	}
}
