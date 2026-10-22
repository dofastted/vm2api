package slotgate

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type nodeHealthReply struct {
	OK               bool           `json:"ok"`
	Error            string         `json:"error"`
	Fence            Fence          `json:"fence"`
	ManifestRevision string         `json:"manifest_revision"`
	ManifestDigest   string         `json:"manifest_digest"`
	Health           map[string]any `json:"health"`
}

func capturedHealthRequest(state AuthorityState) map[string]any {
	return map[string]any{"op": "health", "vm_id": "v", "fence": state.Fence, "manifest_revision": "1", "manifest_digest": state.InitialManifest.Receipt.ManifestDigest}
}

func readNodeHealth(t *testing.T, addr string, request map[string]any) nodeHealthReply {
	t.Helper()
	c, err := tls.Dial("tcp", addr, &tls.Config{InsecureSkipVerify: true, MinVersion: tls.VersionTLS13})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(5 * time.Second))
	data, _ := json.Marshal(request)
	fmt.Fprintf(c, "KSG2 %s\n%s\n", testToken, data)
	var reply nodeHealthReply
	if err = json.NewDecoder(bufio.NewReader(c)).Decode(&reply); err != nil {
		t.Fatal(err)
	}
	return reply
}

func activeHealthGate(t *testing.T) (*publicationFixture, string, *Server, AuthorityState) {
	t.Helper()
	f := publishingFixture(t)
	f.publish(t)
	state, _ := f.a.State("v")
	if _, err := f.l.LaunchManifest(context.Background(), launchIntentForTest(state, "health-launch"), allowNodeCommandForTest); err != nil {
		t.Fatal(err)
	}
	addr, s := publishingGate(t, f)
	state, _ = s.authority.State("v")
	return f, addr, s, state
}

