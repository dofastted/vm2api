package redact

import (
	"fmt"
	"sync"
	"sync/atomic"
)

const (
	maxScopeValues = 4096
	maxScopeBytes  = 8 << 20
)

// Scope owns the reversible mapping for one authenticated principal and session.
// Bind it with WithScope before masking or restoring. Values stay in memory.
type Scope struct {
	mu      sync.RWMutex
	values  map[string]string
	kinds   map[string]bool
	keyOf   []byte
	keyPath string
	shapes  map[string]string
	known   map[string][]knownValue
	// knownBits has a bit for the first four bytes of each known value.
	knownBits [1 << 14]uint64
	knownGen  atomic.Uint64
	sentKnown struct {
		sync.Mutex
		cur, old map[[32]byte][]span
	}
	principal string
	session   string
	deployKey []byte
	collision bool
	overflow  bool
	bytes     int
}

// FaultError is a mask failure that must block the send. The text result is discarded.
type FaultError struct{ Code string }

func (e *FaultError) Error() string {
	if e == nil {
		return ""
	}
	return e.Code
}

var (
	gate  sync.Mutex
	bound *Scope
)

func cur() *Scope {
	if bound == nil {
		panic("redact: no scope bound")
	}
	return bound
}

// WithScope runs fn while s is the only active mapping. Mask and restore are
// serialized so two scopes cannot observe each other's values.
func WithScope(s *Scope, fn func()) {
	if s == nil {
		panic("redact: nil scope")
	}
	gate.Lock()
	defer gate.Unlock()
	prev := bound
	bound = s
	defer func() { bound = prev }()
	fn()
}

// NewScope copies deployKey. principal and session are mixed into every tag.
func NewScope(deployKey []byte, principal, session string) (*Scope, error) {
	if len(deployKey) != 32 {
		return nil, fmt.Errorf("redact: deployment key is not 32 bytes")
	}
	if principal == "" {
		return nil, fmt.Errorf("redact: principal is empty")
	}
	k := append([]byte(nil), deployKey...)
	return &Scope{
		values:    map[string]string{},
		kinds:     map[string]bool{},
		shapes:    map[string]string{},
		known:     map[string][]knownValue{},
		keyOf:     k,
		deployKey: k,
		principal: principal,
		session:   session,
	}, nil
}

func (s *Scope) ResetFaults() {
	s.collision = false
	s.overflow = false
}

func (s *Scope) Fault() string {
	switch {
	case s.collision:
		return "collision"
	case s.overflow:
		return "overflow"
	default:
		return ""
	}
}

func (s *Scope) finish(out string, n int) (string, int, error) {
	if fault := s.Fault(); fault != "" {
		return "", 0, &FaultError{Code: fault}
	}
	return out, n, nil
}

// MaskText masks text. Shape and the local model are forced off.
func (s *Scope) MaskText(text string, o Options) (string, int, error) {
	var out string
	var n int
	var err error
	WithScope(s, func() {
		s.ResetFaults()
		o.Shape = false
		o.Model = nil
		out, n = Mask(text, o)
		out, n, err = s.finish(out, n)
	})
	return out, n, err
}

// MaskBody masks a JSON request body. Non-JSON falls back to text inside MaskJSON.
func (s *Scope) MaskBody(body []byte, o Options) ([]byte, int, error) {
	var out []byte
	var n int
	var err error
	WithScope(s, func() {
		s.ResetFaults()
		o.Shape = false
		o.Model = nil
		if SignedConflict(body, o) {
			err = &FaultError{Code: "signed_history"}
			return
		}
		out, n = MaskJSON(body, o)
		var text string
		text, n, err = s.finish(string(out), n)
		out = []byte(text)
	})
	return out, n, err
}

// RestoreText puts this scope's tags back. Tags from another scope stay literal.
func (s *Scope) RestoreText(text string, escaped bool) string {
	var out string
	WithScope(s, func() {
		out = Restore(text, escaped)
	})
	return out
}

// RestoreBody restores tags in a JSON document, or in raw text when codec is not json.
func (s *Scope) RestoreBody(body []byte, codec string) []byte {
	var out []byte
	WithScope(s, func() {
		if codec == "json" {
			out = RestoreJSON(body)
			return
		}
		out = []byte(Restore(string(body), false))
	})
	return out
}

// SignedConflict reports a mask hit inside a vendor-signed string. Those bytes
// must not be rewritten and must not be sent in the clear.
func SignedConflict(body []byte, o Options) bool {
	o.Shape = false
	o.Model = nil
	signed, args, defs := scan(body)
	if len(signed) == 0 {
		return false
	}
	hit := false
	_, _ = walk(body, func(path, key, s string) string {
		if hit || keepIn(path, key, s, args, defs) || !under(path, signed) {
			return s
		}
		if Preview(s, o) != s {
			hit = true
		}
		return s
	})
	return hit
}
