package slotgate

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
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

func allowNodeCommandForTest(_ context.Context, _ ManagementIntent, dispatch func() error) error {
	return dispatch()
}
func managementConfigForTest() *PGManagementConfig {
	return &PGManagementConfig{ConnectionString: "postgres://synthetic_reader@127.0.0.1:1/synthetic_test?sslmode=disable", AuthoritySchema: "vm2api_node_" + strings.Repeat("a", 32), NodeID: "node-test"}
}
func publicationIntentForTest(allocation AllocationReceipt, policy DockerLaunchPolicy, payload []byte) ManagementIntent {
	return ManagementIntent{Action: "publish-initial", NodeID: allocation.NodeID, VMID: allocation.VMID, AllocationID: allocation.AllocationID, OperationID: "publish-operation", OwnerID: "publish-owner", CommandID: "publish-command", Epoch: "1", Fence: allocation.Fence, ExpectedManifestRevision: "0", ManifestRevision: "1", PayloadDigest: hashBytes(payload), PresetID: initialPresetID, PolicyDigest: policy.digest()}
}
func launchIntentForTest(state AuthorityState, id string) ManagementIntent {
	i := state.InitialManifest.Receipt.Intent
	i.Action = "launch"
	i.OperationID = "launch-operation"
	i.OwnerID = "launch-owner"
	i.CommandID = id
	i.ExpectedManifestRevision = "1"
	i.PayloadDigest = ""
	i.ManifestDigest = state.InitialManifest.Receipt.ManifestDigest
	return i
}

type publicationFixture struct {
	a       *Authority
	p       *initialPublisher
	l       *dockerLauncher
	engine  *fakeLaunchEngine
	state   AuthorityState
	root    string
	intent  ManagementIntent
	payload []byte
}

func publishingFixture(t *testing.T) *publicationFixture {
	t.Helper()
	a, l, engine, state, root := launchFixtureConfigured(t, false, "none")
	if err := os.RemoveAll(filepath.Join(root, "vms", "v", "incarnations", state.Fence.Incarnation)); err != nil {
		t.Fatal(err)
	}
	payload := []byte(`{"credential":{"type":"oauth","account_uuid":"synthetic-account","access_token":"synthetic-access","refresh_token":"synthetic-refresh","scopes":["user:inference"]}}`)
	intent := publicationIntentForTest(*state.Allocation, l.policy, payload)
	return &publicationFixture{a: a, p: &initialPublisher{authority: a, root: root, nodeID: intent.NodeID, policy: l.policy, authorize: allowNodeCommandForTest}, l: l, engine: engine, state: state, root: root, intent: intent, payload: payload}
}
func (f *publicationFixture) publish(t *testing.T) PublicationReceipt {
	t.Helper()
	receipt, err := f.p.Publish(context.Background(), f.intent, len(f.payload), strings.NewReader(string(f.payload)))
	if err != nil {
		t.Fatal(err)
	}
	return receipt
}
func (f *publicationFixture) private() string {
	return filepath.Join(f.root, "vms", "v", "incarnations", f.intent.Fence.Incarnation)
}

// An existing directory is not proof that node-owned publication completed.
// In particular, a leftover tree after rename/journal failure must not launch.
func TestInitialPublishUnrecordedTreeCannotReachDocker(t *testing.T) {
	_, launcher, engine, state, _ := launchFixtureConfigured(t, false, "none")
	if _, err := launcher.Launch(context.Background(), "v", state.Fence, "unrecorded-publication"); err == nil {
		t.Fatal("launch accepted files without a durable completed manifest")
	}
	engine.mu.Lock()
	defer engine.mu.Unlock()
	if len(engine.calls) != 0 {
		t.Fatalf("unrecorded publication reached Docker: %v", engine.calls)
	}
}

