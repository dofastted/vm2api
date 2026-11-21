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

// fakeCodex renders a composer, reads the paste, writes a rollout matching
// its own cwd, emits a message + task_complete, then stays alive briefly.
const fakeCodexScript = `#!/bin/bash
HOME_DIR="$CODEX_HOME"
SESSIONS="$HOME_DIR/sessions/$(date +%Y/%m/%d)"
mkdir -p "$SESSIONS"
printf '\xe2\x80\xba \n'   # "› " composer glyph so waitReady unblocks
cat > /dev/null &      # drain stdin so paste+enter never block on tty buffer
sleep 0.4
F="$SESSIONS/rollout-fake.jsonl"
printf '{"timestamp":"t","type":"session_meta","payload":{"cwd":"%s","id":"sess-fake","originator":"codex_cli_rs","cli_version":"0.1"}}\n' "$PWD" > "$F"
sleep 0.4
printf '{"timestamp":"t","type":"response_item","payload":{"type":"message","role":"assistant","id":"m1","content":[{"type":"output_text","text":"pong"}]}}\n' >> "$F"
printf '{"timestamp":"t","type":"token_usage_record","payload":{"usage":{"input_tokens":5,"cached_input_tokens":0,"output_tokens":2,"reasoning_output_tokens":0,"total_tokens":7}}}\n' >> "$F"
printf '{"timestamp":"t","type":"event_msg","payload":{"type":"task_complete"}}\n' >> "$F"
sleep 0.5
`

func TestRunTurnEndToEndWithFakeCodex(t *testing.T) {
	run := t.TempDir()
	bin := filepath.Join(run, "fake-codex.sh")
	if err := os.WriteFile(bin, []byte(fakeCodexScript), 0o755); err != nil {
		t.Fatal(err)
	}
	cfg := &Config{
		VMID:           "vm-t",
		CodexBin:       bin,
		CodexHome:      filepath.Join(run, "codex-home"),
		WorkspaceRoot:  filepath.Join(run, "codex-work"),
		CredentialPath: filepath.Join(run, "codex-credentials.json"),
		MaxParallel:    2,
		ReadyTimeout:   10 * time.Second,
		PasteTimeout:   3 * time.Second,
		IdleTimeout:    5 * time.Second,
		TurnTimeout:    30 * time.Second,
	}
	if err := os.WriteFile(cfg.CredentialPath, []byte(
		`{"access_token":"at","refresh_token":"rt","id_token":"it","account_id":"a"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	var events []string
	var lastPayload any
	emit := func(ev string, p any) { events = append(events, ev); lastPayload = p }

	env := &envelope{RequestID: "req-1", Body: json.RawMessage(
		`{"model":"gpt-5.2","input":"ping"}`)}
	if err := NewEngine(cfg).RunTurn(context.Background(), env, emit); err != nil {
		t.Fatalf("run turn: %v", err)
	}
	joined := strings.Join(events, ",")
	if !strings.Contains(joined, "response.completed") {
		t.Fatalf("no completed event in %s (last=%v)", joined, lastPayload)
	}
	p := lastPayload.(map[string]any)["response"].(map[string]any)
	if p["id"] != "sess-fake" {
		t.Fatalf("response id = %v", p["id"])
	}
}

func TestOverloadedReturnsQueueFull(t *testing.T) {
	cfg := &Config{MaxParallel: 1}
	e := NewEngine(cfg)
	e.workers = []*worker{{busy: true}} // pool full, the one worker is busy
	err := e.RunTurn(context.Background(), &envelope{RequestID: "x"}, func(string, any) {})
	if err != errOverloaded {
		t.Fatalf("want overloaded, got %v", err)
	}
	fmt.Sscan("") // silence
}

func TestPoolReuseAndSessionAffinity(t *testing.T) {
	e := NewEngine(&Config{MaxParallel: 2, WorkspaceRoot: t.TempDir()})

	w1, spawn, err := e.acquire(&envelope{RequestID: "a"}, "m1")
	if err != nil || !spawn {
		t.Fatalf("first acquire: spawn=%v err=%v", spawn, err)
	}
	e.release(w1) // released workers are alive only if a tui runs; dead → dropped
	if len(e.workers) != 0 {
		t.Fatalf("dead worker should be dropped, got %d", len(e.workers))
	}

	// Fake a live worker with a session, then confirm affinity.
	w := &worker{dir: "d", sessionID: "sess-1", t: &tui{done: make(chan struct{})}}
	e.workers = []*worker{w}
	e.sessions["sess-1"] = w
	got, spawn, err := e.acquire(&envelope{RequestID: "b", Session: struct {
		SessionID          string `json:"session_id"`
		PreviousResponseID string `json:"previous_response_id"`
	}{SessionID: "sess-1"}}, "other")
	if err != nil || spawn || got != w {
		t.Fatalf("affinity acquire: w=%p spawn=%v err=%v", got, spawn, err)
	}
	w.busy = false

	// Unknown session reserves a `codex resume` worker.
	rw, spawn, err := e.acquire(&envelope{RequestID: "c", Session: struct {
		SessionID          string `json:"session_id"`
		PreviousResponseID string `json:"previous_response_id"`
	}{SessionID: "sess-9"}}, "m1")
	if err != nil || !spawn || rw.resumeID != "sess-9" {
		t.Fatalf("resume acquire: spawn=%v resume=%q err=%v", spawn, rw.resumeID, err)
	}
}
