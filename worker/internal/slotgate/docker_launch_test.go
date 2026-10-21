package slotgate

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakeLaunchEngine struct {
	mu            sync.Mutex
	image         string
	container     string
	startedAt     string
	spec          map[string]any
	calls         []string
	failStart     bool
	badCreateID   bool
	createEntered chan struct{}
	createProceed chan struct{}
	onInspect     func()
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
	t.Helper()
	root := shortRoot(t)
	boot, err := nodeBootID()
	if err != nil {
		t.Fatal(err)
	}
	a := authorityForTest(t, filepath.Join(root, "authority"), terminatedExecutor)
	state, err := a.CreateSlot("v")
	if err != nil {
		t.Fatal(err)
	}
	policy := DockerLaunchPolicy{ImageID: "sha256:" + strings.Repeat("b", 64), NetworkID: "none", UID: os.Getuid(), GID: os.Getgid()}
	if policy.UID == 0 {
		policy.UID = 10000
		policy.GID = 10000
	}
	private := filepath.Join(root, "vms", "v", "incarnations", state.Fence.Incarnation)
	for _, dir := range []string{"config", "run", "home", "claude"} {
		if err = os.MkdirAll(filepath.Join(private, dir), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	for _, file := range []string{"kernel.json", "internal.token"} {
		if err = os.WriteFile(filepath.Join(private, "config", file), []byte("synthetic-only"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	fake := &fakeLaunchEngine{image: policy.ImageID, container: strings.Repeat("c", 64), startedAt: "2026-10-21T01:00:00Z"}
	socket := filepath.Join(shortRoot(t), "docker.sock")
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
	finished := make(chan error, 1)
	go func() {
		_, err := launcher.Launch(context.Background(), "v", state.Fence, "slow-create")
		finished <- err
	}()
	<-engine.createEntered
	admitted := make(chan error, 1)
	go func() { _, err := a.BeginCommand("other", other.Fence, "parallel", CommandForward); admitted <- err }()
	select {
	case err := <-admitted:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		close(engine.createProceed)
		t.Fatal("Engine I/O held the Authority global lock")
	}
	if _, err := a.Revoke("v", state.Fence); err != nil {
		t.Fatal(err)
	}
	_, err := a.Advance(context.Background(), "v", state.Fence)
	requireAuthorityError(t, err, ErrPendingMutation)
	close(engine.createProceed)
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
