// Package server is the local helper Node calls. It listens on a Unix socket,
// checks a process capability, and never writes request bodies to a log.
package server

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	engine "github.com/dofastted/kin-gateway/redact/internal/engine"
)

const ProtocolVersion = 1

type Policy struct {
	Secrets      bool            `json:"secrets"`
	Personal     bool            `json:"personal"`
	Words        []string        `json:"words"`
	WordsAnyCase bool            `json:"wordsAnyCase"`
	Rules        []engine.Rule   `json:"rules"`
	Kinds        map[string]bool `json:"kinds"`
	Allow        []string        `json:"allow"`
}

type Server struct {
	cap      string
	key      []byte
	mu       sync.Mutex
	scopes   map[string]*engine.Scope
	lastUsed map[string]time.Time
	active   map[string]int
}

func New(capability string, deployKey []byte) *Server {
	return &Server{
		cap:      capability,
		key:      append([]byte(nil), deployKey...),
		scopes:   map[string]*engine.Scope{},
		lastUsed: map[string]time.Time{},
		active:   map[string]int{},
	}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", s.health)
	mux.HandleFunc("POST /v1/mask", s.mask)
	mux.HandleFunc("POST /v1/restore", s.restore)
	mux.HandleFunc("POST /v1/validate", s.validate)
	mux.HandleFunc("POST /v1/release", s.release)
	return mux
}

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	if !s.allow(w, r) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"protocol":      ProtocolVersion,
		"tag_format":    "R_v1",
		"scope":         true,
		"multi_channel": false,
		"model":         false,
		"shape":         false,
	})
}

func (s *Server) mask(w http.ResponseWriter, r *http.Request) {
	s.transform(w, r, true)
}

func (s *Server) validate(w http.ResponseWriter, r *http.Request) {
	if !s.allow(w, r) {
		return
	}
	if _, err := policyFrom(r); err != nil {
		http.Error(w, "invalid_redaction_config", http.StatusBadRequest)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) restore(w http.ResponseWriter, r *http.Request) {
	s.transform(w, r, false)
}

func (s *Server) transform(w http.ResponseWriter, r *http.Request, mask bool) {
	if !s.allow(w, r) {
		return
	}
	policy, err := policyFrom(r)
	if err != nil {
		http.Error(w, "invalid_redaction_config", http.StatusBadRequest)
		return
	}
	principal := r.Header.Get("X-Kin-Redact-Principal")
	session := r.Header.Get("X-Kin-Redact-Session")
	if principal == "" {
		http.Error(w, "invalid_redaction_config", http.StatusBadRequest)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 32<<20))
	if err != nil {
		http.Error(w, "redaction_unavailable", http.StatusServiceUnavailable)
		return
	}
	scope, err := s.hold(principal, session)
	if err != nil {
		http.Error(w, "redaction_capacity", http.StatusServiceUnavailable)
		return
	}
	defer s.drop(principal, session)
	opts := engine.Options{
		Secrets:      policy.Secrets,
		Personal:     policy.Personal,
		Words:        policy.Words,
		WordsAnyCase: policy.WordsAnyCase,
		Rules:        policy.Rules,
		Kinds:        policy.Kinds,
		Allow:        policy.Allow,
	}
	if mask {
		out, _, err := scope.MaskBody(body, opts)
		if err != nil {
			status, code := faultStatus(err)
			http.Error(w, code, status)
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		_, _ = w.Write(out)
		return
	}
	codec := r.Header.Get("X-Kin-Redact-Codec")
	w.Header().Set("Content-Type", "application/octet-stream")
	_, _ = w.Write(scope.RestoreBody(body, codec))
}

func faultStatus(err error) (int, string) {
	var fault *engine.FaultError
	if errors.As(err, &fault) {
		switch fault.Code {
		case "collision":
			return http.StatusServiceUnavailable, "redaction_collision"
		case "overflow":
			return http.StatusServiceUnavailable, "redaction_capacity"
		case "signed_history":
			return http.StatusConflict, "redaction_signed_history_requires_reset"
		}
	}
	return http.StatusServiceUnavailable, "redaction_unavailable"
}

func (s *Server) release(w http.ResponseWriter, r *http.Request) {
	if !s.allow(w, r) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) allow(w http.ResponseWriter, r *http.Request) bool {
	if subtleEq(r.Header.Get("X-Kin-Redact-Capability"), s.cap) {
		return true
	}
	http.Error(w, "unauthorized", http.StatusUnauthorized)
	return false
}

func subtleEq(got, want string) bool {
	if len(got) != len(want) || want == "" {
		return false
	}
	var diff byte
	for i := range []byte(want) {
		diff |= got[i] ^ want[i]
	}
	return diff == 0
}

func policyFrom(r *http.Request) (Policy, error) {
	payload, err := policyPayload(r.Header.Get("X-Kin-Redact-Policy"))
	if err != nil {
		return Policy{}, err
	}
	var p Policy
	if err := json.Unmarshal(payload, &p); err != nil {
		return Policy{}, err
	}
	if !p.Secrets && !p.Personal && len(p.Words) == 0 && len(p.Rules) == 0 {
		return Policy{}, errors.New("empty policy")
	}
	if err := limitTextList(p.Words); err != nil {
		return Policy{}, err
	}
	if err := limitTextList(p.Allow); err != nil {
		return Policy{}, err
	}
	kinds, err := cleanKinds(p.Kinds)
	if err != nil {
		return Policy{}, err
	}
	p.Kinds = kinds
	if len(p.Rules) > 0 {
		checked, err := engine.CheckRules(p.Rules)
		if err != nil {
			return Policy{}, err
		}
		p.Rules = checked
	}
	return p, nil
}

func limitTextList(items []string) error {
	if len(items) > 256 {
		return errors.New("too many words")
	}
	total := 0
	for _, item := range items {
		if len(item) > 1024 {
			return errors.New("word too long")
		}
		total += len(item)
	}
	if total > 64<<10 {
		return errors.New("words too large")
	}
	return nil
}

func cleanKinds(in map[string]bool) (map[string]bool, error) {
	if len(in) == 0 {
		return nil, nil
	}
	out := make(map[string]bool, len(in))
	for key, on := range in {
		switch key {
		case "ssn", "passport", "iban", "birthday", "mac", "serial", "home", "userhost", "ip", "bucket":
			out[key] = on
		default:
			return nil, errors.New("unknown kind")
		}
	}
	return out, nil
}

func policyPayload(raw string) ([]byte, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, errors.New("missing policy")
	}
	if strings.HasPrefix(raw, "{") {
		return []byte(raw), nil
	}
	decoded, err := base64.StdEncoding.DecodeString(raw)
	if err != nil {
		return nil, err
	}
	return decoded, nil
}

