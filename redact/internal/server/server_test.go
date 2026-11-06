package server

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func key32() []byte {
	k := make([]byte, 32)
	for i := range k {
		k[i] = byte(i + 3)
	}
	return k
}

func call(t *testing.T, h http.Handler, method, path, cap, principal string, policy Policy, body string) (int, string) {
	t.Helper()
	raw, _ := json.Marshal(policy)
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("X-Kin-Redact-Capability", cap)
	req.Header.Set("X-Kin-Redact-Principal", principal)
	req.Header.Set("X-Kin-Redact-Session", "sess")
	req.Header.Set("X-Kin-Redact-Policy", string(raw))
	res := httptest.NewRecorder()
	h.ServeHTTP(res, req)
	out, _ := io.ReadAll(res.Body)
	return res.Code, string(out)
}

func TestMaskRestoreIsolatesPrincipals(t *testing.T) {
	s := New("cap-1", key32())
	h := s.Handler()
	policy := Policy{Secrets: true}
	secret := "sk-" + "proj-" + "Aa1Bb2Cc3Dd4Ee5Ff6Gg"
	code, masked := call(t, h, "POST", "/v1/mask", "cap-1", "key-a", policy, "token "+secret)
	if code != 200 || strings.Contains(masked, secret) || !strings.Contains(masked, "{{R_API_KEY_") {
		t.Fatalf("mask %d %q", code, masked)
	}
	code, restored := call(t, h, "POST", "/v1/restore", "cap-1", "key-a", policy, masked)
	if code != 200 || !strings.Contains(restored, secret) {
		t.Fatalf("restore %d %q", code, restored)
	}
	code, other := call(t, h, "POST", "/v1/restore", "cap-1", "key-b", policy, masked)
	if code != 200 || strings.Contains(other, secret) {
		t.Fatalf("cross restore %d %q", code, other)
	}
	code, _ = call(t, h, "GET", "/health", "nope", "key-a", policy, "")
	if code != 401 {
		t.Fatalf("health auth %d", code)
	}
	req := httptest.NewRequest("GET", "/health", nil)
	req.Header.Set("X-Kin-Redact-Capability", "cap-1")
	res := httptest.NewRecorder()
	h.ServeHTTP(res, req)
	if res.Code != 200 || !bytes.Contains(res.Body.Bytes(), []byte(`"tag_format":"R_v1"`)) {
		t.Fatalf("health %d %s", res.Code, res.Body.Bytes())
	}
}

func TestWordsAnyCaseMasksOtherCapitals(t *testing.T) {
	s := New("cap-1", key32())
	h := s.Handler()
	folded := Policy{Words: []string{"Nightjar"}, WordsAnyCase: true}
	code, masked := call(t, h, "POST", "/v1/mask", "cap-1", "key-a", folded, "plan NIGHTJAR")
	if code != 200 || strings.Contains(masked, "NIGHTJAR") {
		t.Fatalf("folded %d %q", code, masked)
	}
	exact := Policy{Words: []string{"Nightjar"}}
	code, plain := call(t, h, "POST", "/v1/mask", "cap-1", "key-b", exact, "plan NIGHTJAR")
	if code != 200 || !strings.Contains(plain, "NIGHTJAR") {
		t.Fatalf("exact %d %q", code, plain)
	}
}
