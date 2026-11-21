package codextui

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// rolloutLine is one JSONL record in CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl.
type rolloutLine struct {
	Timestamp string          `json:"timestamp"`
	Type      string          `json:"type"`
	Payload   json.RawMessage `json:"payload"`
}

type sessionMeta struct {
	CWD        string `json:"cwd"`
	ID         string `json:"id"`
	Originator string `json:"originator"`
	CLIVersion string `json:"cli_version"`
}

// findRolloutFile polls CODEX_HOME/sessions for a rollout file created after
// `since` whose session_meta.cwd matches turnDir. The unique per-turn cwd is
// the correlation key (parallel turns share one CODEX_HOME).
func findRolloutFile(ctx context.Context, home, turnDir string, since time.Time, timeout time.Duration) (string, string, error) {
	sessionsDir := filepath.Join(home, "sessions")
	deadline := time.Now().Add(timeout)
	seen := map[string]bool{}
	wantCwd := filepath.Clean(turnDir)
	if r, err := filepath.EvalSymlinks(turnDir); err == nil {
		wantCwd = r
	}
	for {
		var newest string
		var newestMod time.Time
		var newestID string
		_ = filepath.WalkDir(sessionsDir, func(p string, d os.DirEntry, err error) error {
			if err != nil || d.IsDir() || filepath.Ext(p) != ".jsonl" {
				return nil
			}
			if seen[p] {
				return nil
			}
			info, err := d.Info()
			if err != nil || info.ModTime().Before(since.Add(-2*time.Second)) {
				return nil
			}
			id, cwd, err := readSessionMeta(p)
			if err == nil {
				if r, rerr := filepath.EvalSymlinks(cwd); rerr == nil {
					cwd = r
				}
			}
			if err != nil || cwd != wantCwd {
				return nil
			}
			seen[p] = true
			if info.ModTime().After(newestMod) {
				newest, newestMod, newestID = p, info.ModTime(), id
			}
			return nil
		})
		if newest != "" {
			return newest, newestID, nil
		}
		select {
		case <-ctx.Done():
			return "", "", ctx.Err()
		case <-time.After(200 * time.Millisecond):
			if time.Now().After(deadline) {
				return "", "", os.ErrNotExist
			}
		}
	}
}

// readSessionMeta reads the first session_meta line of a rollout file.
func readSessionMeta(path string) (sessionID, cwd string, err error) {
	f, err := os.Open(path)
	if err != nil {
		return "", "", err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for sc.Scan() {
		var l rolloutLine
		if json.Unmarshal(sc.Bytes(), &l) != nil || l.Type != "session_meta" {
			continue
		}
		var meta struct {
			Payload sessionMeta `json:"payload"`
		}
		if json.Unmarshal(sc.Bytes(), &meta) != nil {
			return "", "", os.ErrInvalid
		}
		return meta.Payload.ID, filepath.Clean(meta.Payload.CWD), nil
	}
	return "", "", os.ErrNotExist
}

// tailRollout follows the rollout file from byte `off`, invoking onLine for
// every complete line. It returns the new offset and whether the process
// should keep watching (file keeps growing while the turn runs).
func tailRollout(path string, off int64, onLine func(rolloutLine) bool) (int64, bool) {
	f, err := os.Open(path)
	if err != nil {
		return off, true
	}
	defer f.Close()
	if _, err := f.Seek(off, 0); err != nil {
		return off, true
	}
	r := bufio.NewReader(f)
	for {
		line, err := r.ReadBytes('\n')
		if len(line) > 1 {
			var l rolloutLine
			if json.Unmarshal(line, &l) == nil && !onLine(l) {
				pos, _ := f.Seek(0, 1)
				_ = pos
				n, _ := f.Stat()
				_ = n
				return fileOffset(f, r), false
			}
		}
		if err != nil {
			break
		}
	}
	return fileOffset(f, r), true
}

func fileOffset(f *os.File, r *bufio.Reader) int64 {
	pos, _ := f.Seek(0, 1)
	return pos - int64(r.Buffered())
}

// tailOf returns the last ~60 runes of s, matching the suffix the TUI shows
// as the pasted-text echo for long prompts.
func tailOf(s string) string {
	r := []rune(s)
	if len(r) <= 60 {
		return s
	}
	return string(r[len(r)-60:])
}

// sanitize keeps alnum/_/- so a session or request id can be a dir name.
func sanitize(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' || r == '-' {
			b.WriteRune(r)
		}
	}
	if b.Len() == 0 {
		return "x"
	}
	return b.String()
}

// readLastUsage scans a rollout file and returns the payload of its last
// token_usage_record line (per-response `usage` + cumulative
// turn/thread_token_usage), or nil when the session has no usage yet.
func readLastUsage(path string) json.RawMessage {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	var last json.RawMessage
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for sc.Scan() {
		var l rolloutLine
		if json.Unmarshal(sc.Bytes(), &l) != nil || l.Type != "token_usage_record" {
			continue
		}
		last = append(last[:0], l.Payload...)
	}
	return last
}

// listRolloutFiles is a test/debug helper: all rollout files by mod time.
func listRolloutFiles(home string) []string {
	var paths []string
	_ = filepath.WalkDir(filepath.Join(home, "sessions"), func(p string, d os.DirEntry, err error) error {
		if err == nil && !d.IsDir() && filepath.Ext(p) == ".jsonl" {
			paths = append(paths, p)
		}
		return nil
	})
	sort.Strings(paths)
	return paths
}
