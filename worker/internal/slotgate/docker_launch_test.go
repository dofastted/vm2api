package slotgate

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakeLaunchEngine struct {
	mu            sync.Mutex
	image         string
	socket        string
	container     string
	startedAt     string
	spec          map[string]any
	calls         []string
	failStart     bool
	badCreateID   bool
	createEntered chan struct{}
	createProceed chan struct{}
	onInspect     func()
	networkDriver string
}

func (f *fakeLaunchEngine) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	f.calls = append(f.calls, r.Method+" "+r.URL.Path)
	if r.URL.Path == "/info" {
		f.mu.Unlock()
		fmt.Fprint(w, `{"ID":"test-daemon"}`)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/images/") {
		image := f.image
		f.mu.Unlock()
		json.NewEncoder(w).Encode(map[string]any{"Id": image, "Config": map[string]any{"Labels": map[string]string{"kin.slot.full": "1"}}})
		return
	}
	if strings.HasPrefix(r.URL.Path, "/networks/") {
		driver := f.networkDriver
		f.mu.Unlock()
		json.NewEncoder(w).Encode(map[string]any{"Id": strings.TrimPrefix(r.URL.Path, "/networks/"), "Driver": driver, "Scope": "local"})
		return
	}
	if r.URL.Path == "/containers/create" {
		if err := json.NewDecoder(r.Body).Decode(&f.spec); err != nil {
			f.mu.Unlock()
			w.WriteHeader(400)
			return
		}
		entered, proceed, bad, id := f.createEntered, f.createProceed, f.badCreateID, f.container
		f.mu.Unlock()
		if entered != nil {
			close(entered)
			<-proceed
		}
		w.WriteHeader(201)
		if bad {
			id = "not-an-immutable-id"
		}
		json.NewEncoder(w).Encode(map[string]any{"Id": id})
		return
	}
	if strings.HasSuffix(r.URL.Path, "/start") {
		fail := f.failStart
		f.mu.Unlock()
		if fail {
			w.WriteHeader(500)
		} else {
			w.WriteHeader(204)
		}
		return
	}
	if r.Method == "GET" && r.URL.Path == "/containers/"+f.container+"/json" {
		id, image, started, spec, observe := f.container, f.image, f.startedAt, f.spec, f.onInspect
		f.mu.Unlock()
		if observe != nil {
			observe()
		}
		json.NewEncoder(w).Encode(map[string]any{"Id": id, "Image": image, "Config": map[string]any{"Labels": spec["Labels"]}, "State": map[string]any{"Running": true, "Restarting": false, "StartedAt": started}})
		return
	}
	f.mu.Unlock()
	w.WriteHeader(404)
}

func launchFixture(t *testing.T) (*Authority, *dockerLauncher, *fakeLaunchEngine, AuthorityState, string) {
	return launchFixtureConfigured(t, true, "none")
}

