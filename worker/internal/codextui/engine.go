package codextui

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

var errOverloaded = errors.New("no free tui worker")

// worker is one pooled codex TUI process. A worker stays alive across
// turns; a fresh logical session reuses the process via `/new`, a resumed
// session comes in through `codex resume <id>` on a dedicated worker.
type worker struct {
	dir       string
	resumeID  string // spawn with `codex resume` when set
	t         *tui
	sessionID string
	rollout   string
	off       int64
	model     string
	busy      bool
	dead      bool
}

func (w *worker) alive() bool {
	if w.dead || w.t == nil {
		return false
	}
	select {
	case <-w.t.done:
		return false
	default:
		return true
	}
}

// Engine owns a pool of codex TUI workers and answers one /responses
// envelope at a time per worker.
type Engine struct {
	cfg      *Config
	mu       sync.Mutex
	workers  []*worker
	sessions map[string]*worker
	cancels  map[string]context.CancelFunc
	homeErr  error
	homeOnce sync.Once
	nextProc int64
}

func NewEngine(cfg *Config) *Engine {
	return &Engine{
		cfg:      cfg,
		sessions: make(map[string]*worker),
		cancels:  make(map[string]context.CancelFunc),
	}
}

// RunTurn submits one envelope, waits for the rollout to reach a terminal
// state, and emits `response.*` SSE events. The worker is returned to the
// pool (or dropped when it died) before RunTurn returns.
func (e *Engine) RunTurn(ctx context.Context, env *envelope, emit func(string, any)) error {
	var body reqBody
	if len(env.Body) > 0 {
		if err := json.Unmarshal(env.Body, &body); err != nil {
			return fmt.Errorf("parse request body: %w", err)
		}
	}
	model := body.modelOr("")
	w, spawn, err := e.acquire(env, model)
	if err != nil {
		return err
	}
	tr := newTranslate("", model)

	ctx, cancel := context.WithCancel(ctx)
	e.mu.Lock()
	e.cancels[env.RequestID] = cancel
	e.mu.Unlock()
	defer func() {
		e.mu.Lock()
		delete(e.cancels, env.RequestID)
		e.mu.Unlock()
		cancel()
		e.release(w)
	}()

	if err := e.boot(); err != nil {
		w.dead = true
		return err
	}
	if spawn {
		if err := e.spawnTUI(ctx, w); err != nil {
			w.dead = true
			return err
		}
	}
	if w.t == nil || !w.alive() {
		// A dead-but-resident worker gets one respawn in place.
		e.mu.Lock()
		w.dead = true
		if w.t != nil {
			w.t.stop()
		}
		e.mu.Unlock()
		if err := e.spawnTUI(ctx, w); err != nil {
			return err
		}
	}
	w.dead = false

	since := time.Now()
	prompt, err := composePrompt(&body)
	if err != nil {
		return err
	}
	if strings.HasPrefix(prompt, "/") || strings.HasPrefix(prompt, "!") || strings.HasPrefix(prompt, "#") {
		prompt = "\n" + prompt
	}

	// New logical session on a reused worker: `/new` resets the thread so a
	// second vm2api session never inherits another one's context.
	if w.sessionID != "" && env.Session.SessionID != w.sessionID {
		if err := w.t.paste("/new"); err != nil {
			w.dead = true
			return err
		}
		if err := w.t.enter(); err != nil {
			w.dead = true
			return err
		}
		w.sessionID, w.rollout, w.off = "", "", 0
		if err := w.t.waitReady(ctx, e.cfg.ReadyTimeout); err != nil {
			w.dead = true
			return err
		}
		since = time.Now()
	}

	if err := w.t.waitReady(ctx, e.cfg.ReadyTimeout); err != nil {
		w.dead = true
		return err
	}
	if cls := classifyScreen(w.t.Screen()); cls != "" {
		w.dead = true
		return fmt.Errorf("codex tui blocked: %s", cls)
	}
	if err := w.t.paste(prompt); err != nil {
		w.dead = true
		return err
	}
	if err := w.t.waitScreen(ctx, func(s string) bool {
		return contains(s, "[Pasted") || contains(s, tailOf(prompt))
	}, e.cfg.PasteTimeout); err != nil {
		w.dead = true
		return err
	}
	if err := w.t.enter(); err != nil {
		w.dead = true
		return err
	}

	if w.rollout == "" {
		rolloutPath, sid, err := findRolloutFile(ctx, e.cfg.CodexHome, w.dir, since, e.cfg.ReadyTimeout)
		if err != nil {
			w.dead = true
			return err
		}
		w.rollout, w.off = rolloutPath, 0
		w.sessionID = sid
		tr.responseID = sid
	}
	emit("response.created", map[string]any{"response": tr.finalResponse("in_progress")})

	turnCtx, turnCancel := context.WithTimeout(ctx, e.cfg.TurnTimeout)
	defer turnCancel()
	for !tr.done {
		// tailRollout drains to EOF; poll again until the terminal line.
		w.off, _ = tailRollout(w.rollout, w.off, func(l rolloutLine) bool {
			return tr.feed(l, emit) // feed emits completed/failed itself
		})
		if tr.done {
			return nil
		}
		select {
		case <-turnCtx.Done():
			emit("response.failed", map[string]any{"response": tr.finalResponse("failed")})
			w.t.esc() // interrupt the turn; the worker stays in the pool
			return nil
		case <-w.t.done:
			w.dead = true
			emit("response.failed", map[string]any{"response": tr.finalResponse("failed")})
			return nil
		case <-time.After(200 * time.Millisecond):
		}
	}
	return nil
}

