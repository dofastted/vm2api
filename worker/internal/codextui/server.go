package codextui

import (
	"crypto/subtle"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
)

// Server exposes the kernel socket contract on SocketPath:
//
//	GET  /internal/health
//	POST /internal/v1/codex/responses   (SSE)
//	POST /internal/v1/cancel           {request_id}
//
// Auth: constant-time compare of x-kin-internal-token / x-internal-token
// against internal.token, same as the Go worker mux.
type Server struct {
	cfg    *Config
	engine *Engine
}

func NewServer(cfg *Config) *Server {
	return &Server{cfg: cfg, engine: NewEngine(cfg)}
}

func (s *Server) authOK(r *http.Request) bool {
	want := s.cfg.InternalToken
	if want == "" {
		return true
	}
	got := r.Header.Get("x-kin-internal-token")
	if got == "" {
		got = r.Header.Get("x-internal-token")
	}
	return subtle.ConstantTimeCompare([]byte(got), []byte(want)) == 1
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /internal/health", func(w http.ResponseWriter, r *http.Request) {
		if !s.authOK(r) {
			http.Error(w, `{"type":"error","error":{"type":"authentication_error","message":"invalid internal token"}}`, http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok": true, "kernel": "codex-tui",
			"codex_home": s.cfg.CodexHome, "max_parallel": s.cfg.MaxParallel,
		})
	})
	mux.HandleFunc("POST /internal/v1/codex/responses", func(w http.ResponseWriter, r *http.Request) {
		if !s.authOK(r) {
			http.Error(w, `{"type":"error","error":{"type":"authentication_error","message":"invalid internal token"}}`, http.StatusUnauthorized)
			return
		}
		limit := s.cfg.MaxRequestByte
		if limit <= 0 {
			limit = 16 << 20
		}
		raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, limit))
		if err != nil {
			writeErr(w, http.StatusRequestEntityTooLarge, "invalid_request_error", "request too large")
			return
		}
		var env envelope
		if err := json.Unmarshal(raw, &env); err != nil || len(env.Body) == 0 {
			writeErr(w, http.StatusBadRequest, "invalid_request_error", "bad envelope")
			return
		}
		sse := newSSEWriter(w)
		err = s.engine.RunTurn(r.Context(), &env, sse.event)
		if err == errOverloaded {
			sse.event("response.failed", map[string]any{
				"error": map[string]any{"type": "overloaded_error", "message": "runtime queue is full"},
			})
			return
		}
		_ = err
	})
	mux.HandleFunc("POST /internal/v1/cancel", func(w http.ResponseWriter, r *http.Request) {
		if !s.authOK(r) {
			http.Error(w, `{"type":"error","error":{"type":"authentication_error","message":"invalid internal token"}}`, http.StatusUnauthorized)
			return
		}
		var req struct {
			RequestID string `json:"request_id"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		s.engine.Cancel(req.RequestID)
		w.WriteHeader(http.StatusNoContent)
	})
	return mux
}

func writeErr(w http.ResponseWriter, code int, typ, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"type": "error", "error": map[string]any{"type": typ, "message": msg},
	})
}

// ListenAndServe binds the unix socket (mode 0600, stale file removed).
func (s *Server) ListenAndServe() error {
	dir := filepath.Dir(s.cfg.SocketPath)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	_ = os.Remove(s.cfg.SocketPath)
	ln, err := net.Listen("unix", s.cfg.SocketPath)
	if err != nil {
		return err
	}
	if err := os.Chmod(s.cfg.SocketPath, 0o600); err != nil {
		return err
	}
	return http.Serve(ln, s.Handler())
}