func TestNodeHealthUsesCapturedManifestAndFixedKernelReadWithoutExecution(t *testing.T) {
	f, addr, s, state := activeHealthGate(t)
	token, err := readPublishedInitial(f.root, "v", state.Fence, f.l.policy, *state.InitialManifest, false)
	if err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int64
	unixHTTP(t, filepath.Join(f.private(), "run", "kernel.sock"), http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Method != "GET" || r.URL.RequestURI() != "/internal/health" || r.Header.Get("x-internal-token") != token || r.Header.Get("x-kin-internal-token") != token {
			t.Error("health did not use the fixed authenticated node route")
		}
		body, _ := io.ReadAll(r.Body)
		if len(body) != 0 {
			t.Error("health sent caller body")
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"ok":true,"healthy":true,"ready_slots":1,"version":"synthetic","credential_state":"ready","access_token":"synthetic-secret-do-not-return","nested":{"refresh_token":"synthetic-secret-do-not-return"}}`)
	}))
	before, _ := s.authority.State("v")
	reply := readNodeHealth(t, addr, capturedHealthRequest(state))
	if !reply.OK || reply.Fence != state.Fence || reply.ManifestRevision != "1" || reply.ManifestDigest != state.InitialManifest.Receipt.ManifestDigest {
		t.Fatalf("health lacks original captured proof: %+v", reply)
	}
	credential, ok := reply.Health["credential"].(map[string]any)
	if !ok || credential["account_uuid"] != "synthetic-account" || credential["has_access"] != true || credential["has_refresh"] != true {
		t.Fatalf("node credential identity missing: %+v", reply.Health)
	}
	for _, key := range []string{"expires_at", "generation"} {
		if _, ok := credential[key]; !ok {
			t.Fatalf("missing credential summary %s", key)
		}
	}
	encoded, _ := json.Marshal(reply)
	if strings.Contains(string(encoded), "synthetic-secret-do-not-return") || strings.Contains(string(encoded), "synthetic-access") || strings.Contains(string(encoded), token) {
		t.Fatal("health returned secret contents")
	}
	after, _ := s.authority.State("v")
	if calls.Load() != 1 || len(after.Commands) != len(before.Commands) {
		t.Fatal("read-only health created an execution or repeated a kernel request")
	}
}

func TestNodeInitialPublishRequiresAndPersistsCredentialIdentity(t *testing.T) {
	without := []byte(`{"credential":{"type":"oauth","access_token":"synthetic"}}`)
	if _, err := initialCredentialBytes(without); err == nil {
		t.Fatal("initial publication accepts credentials without authoritative account identity")
	}
	with := []byte(`{"credential":{"type":"oauth","access_token":"synthetic","account_uuid":"synthetic-account","org_uuid":"synthetic-org","email":"synthetic@example.test"}}`)
	data, err := initialCredentialBytes(with)
	if err != nil {
		t.Fatal(err)
	}
	var document struct {
		OAuth struct {
			Account string `json:"accountUuid"`
			Org     string `json:"orgUuid"`
			Email   string `json:"email"`
		} `json:"claudeAiOauth"`
	}
	if err = json.Unmarshal(data, &document); err != nil {
		t.Fatal(err)
	}
	if document.OAuth.Account != "synthetic-account" || document.OAuth.Org != "synthetic-org" || document.OAuth.Email != "synthetic@example.test" {
		t.Fatal("publication did not use the existing credential identity schema")
	}
}

func TestNodeHealthRejectsUnknownManagementAndRechecksFenceAfterKernelRead(t *testing.T) {
	for _, phase := range []string{"unknown-management", "revoked-during-read"} {
		t.Run(phase, func(t *testing.T) {
			f, addr, s, state := activeHealthGate(t)
			var calls atomic.Int64
			if phase == "unknown-management" {
				if _, err := s.authority.BeginCommand("v", state.Fence, "unknown-management", CommandMutation); err != nil {
					t.Fatal(err)
				}
			}
			unixHTTP(t, filepath.Join(f.private(), "run", "kernel.sock"), http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if _, err := s.authority.Revoke("v", state.Fence); err != nil {
					t.Error(err)
				}
				w.Header().Set("Content-Type", "application/json")
				fmt.Fprint(w, `{"ok":true,"healthy":true}`)
			}))
			reply := readNodeHealth(t, addr, capturedHealthRequest(state))
			if reply.OK {
				t.Fatal("unknown/revoked management returned running proof")
			}
			if phase == "unknown-management" && calls.Load() != 0 {
				t.Fatal("unknown management reached kernel")
			}
		})
	}
}

func TestNodeHealthRejectsStaleManifestAndCredentialIdentityChange(t *testing.T) {
	for _, change := range []string{"fence", "manifest", "identity"} {
		t.Run(change, func(t *testing.T) {
			f, addr, _, state := activeHealthGate(t)
			var calls atomic.Int64
			unixHTTP(t, filepath.Join(f.private(), "run", "kernel.sock"), http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				w.Header().Set("Content-Type", "application/json")
				fmt.Fprint(w, `{"ok":true,"healthy":true}`)
			}))
			request := capturedHealthRequest(state)
			switch change {
			case "fence":
				other := state.Fence
				other.Incarnation = strings.Repeat("a", 32)
				request["fence"] = other
			case "manifest":
				request["manifest_digest"] = strings.Repeat("a", 64)
			case "identity":
				file := filepath.Join(f.private(), "claude", "credentials.json")
				if err := os.Chmod(file, 0o600); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(file, []byte(`{"type":"oauth","claudeAiOauth":{"accessToken":"synthetic-other","accountUuid":"different-account","kinGeneration":2}}`), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			if reply := readNodeHealth(t, addr, request); reply.OK {
				t.Fatal("stale proof or changed credential account was accepted")
			}
			if change != "identity" && calls.Load() != 0 {
				t.Fatal("stale fence/manifest reached kernel")
			}
		})
	}
}

func TestNodeHealthRejectsIncompleteInvalidAndContradictoryKernelResponses(t *testing.T) {
	for _, kind := range []string{"truncated", "duplicate", "trailing", "counter", "credential-identity", "identity", "trailer", "status"} {
		t.Run(kind, func(t *testing.T) {
			f, addr, _, state := activeHealthGate(t)
			unixHTTP(t, filepath.Join(f.private(), "run", "kernel.sock"), http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				switch kind {
				case "truncated":
					w.Header().Set("Content-Length", "1000")
					fmt.Fprint(w, `{"ok":true}`)
				case "duplicate":
					fmt.Fprint(w, `{"ok":true,"ok":false}`)
				case "trailing":
					fmt.Fprint(w, `{"ok":true} {"error":"synthetic"}`)
				case "counter":
					fmt.Fprint(w, `{"ok":true,"ready_slots":-1}`)
				case "credential-identity":
					fmt.Fprint(w, `{"ok":true,"credential":{"account_uuid":"different-account"}}`)
				case "identity":
					fmt.Fprint(w, `{"ok":true,"identity":{"account_uuid":"different-account"}}`)
				case "trailer":
					w.Header().Set("Trailer", "X-Internal-Error")
					fmt.Fprint(w, `{"ok":true}`)
					w.Header().Set("X-Internal-Error", "synthetic")
				case "status":
					w.WriteHeader(502)
					fmt.Fprint(w, `{"ok":true}`)
				}
			}))
			if reply := readNodeHealth(t, addr, capturedHealthRequest(state)); reply.OK || reply.Health != nil {
				t.Fatalf("invalid response escaped as health proof: %+v", reply)
			}
		})
	}
}

func TestNodeHealthCredentialRotationInvalidatesReadAndTokenTamperNeverSends(t *testing.T) {
	for _, kind := range []string{"rotation", "token"} {
		t.Run(kind, func(t *testing.T) {
			f, addr, _, state := activeHealthGate(t)
			var calls atomic.Int64
			unixHTTP(t, filepath.Join(f.private(), "run", "kernel.sock"), http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if kind == "rotation" {
					file := filepath.Join(f.private(), "claude", "credentials.json")
					if err := os.Chmod(file, 0o600); err != nil {
						t.Error(err)
					}
					if err := os.WriteFile(file, []byte(`{"type":"oauth","claudeAiOauth":{"accessToken":"synthetic-rotated","accountUuid":"synthetic-account","kinGeneration":2}}`), 0o600); err != nil {
						t.Error(err)
					}
				}
				w.Header().Set("Content-Type", "application/json")
				fmt.Fprint(w, `{"ok":true}`)
			}))
			if kind == "token" {
				if err := os.WriteFile(filepath.Join(f.private(), "config", "internal.token"), []byte(strings.Repeat("d", 64)+"\n"), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			if reply := readNodeHealth(t, addr, capturedHealthRequest(state)); reply.OK {
				t.Fatal("credential/token change accepted")
			}
			if kind == "token" && calls.Load() != 0 {
				t.Fatal("tampered token reached kernel")
			}
		})
	}
}

func TestNodeHealthCredentialSummaryUsesExistingSchemaAndExactGeneration(t *testing.T) {
	data := []byte(`{"type":"oauth","claudeAiOauth":{"accessToken":"synthetic","refreshToken":"synthetic-refresh","accountUuid":"synthetic-account","orgUuid":"synthetic-org","email":"synthetic@example.test","kinGeneration":9007199254740993,"expiresAt":1700000000}}`)
	summary, identity, err := nodeCredentialSummary(data, credentialIdentity{AccountUUID: "synthetic-account"})
	if err != nil {
		t.Fatal(err)
	}
	if summary["generation"] != "9007199254740993" || summary["expires_at"] != "1700000000000" || identity["account_uuid"] != "synthetic-account" || identity["org_uuid"] != "synthetic-org" || identity["email"] != "synthetic@example.test" {
		t.Fatalf("credential summary changed stored semantics: %+v %+v", summary, identity)
	}
	for _, invalid := range []string{`{"type":"oauth","claudeAiOauth":{"accessToken":"synthetic"}}`, `{"type":"oauth","claudeAiOauth":{"accessToken":"synthetic","accountUuid":"synthetic-account","kinGeneration":true}}`, `{"type":"oauth","claudeAiOauth":{"accessToken":"synthetic","accountUuid":"synthetic-account","expiresAt":9223372036854775808}}`} {
		if _, _, err = nodeCredentialSummary([]byte(invalid), credentialIdentity{AccountUUID: "synthetic-account"}); err == nil {
			t.Fatal("invalid credential summary accepted")
		}
	}
}
