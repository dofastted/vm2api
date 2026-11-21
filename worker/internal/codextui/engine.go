package codextui

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Engine runs codex turns: one request = one fresh TUI process in a unique
// per-turn workspace under a shared per-slot CODEX_HOME.
type Engine struct {
	cfg *Config

	sem     chan struct{}
	mu      sync.Mutex
	cancels map[string]context.CancelFunc
	homeErr error
}

func NewEngine(cfg *Config) *Engine {
	return &Engine{
		cfg:     cfg,
		sem:     make(chan struct{}, cfg.MaxParallel),
		cancels: map[string]context.CancelFunc{},
	}
}

// boot validates the slot home once; later calls reuse the cached result so
// a credential write race cannot wedge every request.
func (e *Engine) boot() error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.homeErr == nil {
		if err := ensureHome(e.cfg); err != nil {
			e.homeErr = err
		}
	}
	return e.homeErr
}

// Cancel aborts an in-flight turn by request_id (POST /internal/v1/cancel).
func (e *Engine) Cancel(requestID string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if cancel, ok := e.cancels[requestID]; ok {
		cancel()
		delete(e.cancels, requestID)
	}
}

// RunTurn executes one TUI turn and emits upstream-shaped SSE through emit.
// It never returns before a terminal response.* frame was emitted or the
// context died.
func (e *Engine) RunTurn(ctx context.Context, env *envelope, emit func(string, any)) error {
	select {
	case e.sem <- struct{}{}:
		defer func() { <-e.sem }()
	default:
		return errOverloaded
	}
	if err := e.boot(); err != nil {
		return err
	}
	var body reqBody
	if err := json.Unmarshal(env.Body, &body); err != nil {
		return fmt.Errorf("decode body: %w", err)
	}
	prompt, err := composePrompt(&body)
	if err != nil {
		return err
	}
	if prompt == "" {
		return fmt.Errorf("empty prompt after rendering input")
	}

	turnCtx, cancel := context.WithTimeout(ctx, e.cfg.TurnTimeout)
	defer cancel()
	e.mu.Lock()
	e.cancels[env.RequestID] = cancel
	e.mu.Unlock()
	defer func() {
		e.mu.Lock()
		delete(e.cancels, env.RequestID)
		e.mu.Unlock()
	}()

	turnDir := filepath.Join(e.cfg.WorkspaceRoot, "turn-"+sanitize(env.RequestID))
	if err := os.MkdirAll(turnDir, 0o755); err != nil {
		return err
	}
	defer os.RemoveAll(turnDir)
	if err := writeConfigToml(e.cfg, turnDir); err != nil {
		return err
	}

	spawnAt := time.Now()
	args := []string{"--ask-for-approval", "never", "--sandbox", "read-only", "-m", body.modelOr("")}
	if body.modelOr("") == "" {
		args = args[:len(args)-2]
	}
	t, err := startTUI(turnCtx, e.cfg, turnDir, args)
	if err != nil {
		return err
	}
	defer t.stop()

	if err := t.waitReady(turnCtx, e.cfg.ReadyTimeout); err != nil {
		if state := classifyScreen(t.Screen()); state != "" {
			return fmt.Errorf("codex stuck on onboarding screen %q: %w", state, err)
		}
		return err
	}
	if err := t.paste(prompt); err != nil {
		return err
	}
	// Wait for the paste chip/echo before submitting, else Enter races paste.
	if err := t.waitScreen(turnCtx, func(s string) bool {
		return contains(s, "[Pasted") || contains(s, tailOf(prompt, 12))
	}, e.cfg.PasteTimeout); err != nil {
		log.Printf("codex-tui %s: paste not echoed, submitting anyway: %v", e.cfg.VMID, err)
	}
	if err := t.enter(); err != nil {
		return err
	}

	rolloutPath, sessionID, err := findRolloutFile(turnCtx, e.cfg.CodexHome, turnDir, spawnAt, e.cfg.ReadyTimeout)
	if err != nil {
		return fmt.Errorf("no rollout file for turn dir: %w", err)
	}
	tr := newTranslate(sessionID, body.modelOr("unknown"))
	emit("response.created", map[string]any{"response": tr.finalResponse("in_progress")})

	var off int64
	lastActivity := time.Now()
	for {
		keep := true
		off, keep = tailRollout(rolloutPath, off, func(l rolloutLine) bool {
			lastActivity = time.Now()
			return tr.feed(l, emit)
		})
		if !keep {
			return nil
		}
		select {
		case <-turnCtx.Done():
			emit("response.failed", map[string]any{
				"response": tr.finalResponse("failed"),
				"error":    map[string]any{"type": "server_error", "message": "turn timeout or cancel"},
			})
			return turnCtx.Err()
		case <-t.done:
			if !tr.done {
				emit("response.failed", map[string]any{
					"response": tr.finalResponse("failed"),
					"error":    map[string]any{"type": "server_error", "message": "codex exited before turn completed"},
				})
			}
			return nil
		case <-time.After(200 * time.Millisecond):
			if time.Since(lastActivity) > e.cfg.IdleTimeout {
				emit("response.failed", map[string]any{
					"response": tr.finalResponse("failed"),
					"error":    map[string]any{"type": "server_error", "message": "turn idle timeout"},
				})
				return fmt.Errorf("idle timeout")
			}
		}
	}
}

var errOverloaded = fmt.Errorf("runtime queue is full")

func sanitize(s string) string {
	if s == "" {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	out := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_' {
			out = append(out, c)
		}
	}
	if len(out) == 0 {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return string(out)
}

func tailOf(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[len(s)-n:]
}