func launchFixtureConfigured(t *testing.T, published bool, network string) (*Authority, *dockerLauncher, *fakeLaunchEngine, AuthorityState, string) {
	t.Helper()
	if runtime.GOOS != "linux" {
		t.Skip("initial publication requires Linux descriptor-relative file operations")
	}
	root := shortRoot(t)
	boot, err := nodeBootID()
	if err != nil {
		t.Fatal(err)
	}
	a := authorityForTest(t, filepath.Join(root, "authority"), terminatedExecutor)
	allocation, err := a.Allocate(AllocationIntent{NodeID: "node-test", VMID: "v", AllocationID: "allocation-test", OperationID: "allocation-operation", OwnerID: "allocation-owner"}, "1")
	if err != nil {
		t.Fatal(err)
	}
	state, _ := a.State("v")
	policy := DockerLaunchPolicy{ImageID: "sha256:" + strings.Repeat("b", 64), NetworkID: network, UID: os.Getuid(), GID: os.Getgid()}
	if policy.UID == 0 {
		policy.UID = 10000
		policy.GID = 10000
	}
	private := filepath.Join(root, "vms", "v", "incarnations", state.Fence.Incarnation)
	if !published {
		for _, dir := range []string{"config", "run", "home", "claude"} {
			if err = os.MkdirAll(filepath.Join(private, dir), 0o700); err != nil {
				t.Fatal(err)
			}
			if dir != "config" && policy.UID != os.Geteuid() {
				if err = os.Chown(filepath.Join(private, dir), policy.UID, policy.GID); err != nil {
					t.Fatal(err)
				}
			}
		}
		for _, file := range []string{"kernel.json", "internal.token"} {
			if err = os.WriteFile(filepath.Join(private, "config", file), []byte("synthetic-only"), 0o600); err != nil {
				t.Fatal(err)
			}
			if policy.UID != os.Geteuid() {
				if err = os.Chown(filepath.Join(private, "config", file), os.Geteuid(), policy.GID); err != nil {
					t.Fatal(err)
				}
				if err = os.Chmod(filepath.Join(private, "config", file), 0o640); err != nil {
					t.Fatal(err)
				}
			}
		}
	} else {
		payload := []byte(`{"credential":{"type":"oauth","account_uuid":"synthetic-account","access_token":"synthetic-access","refresh_token":"synthetic-refresh"}}`)
		intent := publicationIntentForTest(allocation, policy, payload)
		publisher := initialPublisher{authority: a, root: root, nodeID: allocation.NodeID, policy: policy, authorize: allowNodeCommandForTest}
		if _, err = publisher.Publish(context.Background(), intent, len(payload), strings.NewReader(string(payload))); err != nil {
			t.Fatal(err)
		}
		state, _ = a.State("v")
	}
	fake := &fakeLaunchEngine{image: policy.ImageID, container: strings.Repeat("c", 64), startedAt: "2026-10-21T01:00:00Z"}
	socket := filepath.Join(shortRoot(t), "docker.sock")
	fake.socket = socket
	unixHTTP(t, socket, fake)
	launcher, err := newDockerLauncher(socket, root, boot, a, policy)
	if err != nil {
		t.Fatal(err)
	}
	return a, launcher, fake, state, root
}

func TestDockerLaunchBindsOnlyNodeCreatedInspectedIdentityWithRestrictedSpec(t *testing.T) {
	a, launcher, engine, state, root := launchFixture(t)
	active, err := launcher.Launch(context.Background(), "v", state.Fence, "launch-1")
	if err != nil {
		t.Fatal(err)
	}
	if active.Phase != PhaseActive || active.Fence.Executor.ContainerID != engine.container || active.Fence.Executor.StartedAt != engine.startedAt || active.Fence.Executor.DockerDaemonID != "test-daemon" {
		t.Fatalf("bound executor: %+v", active)
	}
	engine.mu.Lock()
	spec, calls := engine.spec, append([]string(nil), engine.calls...)
	engine.mu.Unlock()
	if spec["Image"] != engine.image || fmt.Sprint(spec["Entrypoint"]) != "[/opt/kin/kin-kernel]" || fmt.Sprint(spec["Cmd"]) != "[--gateway-worker --config /run/kin/kernel.json]" {
		t.Fatalf("payload spec: %+v", spec)
	}
	host := spec["HostConfig"].(map[string]any)
	if host["Privileged"] != false || host["ReadonlyRootfs"] != true || host["NetworkMode"] != "none" || fmt.Sprint(host["CapDrop"]) != "[ALL]" || fmt.Sprint(host["SecurityOpt"]) != "[no-new-privileges]" {
		t.Fatalf("unsafe host config: %+v", host)
	}
	if fmt.Sprint(host["RestartPolicy"]) != "map[Name:no]" {
		t.Fatalf("uncontrolled restart: %+v", host)
	}
	for _, bind := range host["Binds"].([]any) {
		if !strings.HasPrefix(bind.(string), filepath.Join(root, "vms", "v", "incarnations", state.Fence.Incarnation)+"/") || strings.Contains(bind.(string), "docker.sock") || strings.Contains(bind.(string), "authority") {
			t.Fatalf("escaped private mount: %s", bind)
		}
	}
	if !strings.Contains(strings.Join(calls, "\n"), "POST /containers/"+engine.container+"/start") {
		t.Fatalf("start did not pin immutable ID: %v", calls)
	}
	stored, _ := a.State("v")
	if stored.Commands["launch-1"].LaunchTarget == nil || stored.Commands["launch-1"].LaunchTarget.ContainerID != engine.container || stored.Commands["launch-1"].Status != CommandCompleted {
		t.Fatalf("launch target not retained: %+v", stored)
	}
}