// Allocation and inference authorization cannot stand in for a publish grant.
func TestInitialPublishRequiresIndependentManagementAuthorization(t *testing.T) {
	addr, _, _, state, _ := fencedGate(t)
	reply := gate2Control(t, addr, gate2Request{Op: "publish-initial", VMID: "v", Fence: state.Fence, CommandID: "unauthorized-publication"})
	if reply.OK || reply.Error != ErrManagementDenied.Error() {
		t.Fatalf("publish without an independent action authorizer: %+v", reply)
	}
}

func TestInitialPublishGeneratesPrivateFilesAndPersistsOnlyDigests(t *testing.T) {
	f := publishingFixture(t)
	receipt := f.publish(t)
	if receipt.Intent != f.intent || receipt.IntentDigest != f.intent.digest() || receipt.ManifestRevision != "1" || !validDigest(receipt.ManifestDigest) {
		t.Fatalf("receipt identity: %+v", receipt)
	}
	state, err := f.a.State("v")
	if err != nil {
		t.Fatal(err)
	}
	if state.InitialManifest == nil || state.Commands[f.intent.CommandID].Status != CommandCompleted {
		t.Fatalf("missing durable manifest: %+v", state)
	}
	token, err := readPublishedInitial(f.root, "v", f.intent.Fence, f.l.policy, *state.InitialManifest, true)
	if err != nil || len(token) != 64 {
		t.Fatalf("private files: %v", err)
	}
	kernel, err := os.ReadFile(filepath.Join(f.private(), "config", "kernel.json"))
	if err != nil {
		t.Fatal(err)
	}
	var config map[string]any
	if json.Unmarshal(kernel, &config) != nil || config["internal_token"] != token || config["claude_bin"] != "/opt/kin/cli-node" || config["test_endpoints"] != false {
		t.Fatal("node did not generate the approved config")
	}
	journal, err := os.ReadFile(filepath.Join(f.a.root, "authority.json"))
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(receipt)
	for _, body := range [][]byte{journal, encoded} {
		if strings.Contains(string(body), token) || strings.Contains(string(body), "synthetic-access") || strings.Contains(string(body), "synthetic-refresh") {
			t.Fatal("secret bytes escaped into journal or receipt")
		}
	}
	second := f.publish(t)
	if second != receipt {
		t.Fatal("completed replay changed its receipt")
	}
	state.InitialManifest.Receipt.ManifestDigest = "mutated-local-copy"
	stored, _ := f.a.State("v")
	if stored.InitialManifest.Receipt != receipt {
		t.Fatal("state exposed mutable manifest")
	}
}

func TestInitialPublishFaultsRemainUnknownAndNeverReissue(t *testing.T) {
	for _, point := range []string{"staged", "before-rename", "after-rename", "before-manifest-journal"} {
		t.Run(point, func(t *testing.T) {
			f := publishingFixture(t)
			failure := errors.New("synthetic " + point)
			f.p.fault = func(got string) error {
				if got == point {
					return failure
				}
				return nil
			}
			_, err := f.p.Publish(context.Background(), f.intent, len(f.payload), strings.NewReader(string(f.payload)))
			if err != failure {
				t.Fatalf("fault identity: %v", err)
			}
			state, _ := f.a.State("v")
			if state.InitialManifest != nil || state.Commands[f.intent.CommandID].Status != CommandPending {
				t.Fatalf("unknown falsely completed: %+v", state)
			}
			f.p.fault = nil
			if _, err = f.p.Publish(context.Background(), f.intent, len(f.payload), strings.NewReader(string(f.payload))); !errors.Is(err, ErrCommandExists) {
				t.Fatalf("unknown was reissued: %v", err)
			}
			if _, err = f.l.Launch(context.Background(), "v", f.intent.Fence, "launch-after-unknown"); err == nil {
				t.Fatal("unknown publication launched")
			}
			if _, err = f.a.Revoke("v", f.intent.Fence); err != nil {
				t.Fatal(err)
			}
			if _, err = f.a.Advance(context.Background(), "v", f.intent.Fence); !errors.Is(err, ErrPendingMutation) {
				t.Fatalf("unknown publication advanced: %v", err)
			}
			if err = f.a.Close(); err != nil {
				t.Fatal(err)
			}
			reopened := authorityForTest(t, f.a.root, terminatedExecutor)
			state, _ = reopened.State("v")
			if state.Phase != PhaseRevoking || state.Commands[f.intent.CommandID].Status != CommandUnknown {
				t.Fatalf("restart adopted unknown publication: %+v", state)
			}
		})
	}
}

