package codextui

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestComposePromptStringInput(t *testing.T) {
	b := &reqBody{Instructions: "be terse", Input: json.RawMessage(`"hello"`)}
	got, err := composePrompt(b)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, "[instructions]\nbe terse") || !strings.HasSuffix(got, "hello") {
		t.Fatalf("unexpected prompt: %q", got)
	}
}

func TestComposePromptItems(t *testing.T) {
	in := `[{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]},
	       {"type":"function_call","call_id":"c1","name":"shell","arguments":"{}"},
	       {"type":"function_call_output","call_id":"c1","output":"done"}]`
	b := &reqBody{Input: json.RawMessage(in)}
	got, err := composePrompt(b)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"[user] hi", "[tool_call c1] shell({})", "[tool_output c1] done"} {
		if !strings.Contains(got, want) {
			t.Fatalf("missing %q in %q", want, got)
		}
	}
}

func TestTranslateFeedEmitsUpstreamVocabulary(t *testing.T) {
	var events []string
	emit := func(ev string, _ any) { events = append(events, ev) }
	tr := newTranslate("sess-1", "gpt-5.2")

	tr.feed(rolloutLine{Type: "response_item", Payload: json.RawMessage(
		`{"type":"message","role":"assistant","id":"m1","content":[{"type":"output_text","text":"hi there"}]}`)}, emit)
	tr.feed(rolloutLine{Type: "token_usage", Payload: json.RawMessage(
		`{"input_tokens":10,"cached_input_tokens":4,"output_tokens":3,"reasoning_output_tokens":1,"total_tokens":13}`)}, emit)
	keep := tr.feed(rolloutLine{Type: "event_msg", Payload: json.RawMessage(`{"type":"task_complete"}`)}, emit)

	if keep {
		t.Fatal("expected terminal state")
	}
	joined := strings.Join(events, ",")
	for _, want := range []string{"response.output_item.added", "response.output_text.delta", "response.output_text.done", "response.output_item.done", "response.completed"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("missing %s in %s", want, joined)
		}
	}
}

func TestFindRolloutFileMatchesCWD(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, "sessions", "2026", "11", "21")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	turnDir := filepath.Join(t.TempDir(), "turn-x")
	meta := fmt.Sprintf(`{"timestamp":"t","type":"session_meta","payload":{"cwd":%q,"id":"s1","originator":"codex_cli_rs","cli_version":"0.1"}}`, turnDir) + "\n"
	path := filepath.Join(dir, "rollout-2026-11-21T00-00-00-abc.jsonl")
	if err := os.WriteFile(path, []byte(meta), 0o600); err != nil {
		t.Fatal(err)
	}
	got, id, err := findRolloutFile(context.Background(), home, turnDir, time.Now().Add(-time.Minute), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if got != path || id != "s1" {
		t.Fatalf("got %s id=%s", got, id)
	}
}

func TestEnsureHomeWritesAuthAndConfig(t *testing.T) {
	run := t.TempDir()
	cfg := &Config{
		CodexHome:      filepath.Join(run, "codex-home"),
		CredentialPath: filepath.Join(run, "codex-credentials.json"),
	}
	cred := `{"access_token":"at","refresh_token":"rt","id_token":"it","account_id":"acc-1"}`
	if err := os.WriteFile(cfg.CredentialPath, []byte(cred), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := ensureHome(cfg); err != nil {
		t.Fatal(err)
	}
	auth, _ := os.ReadFile(filepath.Join(cfg.CodexHome, "auth.json"))
	if !strings.Contains(string(auth), `"auth_mode": "chatgpt"`) || !strings.Contains(string(auth), "acc-1") {
		t.Fatalf("bad auth.json: %s", auth)
	}
	toml, _ := os.ReadFile(filepath.Join(cfg.CodexHome, "config.toml"))
	if !strings.Contains(string(toml), `approval_policy = "never"`) {
		t.Fatalf("bad config.toml: %s", toml)
	}
}