// acquire reserves a pool slot for the request. The returned bool reports
// whether the caller must spawn the TUI process (workers are created
// lazily so idle slots never pay PTY boot).
func (e *Engine) acquire(env *envelope, model string) (*worker, bool, error) {
	e.mu.Lock()
	defer e.mu.Unlock()

	sid := env.Session.SessionID
	if sid == "" {
		sid = env.Session.PreviousResponseID // response.id == session id
	}
	if sid != "" {
		if w := e.sessions[sid]; w != nil && w.alive() {
			if w.busy {
				return nil, false, fmt.Errorf("session %s busy", sid)
			}
			w.busy = true
			return w, false, nil
		}
		delete(e.sessions, sid)
		if w := e.reserveLocked("resume-" + sanitize(sid)); w != nil {
			w.resumeID = sid
			w.model = model
			e.sessions[sid] = w
			return w, true, nil
		}
		if ev := e.evictableLocked(""); ev != nil {
			e.evictLocked(ev)
			if w := e.reserveLocked("resume-" + sanitize(sid)); w != nil {
				w.resumeID = sid
				w.model = model
				e.sessions[sid] = w
				return w, true, nil
			}
		}
		return nil, false, errOverloaded
	}

	// New logical session: prefer an idle worker with a matching model.
	for _, w := range e.workers {
		if w.busy || !w.alive() {
			continue
		}
		if model != "" && w.model != "" && w.model != model {
			continue
		}
		w.busy = true
		return w, false, nil
	}
	if w := e.reserveLocked(fmt.Sprintf("proc-%d", e.nextProc)); w != nil {
		e.nextProc++
		w.model = model
		return w, true, nil
	}
	if ev := e.evictableLocked(model); ev != nil {
		e.evictLocked(ev)
		if w := e.reserveLocked(fmt.Sprintf("proc-%d", e.nextProc)); w != nil {
			e.nextProc++
			w.model = model
			return w, true, nil
		}
	}
	return nil, false, errOverloaded
}

func (e *Engine) reserveLocked(name string) *worker {
	if len(e.workers) >= e.cfg.MaxParallel {
		return nil
	}
	w := &worker{
		dir:  filepath.Join(e.cfg.WorkspaceRoot, name),
		busy: true,
	}
	e.workers = append(e.workers, w)
	return w
}

// evictableLocked picks an idle worker to drop so a new one can spawn.
// Workers whose model mismatches the request are evicted first.
func (e *Engine) evictableLocked(model string) *worker {
	for _, w := range e.workers {
		if w.busy || !w.alive() {
			continue
		}
		if model != "" && w.model != "" && w.model != model {
			return w
		}
	}
	for _, w := range e.workers {
		if w.busy || !w.alive() {
			continue
		}
		return w
	}
	return nil
}