func TestDockerLaunchNetworkIOLeavesOtherVMAdmissionAvailableAndPendingBlocksAdvance(t *testing.T) {
	a, launcher, engine, state, _ := launchFixture(t)
	other := launchForTest(t, a, "other", testExecutor("d"))
	engine.createEntered, engine.createProceed = make(chan struct{}), make(chan struct{})
	var released sync.Once
	resume := func() { released.Do(func() { close(engine.createProceed) }) }
	defer resume()
	finished := make(chan error, 1)
	go func() {
		_, err := launcher.Launch(context.Background(), "v", state.Fence, "slow-create")
		finished <- err
	}()
	select {
	case <-engine.createEntered:
	case err := <-finished:
		t.Fatalf("launch ended before create: %v", err)
	case <-time.After(3 * time.Second):
		t.Fatal("create was not reached")
	}
	admitted := make(chan error, 1)
	go func() { _, err := a.BeginCommand("other", other.Fence, "parallel", CommandForward); admitted <- err }()
	select {
	case err := <-admitted:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		resume()
		t.Fatal("Engine I/O held the Authority global lock")
	}
	if _, err := a.Revoke("v", state.Fence); err != nil {
		t.Fatal(err)
	}
	_, err := a.Advance(context.Background(), "v", state.Fence)
	requireAuthorityError(t, err, ErrPendingMutation)
	resume()
	if err = <-finished; err == nil {
		t.Fatal("late launch bound after revocation")
	}
	stored, _ := a.State("v")
	if stored.Phase != PhaseRevoking || stored.Commands["slow-create"].LaunchTarget == nil {
		t.Fatalf("late create identity was lost: %+v", stored)
	}
	engine.mu.Lock()
	calls := append([]string(nil), engine.calls...)
	engine.mu.Unlock()
	for _, call := range calls {
		if strings.HasSuffix(call, "/start") {
			t.Fatalf("revoked launch started: %v", calls)
		}
	}
}

func TestDockerLaunchStartFailureAndNodeRestartNeverResubmitCreate(t *testing.T) {
	a, launcher, engine, state, root := launchFixture(t)
	engine.failStart = true
	if _, err := launcher.Launch(context.Background(), "v", state.Fence, "start-unknown"); err == nil {
		t.Fatal("failed start succeeded")
	}
	stored, _ := a.State("v")
	if stored.Commands["start-unknown"].LaunchTarget == nil || stored.Commands["start-unknown"].Status != CommandPending {
		t.Fatalf("start error discarded identity: %+v", stored)
	}
	if err := a.Close(); err != nil {
		t.Fatal(err)
	}
	reopened := authorityForTest(t, filepath.Join(root, "authority"), terminatedExecutor)
	launcher.authority = reopened
	if _, err := launcher.Launch(context.Background(), "v", state.Fence, "retry-after-crash"); err == nil {
		t.Fatal("unknown launch retried after restart")
	}
	engine.mu.Lock()
	calls := append([]string(nil), engine.calls...)
	engine.mu.Unlock()
	creates := 0
	for _, call := range calls {
		if call == "POST /containers/create" {
			creates++
		}
	}
	if creates != 1 {
		t.Fatalf("create count=%d, want 1", creates)
	}
	stored, _ = reopened.State("v")
	if stored.Phase != PhaseRevoking || stored.Commands["start-unknown"].Status != CommandUnknown {
		t.Fatalf("crash state: %+v", stored)
	}
}

