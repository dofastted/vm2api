package slotgate

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNodeRefreshTokenIsPrivateAndNeverProjectedIntoGuest(t *testing.T) {
	f := publishingFixture(t)
	f.publish(t)
	guest, err := os.ReadFile(filepath.Join(f.private(), "claude", "credentials.json"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(guest), "synthetic-refresh") || strings.Contains(string(guest), "refreshToken") {
		t.Fatal("refresh token reached the guest credential projection")
	}
	private, err := os.ReadFile(filepath.Join(f.a.root, "credentials", "v", f.intent.Fence.Incarnation, "credentials.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(private), "synthetic-refresh") {
		t.Fatal("node canonical credential lost its refresh token")
	}
	state, _ := f.a.State("v")
	data, _ := json.Marshal(state.InitialManifest)
	if !strings.Contains(string(data), `"credential_authority":"node-private-v1"`) {
		t.Fatal("manifest lacks node-private ownership proof")
	}
}

func TestNodePrivateCredentialHealthRejectsStableGuestReplacement(t *testing.T) {
	f, addr, _, state := activeHealthGate(t)
	file := filepath.Join(f.private(), "claude", "credentials.json")
	if err := os.Chmod(file, 0o600); err != nil {
		t.Fatal(err)
	}
	// Same account, plausible newer generation and a stable file for the whole
	// health read still cannot become the canonical node credential.
	if err := os.WriteFile(file, []byte(`{"type":"oauth","claudeAiOauth":{"accessToken":"guest-replacement","accountUuid":"synthetic-account","kinGeneration":2}}`), 0o400); err != nil {
		t.Fatal(err)
	}
	unixHTTP(t, filepath.Join(f.private(), "run", "kernel.sock"), http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"ok":true}`)
	}))
	if reply := readNodeHealth(t, addr, capturedHealthRequest(state)); reply.OK {
		t.Fatal("guest replacement became the authoritative credential generation")
	}
}