func TestInitialPublishRevalidatesGrantAndOriginalFenceBeforeRename(t *testing.T) {
	for _, revoke := range []bool{false, true} {
		t.Run(fmt.Sprint(revoke), func(t *testing.T) {
			f := publishingFixture(t)
			calls := 0
			f.p.authorize = func(ctx context.Context, intent ManagementIntent, dispatch func() error) error {
				calls++
				if calls == 2 {
					if revoke {
						if _, err := f.a.Revoke("v", f.intent.Fence); err != nil {
							t.Fatal(err)
						}
					} else {
						return ErrManagementDenied
					}
				}
				return dispatch()
			}
			if _, err := f.p.Publish(context.Background(), f.intent, len(f.payload), strings.NewReader(string(f.payload))); err == nil {
				t.Fatal("revoked/fence-changed publication succeeded")
			}
			if _, err := os.Lstat(f.private()); !os.IsNotExist(err) {
				t.Fatalf("final path changed without fresh original authorization: %v", err)
			}
		})
	}
}

func TestInitialPublishRejectsSymlinksHardlinksUnexpectedFilesAndChangedBytes(t *testing.T) {
	for _, kind := range []string{"parent-symlink", "kernel-hardlink", "credential-symlink", "extra-file", "changed-token", "existing-final"} {
		t.Run(kind, func(t *testing.T) {
			f := publishingFixture(t)
			if kind == "parent-symlink" {
				parent := filepath.Dir(f.private())
				if err := os.Remove(parent); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(t.TempDir(), parent); err != nil {
					t.Fatal(err)
				}
			}
			f.p.fault = func(point string) error {
				if point != "staged" {
					return nil
				}
				parent := filepath.Dir(f.private())
				entries, err := os.ReadDir(parent)
				if err != nil {
					return err
				}
				var stage string
				for _, entry := range entries {
					if strings.HasPrefix(entry.Name(), ".stage-") {
						stage = filepath.Join(parent, entry.Name())
					}
				}
				switch kind {
				case "kernel-hardlink":
					return os.Link(filepath.Join(stage, "config", "kernel.json"), filepath.Join(f.root, "extra-hardlink"))
				case "credential-symlink":
					file := filepath.Join(stage, "claude", "credentials.json")
					if err := os.Remove(file); err != nil {
						return err
					}
					return os.Symlink(filepath.Join(f.a.root, "authority.json"), file)
				case "extra-file":
					return os.WriteFile(filepath.Join(stage, "extra"), []byte("denied"), 0o600)
				case "changed-token":
					return os.WriteFile(filepath.Join(stage, "config", "internal.token"), []byte(strings.Repeat("c", 64)+"\n"), 0o600)
				case "existing-final":
					return os.Mkdir(f.private(), 0o700)
				}
				return nil
			}
			if _, err := f.p.Publish(context.Background(), f.intent, len(f.payload), strings.NewReader(string(f.payload))); err == nil {
				t.Fatal("unsafe tree was published")
			}
			state, _ := f.a.State("v")
			if state.InitialManifest != nil {
				t.Fatal("unsafe tree received completed manifest")
			}
		})
	}
}