func scopeID(principal, session string) string {
	return principal + "\x00" + session
}

func (s *Server) hold(principal, session string) (*engine.Scope, error) {
	id := scopeID(principal, session)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.active[id] == 0 && len(s.active) >= 256 {
		return nil, errors.New("capacity")
	}
	sc := s.scopes[id]
	if sc == nil {
		if len(s.scopes) >= 4096 {
			s.evictIdleLocked()
		}
		if len(s.scopes) >= 4096 {
			return nil, errors.New("capacity")
		}
		var err error
		sc, err = engine.NewScope(s.key, principal, session)
		if err != nil {
			return nil, err
		}
		s.scopes[id] = sc
	}
	s.active[id]++
	s.lastUsed[id] = time.Now()
	return sc, nil
}

func (s *Server) drop(principal, session string) {
	id := scopeID(principal, session)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.active[id] > 0 {
		s.active[id]--
	}
	if s.active[id] == 0 {
		delete(s.active, id)
	}
}

func (s *Server) evictIdleLocked() {
	cutoff := time.Now().Add(-time.Hour)
	for id, at := range s.lastUsed {
		if s.active[id] == 0 && at.Before(cutoff) {
			delete(s.scopes, id)
			delete(s.lastUsed, id)
		}
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// LoadOrCreateKey reads a 32-byte key or creates one with mode 0600.
// Read and write errors are returned; a short or missing key is never ignored.
func LoadOrCreateKey(path string) ([]byte, error) {
	b, err := os.ReadFile(path)
	if err == nil {
		if len(b) != 32 {
			return nil, errors.New("redact key has the wrong length")
		}
		return b, nil
	}
	if !os.IsNotExist(err) {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return nil, err
	}
	if err := os.WriteFile(path, buf, 0o600); err != nil {
		return nil, err
	}
	return buf, nil
}

// ListenUnix removes a stale socket and listens with mode 0600.
func ListenUnix(path string) (net.Listener, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	ln, err := net.Listen("unix", path)
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(path, 0o600); err != nil {
		_ = ln.Close()
		return nil, err
	}
	return ln, nil
}