func TestDockerLaunchUnknownCreateResponseAndBindPersistenceFailureRetainClaim(t *testing.T) {
	t.Run("unknown-create-id", func(t *testing.T) {
		a, launcher, engine, state, _ := launchFixture(t)
		engine.badCreateID = true
		if _, err := launcher.Launch(context.Background(), "v", state.Fence, "unknown-create"); err == nil {
			t.Fatal("invalid immutable ID bound")
		}
		stored, _ := a.State("v")
		if stored.Commands["unknown-create"].Status != CommandPending || !stored.Commands["unknown-create"].Dispatched {
			t.Fatalf("unknown create released: %+v", stored)
		}
	})
	t.Run("bind-commit-failed", func(t *testing.T) {
		a, launcher, engine, state, root := launchFixture(t)
		journal := filepath.Join(root, "authority", "authority.json")
		engine.onInspect = func() {
			if err := os.Rename(journal, journal+".saved"); err != nil {
				t.Error(err)
			}
			if err := os.Mkdir(journal, 0o700); err != nil {
				t.Error(err)
			}
		}
		if _, err := launcher.Launch(context.Background(), "v", state.Fence, "bind-uncertain"); err == nil {
			t.Fatal("failed bind commit returned success")
		}
		if err := os.Remove(journal); err != nil {
			t.Fatal(err)
		}
		if err := os.Rename(journal+".saved", journal); err != nil {
			t.Fatal(err)
		}
		if err := a.Close(); err != nil {
			t.Fatal(err)
		}
		reopened := authorityForTest(t, filepath.Join(root, "authority"), terminatedExecutor)
		stored, _ := reopened.State("v")
		if stored.Phase != PhaseRevoking || stored.Commands["bind-uncertain"].LaunchTarget == nil || stored.Commands["bind-uncertain"].Status != CommandUnknown {
			t.Fatalf("running executor forgotten: %+v", stored)
		}
	})
}

func TestDockerLaunchRejectsRootCapabilitiesAndUnsafePrivateFilesBeforeCreate(t *testing.T) {
	for _, policy := range []DockerLaunchPolicy{
		{ImageID: "tag:mutable", NetworkID: "none", UID: 10000, GID: 10000},
		{ImageID: "sha256:" + strings.Repeat("b", 64), NetworkID: "host", UID: 10000, GID: 10000},
		{ImageID: "sha256:" + strings.Repeat("b", 64), NetworkID: "container:other", UID: 10000, GID: 10000},
		{ImageID: "sha256:" + strings.Repeat("b", 64), NetworkID: "none", UID: 0, GID: 0},
	} {
		if _, err := newDockerLauncher("/tmp/synthetic-engine.sock", "/tmp/synthetic-node", "synthetic-boot", nil, policy); err == nil {
			t.Fatalf("unsafe launch policy accepted: %+v", policy)
		}
	}
	a, launcher, engine, state, root := launchFixture(t)
	config := filepath.Join(root, "vms", "v", "incarnations", state.Fence.Incarnation, "config", "kernel.json")
	if err := os.Remove(config); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, "authority", "authority.json"), config); err != nil {
		t.Fatal(err)
	}
	if _, err := launcher.Launch(context.Background(), "v", state.Fence, "unsafe-file"); err == nil {
		t.Fatal("followed config symlink")
	}
	engine.mu.Lock()
	calls := append([]string(nil), engine.calls...)
	engine.mu.Unlock()
	if len(calls) != 0 {
		t.Fatalf("unsafe file reached Engine: %v", calls)
	}
	stored, _ := a.State("v")
	if _, exists := stored.Commands["unsafe-file"]; exists {
		t.Fatal("invalid preparation reserved a launch")
	}
}

