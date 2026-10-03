package main

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAccountIDFromToken(t *testing.T) {
	claims := map[string]any{
		"https://api.openai.com/auth": map[string]any{"chatgpt_account_id": "acct-test"},
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		t.Fatal(err)
	}
	token := "header." + base64.RawURLEncoding.EncodeToString(payload) + ".signature"
	if got := accountIDFromToken(token); got != "acct-test" {
		t.Fatalf("account id = %q", got)
	}
}

func TestHopByHopHeader(t *testing.T) {
	for _, name := range []string{"Authorization", "content-length", "Connection", "proxy-authorization"} {
		if !hopByHopHeader(name) {
			t.Errorf("%s should be filtered", name)
		}
	}
	if hopByHopHeader("x-codex-routing-hint") {
		t.Error("routing hint must be forwarded")
	}
}

func TestResponsesPreservesFastRoutingContract(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer access-token" {
			t.Errorf("authorization = %q", got)
		}
		if got := r.Header.Get("chatgpt-account-id"); got != "acct-test" {
			t.Errorf("chatgpt-account-id = %q", got)
		}
		if got := r.Header.Get("x-codex-routing-hint"); got != "model=gpt-6.1-sol;tier=priority" {
			t.Errorf("routing hint = %q", got)
		}
		if got := r.Header.Get("x-codex-turn-metadata"); got != `{"thread_id":"t"}` {
			t.Errorf("turn metadata = %q", got)
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatal(err)
		}
		var payload map[string]any
		if err := json.Unmarshal(body, &payload); err != nil {
			t.Fatal(err)
		}
		if got := payload["service_tier"]; got != "priority" {
			t.Errorf("service_tier = %#v", got)
		}
		w.Header().Set("content-type", "text/event-stream")
		_, _ = io.WriteString(w, "data: [DONE]\n\n")
	}))
	defer upstream.Close()

	s := &server{
		cfg:    Config{InternalToken: "internal-secret", CustomBaseURL: upstream.URL, MaxRequestBytes: 64 << 20},
		client: upstream.Client(),
		account: account{
			AccessToken: "access-token",
			ID:          "acct-test",
		},
	}
	envelope := Envelope{
		Body: map[string]any{
			"model":        "gpt-6.1-sol",
			"service_tier": "fast",
			"stream":       true,
		},
		Headers: map[string]string{
			"x-codex-turn-metadata": `{"thread_id":"t"}`,
			"Authorization":         "Bearer client-token",
		},
	}
	payload, err := json.Marshal(envelope)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/internal/v1/codex/responses", strings.NewReader(string(payload)))
	req.Header.Set("x-kin-internal-token", "internal-secret")
	res := httptest.NewRecorder()
	s.handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	if got := res.Body.String(); got != "data: [DONE]\n\n" {
		t.Fatalf("body = %q", got)
	}
}
