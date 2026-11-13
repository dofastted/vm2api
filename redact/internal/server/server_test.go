package server

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
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

func TestTransformBodyLimit(t *testing.T) {
	for _, path := range []string{"/v1/mask", "/v1/restore"} {
		for _, knownLength := range []bool{true, false} {
			for _, size := range []int{63, 64, 65} {
				t.Run(path+"/"+strconv.FormatBool(knownLength)+"/"+strconv.Itoa(size), func(t *testing.T) {
					s := New("cap-1", key32())
					body := `{"data":"` + strings.Repeat("x", size-11) + `"}`
					req := httptest.NewRequest("POST", path, strings.NewReader(body))
					if !knownLength {
						req.ContentLength = -1
					}
					req.Header.Set("X-Kin-Redact-Capability", "cap-1")
					req.Header.Set("X-Kin-Redact-Principal", "key-a")
					req.Header.Set("X-Kin-Redact-Policy", `{"secrets":true}`)
					req.Header.Set("X-Kin-Redact-Max-Body-Bytes", "64")
					res := httptest.NewRecorder()
					s.Handler().ServeHTTP(res, req)
					if size <= 64 {
						if res.Code != http.StatusOK || res.Body.String() != body {
							t.Fatalf("body not preserved: status=%d bytes=%d", res.Code, res.Body.Len())
						}
						return
					}
					var fault struct {
						Error struct {
							Code    string `json:"code"`
							Details struct {
								Retryable *bool `json:"retryable"`
							} `json:"details"`
						} `json:"error"`
					}
					if res.Code != http.StatusRequestEntityTooLarge || json.Unmarshal(res.Body.Bytes(), &fault) != nil ||
						fault.Error.Code != "redaction_body_too_large" || fault.Error.Details.Retryable == nil || *fault.Error.Details.Retryable {
						t.Fatalf("expected non-retryable 413, got %d %s", res.Code, res.Body.String())
					}
					if len(s.scopes) != 0 {
						t.Fatal("oversized body must be rejected before creating a scope")
					}
				})
			}
		}
	}
}

func TestTransformDefaultBodyLimit(t *testing.T) {
	code, body := call(t, New("cap-1", key32()).Handler(), "POST", "/v1/mask", "cap-1", "key-a",
		Policy{Secrets: true}, strings.Repeat("x", int(DefaultMaxBodyBytes)+1))
	if code != http.StatusRequestEntityTooLarge || !strings.Contains(body, `"redaction_body_too_large"`) {
		t.Fatalf("default limit must reject instead of truncating: %d", code)
	}
}

func TestTransformRejectsInvalidBodyLimit(t *testing.T) {
	for _, raw := range []string{"0", "-1", "NaN", "1.5", "9223372036854775808"} {
		req := httptest.NewRequest("POST", "/v1/mask", strings.NewReader("{}"))
		req.Header.Set("X-Kin-Redact-Capability", "cap-1")
		req.Header.Set("X-Kin-Redact-Principal", "key-a")
		req.Header.Set("X-Kin-Redact-Policy", `{"secrets":true}`)
		req.Header.Set("X-Kin-Redact-Max-Body-Bytes", raw)
		res := httptest.NewRecorder()
		New("cap-1", key32()).Handler().ServeHTTP(res, req)
		if res.Code != http.StatusBadRequest {
			t.Fatalf("limit %q: expected 400, got %d", raw, res.Code)
		}
	}
}