func TestInitialPublishRejectsArbitraryConfigAndMalformedCredentialPayload(t *testing.T) {
	for _, payload := range []string{
		`{"credential":{"type":"oauth","account_uuid":"synthetic-account","access_token":"synthetic"},"path":"../../authority.json"}`,
		`{"credential":{"type":"oauth","account_uuid":"synthetic-account","access_token":"synthetic","base_url":"http://unapproved"}}`,
		`{"credential":{"type":"oauth","account_uuid":"synthetic-account","access_token":"synthetic","access_token":"changed"}}`,
		`{"credential":{"type":"oauth","account_uuid":"synthetic-account","access_token":"synthetic"}} {}`,
		`{"credential":{"type":"arbitrary","access_token":"synthetic"}}`,
		`{"credential":{"type":"official-setup-token","access_token":"synthetic","refresh_token":"unexpected"}}`,
	} {
		t.Run(hashText(payload)[:8], func(t *testing.T) {
			f := publishingFixture(t)
			f.payload = []byte(payload)
			f.intent.PayloadDigest = hashBytes(f.payload)
			if _, err := f.p.Publish(context.Background(), f.intent, len(f.payload), strings.NewReader(payload)); err == nil {
				t.Fatal("unapproved payload accepted")
			}
			if _, err := os.Lstat(f.private()); !os.IsNotExist(err) {
				t.Fatal("invalid payload touched destination")
			}
		})
	}
}

func TestInitialPublishJournalFailureCannotReturnCompletionOrLaunch(t *testing.T) {
	f := publishingFixture(t)
	f.p.fault = func(point string) error {
		if point != "before-manifest-journal" {
			return nil
		}
		journal := filepath.Join(f.a.root, "authority.json")
		if err := os.Rename(journal, journal+".saved"); err != nil {
			return err
		}
		return os.Mkdir(journal, 0o700)
	}
	if _, err := f.p.Publish(context.Background(), f.intent, len(f.payload), strings.NewReader(string(f.payload))); err == nil {
		t.Fatal("journal failure returned completed")
	}
	if _, err := f.a.State("v"); !errors.Is(err, ErrAuthorityUnavailable) {
		t.Fatalf("journal failure did not poison authority: %v", err)
	}
	journal := filepath.Join(f.a.root, "authority.json")
	if err := os.Remove(journal); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(journal+".saved", journal); err != nil {
		t.Fatal(err)
	}
	if err := f.a.Close(); err != nil {
		t.Fatal(err)
	}
	a := authorityForTest(t, f.a.root, terminatedExecutor)
	state, _ := a.State("v")
	if state.InitialManifest != nil || state.Phase != PhaseRevoking {
		t.Fatal("restart adopted orphaned final directory")
	}
}

func publishingGate(t *testing.T, f *publicationFixture) (string, *Server) {
	t.Helper()
	if err := f.a.Close(); err != nil {
		t.Fatal(err)
	}
	s, err := New(Config{Listen: "127.0.0.1:0", Root: f.root, Token: testToken, TLSDir: filepath.Join(f.root, "tls"), Fenced: true, AuthorityDir: f.a.root, DockerSocket: f.engine.socket, Launch: &f.l.policy, Management: managementConfigForTest()})
	if err != nil {
		t.Fatal(err)
	}
	s.authorizeCommand = allowNodeCommandForTest
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
	return ln.Addr().String(), s
}

