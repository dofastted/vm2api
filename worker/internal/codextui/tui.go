package codextui

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"
	"time"

	"github.com/creack/pty"
	"github.com/hinshun/vt10x"
)

// tui is one spawned `codex` interactive process behind a 200x50 PTY.
// The screen is rendered into vt10x so the helper can detect the composer,
// onboarding prompts and submit state without parsing raw escapes.
type tui struct {
	cmd  *exec.Cmd
	ptmx *os.File
	vt   vt10x.Terminal

	mu     sync.Mutex
	screen vt10x.Terminal
	done   chan struct{}
}

const (
	tuiCols = 200
	tuiRows = 50
)

// startTUI spawns `codex` with CODEX_HOME pointed at the slot home and cwd at
// the worker's workspace. When cfg.ProxyURL is set the process egress is
// pinned to that proxy (per-account fixed exit IP); otherwise egress rides
// the slot's transparent SOCKS5/CONNECT path. Either way the binary's real
// TLS fingerprint exits on the slot IP — never direct.
func startTUI(ctx context.Context, cfg *Config, dir string, extraArgs []string) (*tui, error) {
	args := append([]string{}, extraArgs...)
	cmd := exec.CommandContext(ctx, cfg.CodexBin, args...)
	cmd.Dir = dir
	env := []string{
		"HOME=" + cfg.CodexHome,
		"CODEX_HOME=" + cfg.CodexHome,
		"TERM=xterm-256color",
		"COLORTERM=truecolor",
		"LANG=C.UTF-8",
		"NO_COLOR=",
		"PATH=" + os.Getenv("PATH"),
		"USER=kincli",
	}
	// Per-account egress: reqwest honors standard proxy env vars; socks5h
	// keeps DNS on the proxy so the exit IP and its Geo stay the only
	// identity the upstream sees.
	if cfg.ProxyURL != "" {
		env = append(env,
			"HTTPS_PROXY="+cfg.ProxyURL,
			"https_proxy="+cfg.ProxyURL,
			"ALL_PROXY="+cfg.ProxyURL,
			"all_proxy="+cfg.ProxyURL,
		)
	}
	// TZ must come through so codex timestamps (and any tz-derived upstream
	// metadata) match the slot's GeoIP-consistent zone (checklist dimension 2).
	for _, k := range []string{"TMPDIR", "TZ", "LC_ALL", "LC_TIME"} {
		if v := os.Getenv(k); v != "" {
			env = append(env, k+"="+v)
		}
	}
	cmd.Env = env
	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: tuiCols, Rows: tuiRows})
	if err != nil {
		return nil, fmt.Errorf("pty start: %w", err)
	}
	t := &tui{cmd: cmd, ptmx: ptmx, done: make(chan struct{})}
	t.screen = vt10x.New()
	go t.readLoop()
	return t, nil
}

func (t *tui) readLoop() {
	defer close(t.done)
	buf := make([]byte, 32*1024)
	for {
		n, err := t.ptmx.Read(buf)
		if n > 0 {
			t.mu.Lock()
			_, _ = t.screen.Write(buf[:n])
			t.mu.Unlock()
		}
		if err != nil {
			return
		}
	}
}

// Screen returns the rendered terminal text.
func (t *tui) Screen() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.screen.String()
}

// waitScreen polls the rendered screen until pred holds or timeout.
func (t *tui) waitScreen(ctx context.Context, pred func(string) bool, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		if pred(t.Screen()) {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.done:
			return fmt.Errorf("codex process exited; last screen:\n%s", t.Screen())
		case <-time.After(150 * time.Millisecond):
			if time.Now().After(deadline) {
				return fmt.Errorf("timeout waiting for screen; last screen:\n%s", t.Screen())
			}
		}
	}
}

// waitReady blocks until the TUI composer is visible, or reports an
// onboarding/login/login-required screen as an error.
func (t *tui) waitReady(ctx context.Context, timeout time.Duration) error {
	return t.waitScreen(ctx, func(s string) bool {
		return composerVisible(s)
	}, timeout)
}

// composerVisible detects the codex TUI input prompt glyph. Onboarding and
// login screens are reported through classifyScreen, never as ready. The
// composer prompt is a single `›` (U+203A); the vt10x-rendered text may
// scatter it inside a line, so match the glyph itself rather than a
// line-anchored marker.
func composerVisible(s string) bool {
	return contains(s, "›") || contains(s, "for shortcuts")
}

// classifyScreen names blocking states that must not be pasted into.
func classifyScreen(s string) string {
	for _, needle := range []string{
		"Sign in", "sign in", "login", "ChatGPT account",
		"Improve Codex", "trust this directory", "Trust",
	} {
		if contains(s, needle) {
			return needle
		}
	}
	return ""
}

// paste writes text as a single bracketed paste so the TUI treats it as one
// atomic composer insert (newlines do not submit).
func (t *tui) paste(text string) error {
	_, err := io.WriteString(t.ptmx, "\x1b[200~"+text+"\x1b[201~")
	return err
}

func (t *tui) enter() error {
	_, err := io.WriteString(t.ptmx, "\r")
	return err
}

func (t *tui) esc() {
	_, _ = io.WriteString(t.ptmx, "\x1b")
}

// stop asks the TUI to exit, then kills it.
func (t *tui) stop() {
	t.esc()
	select {
	case <-t.done:
	case <-time.After(2 * time.Second):
	}
	if t.cmd.Process != nil {
		_ = t.cmd.Process.Kill()
	}
	_ = t.ptmx.Close()
	_ = t.cmd.Wait()
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && indexOf(s, sub) >= 0
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}

func splitLines(s string) []string {
	var out []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			out = append(out, s[start:i])
			start = i + 1
		}
	}
	out = append(out, s[start:])
	return out
}