func (e *Engine) evictLocked(w *worker) {
	w.dead = true
	if w.t != nil {
		w.t.stop()
	}
	e.removeLocked(w)
}

func (e *Engine) removeLocked(w *worker) {
	for i, x := range e.workers {
		if x == w {
			e.workers = append(e.workers[:i], e.workers[i+1:]...)
			break
		}
	}
	for sid, x := range e.sessions {
		if x == w {
			delete(e.sessions, sid)
		}
	}
}

// release returns a worker to the pool and registers its session affinity.
func (e *Engine) release(w *worker) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if w.dead || !w.alive() {
		w.dead = true
		if w.t != nil {
			w.t.stop()
		}
		e.removeLocked(w)
		return
	}
	w.busy = false
	if w.sessionID != "" {
		e.sessions[w.sessionID] = w
	}
}

func (e *Engine) boot() error {
	e.homeOnce.Do(func() {
		e.homeErr = ensureHome(e.cfg)
	})
	return e.homeErr
}



func (e *Engine) spawnTUI(ctx context.Context, w *worker) error {
	if err := os.MkdirAll(w.dir, 0o755); err != nil {
		return err
	}
	args := []string{"--no-daemon", "--ask-for-approval", "never", "--sandbox", "read-only"}
	if w.model != "" {
		args = append(args, "-m", w.model)
	}
	if w.resumeID != "" {
		args = append([]string{"resume", w.resumeID}, args...)
	}
	start := time.Now()
	t, err := startTUI(ctx, e.cfg, w.dir, args)
	if err != nil && w.resumeID != "" {
		// Older CLIs may not accept --no-daemon on `resume`; retry without it.
		args = []string{"resume", w.resumeID, "--ask-for-approval", "never", "--sandbox", "read-only"}
		if w.model != "" {
			args = append(args, "-m", w.model)
		}
		t, err = startTUI(ctx, e.cfg, w.dir, args)
	}
	if err != nil {
		return err
	}
	log.Printf("tui spawn ok dir=%s in %s", w.dir, time.Since(start))
	w.t = t
	return nil
}

// Usage reports the slot's codex-side state for
// /internal/v1/codex/usage: the account id from auth.json and, for every
// pooled worker that has a session, the last token_usage_record snapshot
// from its rollout (per-response usage + cumulative thread totals).
// Account rate limits only live in the upstream session's headers — codex
// does not persist them to CODEX_HOME — so they are left out here (M3).
func (e *Engine) Usage() map[string]any {
	type snap struct{ dir, rollout, sessionID, model string; busy bool }
	e.mu.Lock()
	snaps := make([]snap, 0, len(e.workers))
	for _, w := range e.workers {
		snaps = append(snaps, snap{w.dir, w.rollout, w.sessionID, w.model, w.busy})
	}
	n := len(e.workers)
	e.mu.Unlock()

	accountID := ""
	if creds, err := loadCredentials(e.cfg.CredentialPath); err == nil {
		accountID = creds.AccountID
	}
	sessions := []any{}
	for _, w := range snaps {
		if w.rollout == "" || w.sessionID == "" {
			continue
		}
		entry := map[string]any{
			"session_id": w.sessionID,
			"dir":        w.dir,
			"busy":       w.busy,
			"model":      w.model,
		}
		if u := readLastUsage(w.rollout); u != nil {
			entry["usage_record"] = u
		}
		sessions = append(sessions, entry)
	}
	return map[string]any{
		"kernel":     "codex-tui",
		"account_id": accountID,
		"workers":    n,
		"sessions":   sessions,
	}
}

// Cancel interrupts the turn bound to requestID, if any.
func (e *Engine) Cancel(requestID string) {
	e.mu.Lock()
	cancel, ok := e.cancels[requestID]
	e.mu.Unlock()
	if ok {
		cancel()
	}
}

// Shutdown stops every pooled worker.
func (e *Engine) Shutdown() {
	e.mu.Lock()
	defer e.mu.Unlock()
	for _, w := range e.workers {
		w.dead = true
		if w.t != nil {
			w.t.stop()
		}
	}
	e.workers = nil
	e.sessions = make(map[string]*worker)
}