func TestInitialPublishKSG2LaunchAndForwardUseNodeTokenAndDenyManagementHTTP(t *testing.T) {
	f := publishingFixture(t)
	addr, s := publishingGate(t, f)
	c, reader := gate2Connect(t, addr, testToken, gate2Request{Op: "publish-initial", VMID: "v", Management: &f.intent, ContentLength: len(f.payload)}, string(f.payload))
	var publication struct {
		OK          bool               `json:"ok"`
		Publication PublicationReceipt `json:"publication"`
		Error       string             `json:"error"`
	}
	if err := json.NewDecoder(reader).Decode(&publication); err != nil {
		t.Fatal(err)
	}
	c.Close()
	if !publication.OK || publication.Publication.Intent != f.intent {
		t.Fatalf("publish wire: %+v", publication)
	}
	state, _ := s.authority.State("v")
	launch := launchIntentForTest(state, "launch-wire")
	if reply := gate2Control(t, addr, gate2Request{Op: "launch", VMID: "v", Management: &launch}); !reply.OK {
		t.Fatalf("launch wire: %+v", reply)
	}
	state, _ = s.authority.State("v")
	expectedToken, err := readPublishedInitial(f.root, "v", state.Fence, f.l.policy, *state.InitialManifest, false)
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	calls := 0
	socket := filepath.Join(f.private(), "run", "kernel.sock")
	unixHTTP(t, socket, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		calls++
		mu.Unlock()
		if r.Header.Get("x-kin-internal-token") != expectedToken || r.Header.Get("x-internal-token") != expectedToken {
			t.Error("controller overwrote node authentication")
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, normalClaudeJSON)
	}))
	request := forwardRequest(t, addr, state, "inference-wire")
	inferenceRequest := request
	body := `{"request_id":"inference-wire","body":{}}`
	c, reader = gate2Connect(t, addr, testToken, request, fmt.Sprintf("POST /internal/v1/messages HTTP/1.1\r\nHost: kernel\r\nx-kin-internal-token: attacker\r\nx-internal-token: attacker\r\nContent-Length: %d\r\n\r\n%s", len(body), body))
	if line, _ := reader.ReadString('\n'); line != "OK\n" {
		t.Fatalf("forward: %q", line)
	}
	response, err := http.ReadResponse(reader, nil)
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, response.Body)
	response.Body.Close()
	c.Close()
	request = forwardRequest(t, addr, state, "forbidden-import")
	c, reader = gate2Connect(t, addr, testToken, request, "POST /internal/import HTTP/1.1\r\nHost: kernel\r\nContent-Length: 2\r\n\r\n{}")
	if line, _ := reader.ReadString('\n'); line != "ERR management_denied\n" {
		t.Fatalf("management HTTP forwarded: %q", line)
	}
	c.Close()
	mu.Lock()
	defer mu.Unlock()
	if calls != 1 {
		t.Fatalf("unexpected kernel calls: %d", calls)
	}
	stored, _ := s.authority.State("v")
	deadline := time.Now().Add(time.Second)
	for stored.Commands["inference-wire"].Status != CommandCompleted && time.Now().Before(deadline) {
		inferenceRequest.Op = "command"
		connection, reply := gate2Connect(t, addr, testToken, inferenceRequest, "")
		var status struct {
			OK      bool `json:"ok"`
			Command struct {
				Status CommandStatus `json:"status"`
			} `json:"command"`
		}
		if err := json.NewDecoder(reply).Decode(&status); err != nil {
			t.Fatal(err)
		}
		connection.Close()
		if !status.OK {
			t.Fatal("original command status rejected")
		}
		stored, _ = s.authority.State("v")
	}
	if stored.Commands["inference-wire"].Status != CommandCompleted {
		t.Fatalf("normal inference did not persist completion: %+v", stored.Commands["inference-wire"])
	}
}

func TestInitialPublishLaunchPinsManifestAndIndependentAction(t *testing.T) {
	f := publishingFixture(t)
	f.publish(t)
	state, _ := f.a.State("v")
	intent := launchIntentForTest(state, "launch-grant")
	bad := intent
	bad.ManifestDigest = strings.Repeat("a", 64)
	if _, err := f.l.LaunchManifest(context.Background(), bad, allowNodeCommandForTest); err == nil {
		t.Fatal("wrong manifest launched")
	}
	if _, err := f.l.LaunchManifest(context.Background(), intent, nil); !errors.Is(err, ErrManagementDenied) {
		t.Fatalf("missing independent launch authorizer: %v", err)
	}
	receipt, err := f.l.LaunchManifest(context.Background(), intent, allowNodeCommandForTest)
	if err != nil {
		t.Fatal(err)
	}
	if receipt.Intent != intent || receipt.IntentDigest != intent.digest() || receipt.Fence.Executor.ContainerID != f.engine.container || receipt.Fence.Generation != intent.Fence.Generation || receipt.ManifestDigest != intent.ManifestDigest {
		t.Fatalf("launch receipt: %+v", receipt)
	}
	if _, err = f.l.LaunchManifest(context.Background(), intent, allowNodeCommandForTest); err == nil {
		t.Fatal("completed launch was reissued")
	}
}