func TestDockerLaunchJournalFailureSendsNoCreateAndDispatchedLaunchCannotBeCompleted(t *testing.T) {
	a, launcher, engine, state, root := launchFixture(t)
	journal := filepath.Join(root, "authority", "authority.json")
	if err := os.Rename(journal, journal+".saved"); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(journal, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := launcher.Launch(context.Background(), "v", state.Fence, "persist-before-create"); err == nil {
		t.Fatal("journal failure authorized create")
	}
	engine.mu.Lock()
	calls := append([]string(nil), engine.calls...)
	engine.mu.Unlock()
	for _, call := range calls {
		if strings.HasPrefix(call, "POST ") {
			t.Fatalf("mutation before durable launch: %v", calls)
		}
	}
	if err := os.Remove(journal); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(journal+".saved", journal); err != nil {
		t.Fatal(err)
	}
	if err := a.Close(); err != nil {
		t.Fatal(err)
	}
	reopened := authorityForTest(t, filepath.Join(root, "authority"), terminatedExecutor)
	handle, err := reopened.BeginLaunch("v", state.Fence, "node-launch")
	if err != nil {
		t.Fatal(err)
	}
	if err = reopened.StartLaunch(handle); err != nil {
		t.Fatal(err)
	}
	requireAuthorityError(t, reopened.CompleteCommand(handle), ErrAuthorityPhase)
}

func TestKSG2LaunchCreatesAndBindsWithNodePolicyAndRejectsRawSpec(t *testing.T) {
	a, launcher, engine, state, root := launchFixture(t)
	if err := a.Close(); err != nil {
		t.Fatal(err)
	}
	s, err := New(Config{Listen: "127.0.0.1:0", Root: root, Token: testToken, TLSDir: filepath.Join(root, "tls"), Fenced: true, AuthorityDir: filepath.Join(root, "authority"), DockerSocket: engine.socket, Launch: &launcher.policy, Management: managementConfigForTest()})
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
	c, err := tls.Dial("tcp", ln.Addr().String(), &tls.Config{InsecureSkipVerify: true, MinVersion: tls.VersionTLS13})
	if err != nil {
		t.Fatal(err)
	}
	c.SetDeadline(time.Now().Add(3 * time.Second))
	raw, _ := json.Marshal(map[string]any{"op": "launch", "vm_id": "v", "fence": state.Fence, "command_id": "raw-spec-forbidden", "HostConfig": map[string]any{"Privileged": true, "Binds": []string{"/:/host"}}})
	fmt.Fprintf(c, "KSG2 %s\n%s\n", testToken, raw)
	line, _ := bufio.NewReader(c).ReadString('\n')
	c.Close()
	if line != "ERR bad_request\n" {
		t.Fatalf("raw Docker spec accepted: %q", line)
	}
	engine.mu.Lock()
	count := len(engine.calls)
	engine.mu.Unlock()
	if count != 0 {
		t.Fatal("raw spec reached Engine")
	}
	s.authorizeCommand = allowNodeCommandForTest
	intent := launchIntentForTest(state, "trusted-node-launch")
	reply := gate2Control(t, ln.Addr().String(), gate2Request{Op: "launch", VMID: "v", Management: &intent})
	if !reply.OK {
		t.Fatalf("KSG2 launch: %+v", reply)
	}
	active, _ := s.authority.State("v")
	if active.Phase != PhaseActive || active.Fence.Executor.ContainerID != engine.container {
		t.Fatalf("KSG2 active: %+v", active)
	}
}

func TestDockerLaunchChecksFixedBridgeNetworkBeforeCreate(t *testing.T) {
	for _, driver := range []string{"bridge", "host"} {
		t.Run(driver, func(t *testing.T) {
			_, launcher, engine, state, _ := launchFixtureConfigured(t, true, strings.Repeat("e", 64))
			engine.networkDriver = driver
			_, err := launcher.Launch(context.Background(), "v", state.Fence, "fixed-network")
			if driver == "bridge" {
				if err != nil {
					t.Fatal(err)
				}
			} else {
				if err == nil {
					t.Fatal("non-bridge network was accepted")
				}
				engine.mu.Lock()
				calls := append([]string(nil), engine.calls...)
				engine.mu.Unlock()
				for _, call := range calls {
					if strings.HasPrefix(call, "POST ") {
						t.Fatalf("unsafe network reached create: %v", calls)
					}
				}
			}
		})
	}
}