func TestInitialPublishUploadDoesNotLockOtherVMsAndDuplicateCannotUpload(t *testing.T) {
	f := publishingFixture(t)
	other := launchForTest(t, f.a, "other", testExecutor("d"))
	reader, writer := io.Pipe()
	defer reader.Close()
	defer writer.Close()
	started := make(chan struct{})
	var once sync.Once
	f.p.authorize = func(_ context.Context, _ ManagementIntent, dispatch func() error) error {
		err := dispatch()
		once.Do(func() { close(started) })
		return err
	}
	done := make(chan error, 1)
	go func() { _, err := f.p.Publish(context.Background(), f.intent, len(f.payload), reader); done <- err }()
	<-started
	admitted := make(chan error, 1)
	go func() {
		_, err := f.a.BeginCommand("other", other.Fence, "parallel-during-upload", CommandForward)
		admitted <- err
	}()
	select {
	case err := <-admitted:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("upload held Authority lock")
	}
	if _, err := f.p.Publish(context.Background(), f.intent, len(f.payload), strings.NewReader(string(f.payload))); !errors.Is(err, ErrCommandExists) {
		t.Fatalf("duplicate upload accepted: %v", err)
	}
	writer.CloseWithError(errors.New("synthetic upload interruption"))
	if err := <-done; err == nil {
		t.Fatal("interrupted upload completed")
	}
	if _, err := f.l.Launch(context.Background(), "v", f.intent.Fence, "launch-interrupted-upload"); err == nil {
		t.Fatal("interrupted upload launched")
	}
}

func TestInitialPublishRejectsStaleFenceRevisionAndOversizedInputBeforeStaging(t *testing.T) {
	for _, kind := range []string{"fence", "revision", "size", "truncated", "digest"} {
		t.Run(kind, func(t *testing.T) {
			f := publishingFixture(t)
			intent := f.intent
			length := len(f.payload)
			source := string(f.payload)
			switch kind {
			case "fence":
				intent.Fence.Incarnation = strings.Repeat("d", 32)
			case "revision":
				intent.ExpectedManifestRevision = "1"
			case "size":
				length = initialPublishMax + 1
			case "truncated":
				source = source[:len(source)-1]
			case "digest":
				intent.PayloadDigest = strings.Repeat("a", 64)
			}
			if _, err := f.p.Publish(context.Background(), intent, length, strings.NewReader(source)); err == nil {
				t.Fatal("invalid publication accepted")
			}
			if _, err := os.Lstat(f.private()); !os.IsNotExist(err) {
				t.Fatal("invalid publication changed final path")
			}
		})
	}
}

func TestInitialPublishCompletedManifestAndLaunchReceiptSurviveNodeRestart(t *testing.T) {
	f := publishingFixture(t)
	receipt := f.publish(t)
	state, _ := f.a.State("v")
	intent := launchIntentForTest(state, "persisted-launch")
	launched, err := f.l.LaunchManifest(context.Background(), intent, allowNodeCommandForTest)
	if err != nil {
		t.Fatal(err)
	}
	if err = f.a.Close(); err != nil {
		t.Fatal(err)
	}
	a := authorityForTest(t, f.a.root, terminatedExecutor)
	state, err = a.State("v")
	if err != nil {
		t.Fatal(err)
	}
	if state.InitialManifest == nil || state.InitialManifest.Receipt != receipt || state.Phase != PhaseActive || state.Commands[intent.CommandID].LaunchReceipt == nil || *state.Commands[intent.CommandID].LaunchReceipt != launched {
		t.Fatalf("durable publication/launch lost: %+v", state)
	}
}
