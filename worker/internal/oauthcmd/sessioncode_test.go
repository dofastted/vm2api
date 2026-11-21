package oauthcmd

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/dofastted/kin-gateway/worker/internal/config"
)

type sessionCodeFixture struct {
	orgsStatus       int
	orgsBody         string
	authorizeStatus  int
	authorizeBody    string
	authorizeSeen    map[string]string
	authorizePayload map[string]string
	requests         int
}

func newSessionCodeServer(t *testing.T, fixture *sessionCodeFixture) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fixture.requests++
		switch {
		case r.Method == http.MethodGet && r.URL.Path == claudeOrgListPath:
			if r.Header.Get("Cookie") != "sessionKey=sk-ant-sid01-test" {
				t.Errorf("organizations cookie = %q", r.Header.Get("Cookie"))
			}
			w.WriteHeader(fixture.orgsStatus)
			_, _ = w.Write([]byte(fixture.orgsBody))
		case r.Method == http.MethodPost && strings.HasPrefix(r.URL.Path, "/v1/oauth/"):
			fixture.authorizeSeen = map[string]string{
				"cookie":  r.Header.Get("Cookie"),
				"origin":  r.Header.Get("Origin"),
				"referer": r.Header.Get("Referer"),
			}
			body := map[string]string{}
			_ = json.NewDecoder(r.Body).Decode(&body)
			fixture.authorizePayload = body
			w.WriteHeader(fixture.authorizeStatus)
			_, _ = w.Write([]byte(fixture.authorizeBody))
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(server.Close)
	return server
}

func runSessionCodeFixture(t *testing.T, fixture *sessionCodeFixture, input string) responseEnvelope {
	t.Helper()
	server := newSessionCodeServer(t, fixture)
	t.Setenv(claudeOAuthBaseEnv, server.URL)
	cfg := config.Config{TestEndpoints: true, EgressMode: "transparent"}
	var out bytes.Buffer
	code := runSessionCode(cfg, strings.NewReader(input), &out)
	if code != 0 {
		t.Fatalf("exit code = %d", code)
	}
	var envelope responseEnvelope
	if err := json.Unmarshal(out.Bytes(), &envelope); err != nil {
		t.Fatalf("decode envelope: %v (%s)", err, out.String())
	}
	return envelope
}

const sessionCodeInputJSON = `{
  "session_key": "sk-ant-sid01-test",
  "scope": "user:inference",
  "state": "state-1",
  "code_challenge": "challenge-1"
}`

func TestSessionCodePicksTeamOrgAndReadsCode(t *testing.T) {
	fixture := &sessionCodeFixture{
		orgsStatus:      http.StatusOK,
		orgsBody:        `[{"uuid":"org-personal"},{"uuid":"ORG-TEAM","raven_type":"team"}]`,
		authorizeStatus: http.StatusOK,
		authorizeBody:   `{"redirect_uri":"https://platform.claude.com/oauth/code/callback?code=code-1&state=state-1"}`,
	}
	envelope := runSessionCodeFixture(t, fixture, sessionCodeInputJSON)
	if !envelope.OK || envelope.Status != http.StatusOK {
		t.Fatalf("envelope = %+v", envelope)
	}
	body, _ := envelope.Body.(map[string]any)
	if body["code"] != "code-1" || body["state"] != "state-1" {
		t.Fatalf("body = %+v", body)
	}
	// The team org wins and is lower-cased into the path.
	if body["org_uuid"] != "org-team" {
		t.Fatalf("org_uuid = %v", body["org_uuid"])
	}
	if fixture.authorizeSeen["cookie"] != "sessionKey=sk-ant-sid01-test" {
		t.Fatalf("authorize cookie = %q", fixture.authorizeSeen["cookie"])
	}
	if fixture.authorizeSeen["origin"] != "https://claude.ai" || fixture.authorizeSeen["referer"] != "https://claude.ai/new" {
		t.Fatalf("authorize source headers = %+v", fixture.authorizeSeen)
	}
	if fixture.authorizePayload["scope"] != "user:inference" || fixture.authorizePayload["code_challenge"] != "challenge-1" {
		t.Fatalf("authorize payload = %+v", fixture.authorizePayload)
	}
	if fixture.authorizePayload["redirect_uri"] != claudeOAuthRedirect {
		t.Fatalf("redirect_uri = %q", fixture.authorizePayload["redirect_uri"])
	}
}

func TestSessionCodeNamesTheAttestationGate(t *testing.T) {
	fixture := &sessionCodeFixture{
		orgsStatus:      http.StatusOK,
		orgsBody:        `[{"uuid":"org-1"}]`,
		authorizeStatus: http.StatusBadRequest,
		authorizeBody:   `{"type":"error","error":{"type":"invalid_request_error","message":"This request couldn't be completed.","details":{"error_code":"missing_client_attestation"}}}`,
	}
	envelope := runSessionCodeFixture(t, fixture, sessionCodeInputJSON)
	if envelope.OK || envelope.Status != http.StatusBadRequest {
		t.Fatalf("envelope = %+v", envelope)
	}
	body, _ := envelope.Body.(map[string]any)
	errBody, _ := body["error"].(map[string]any)
	if errBody["code"] != "client_attestation_required" {
		t.Fatalf("error code = %v", errBody["code"])
	}
}

func TestSessionCodeKeepsStaleSessionDistinctFromAttestation(t *testing.T) {
	fixture := &sessionCodeFixture{
		orgsStatus:      http.StatusOK,
		orgsBody:        `[{"uuid":"org-1"}]`,
		authorizeStatus: http.StatusForbidden,
		authorizeBody:   `{"error":{"type":"permission_error","message":"Session is not fresh enough to authorize"}}`,
	}
	envelope := runSessionCodeFixture(t, fixture, sessionCodeInputJSON)
	body, _ := envelope.Body.(map[string]any)
	errBody, _ := body["error"].(map[string]any)
	if errBody["code"] != "session_stale_relogin" {
		t.Fatalf("error code = %v", errBody["code"])
	}
}

func TestSessionCodeRejectsIncompleteInputWithoutNetwork(t *testing.T) {
	fixture := &sessionCodeFixture{}
	server := newSessionCodeServer(t, fixture)
	t.Setenv(claudeOAuthBaseEnv, server.URL)
	cfg := config.Config{TestEndpoints: true, EgressMode: "transparent"}
	var out bytes.Buffer
	if code := runSessionCode(cfg, strings.NewReader(`{"session_key":"sk-ant-sid01-test"}`), &out); code != 2 {
		t.Fatalf("exit code = %d", code)
	}
	if fixture.requests != 0 {
		t.Fatalf("requests = %d", fixture.requests)
	}
}

// A config without an exit (e.g. a kernel config: no egress_mode, empty
// proxy_url) must say "proxy_required", not "upstream transport failed".
func TestSessionCodeNamesMissingExit(t *testing.T) {
	cfg := config.Config{TestEndpoints: true}
	var out bytes.Buffer
	if code := runSessionCode(cfg, strings.NewReader(sessionCodeInputJSON), &out); code != 0 {
		t.Fatalf("exit code = %d", code)
	}
	var envelope responseEnvelope
	if err := json.Unmarshal(out.Bytes(), &envelope); err != nil {
		t.Fatalf("decode envelope: %v (%s)", err, out.String())
	}
	body, _ := envelope.Body.(map[string]any)
	errBody, _ := body["error"].(map[string]any)
	if errBody["code"] != "proxy_required" {
		t.Fatalf("error code = %v (%s)", errBody["code"], out.String())
	}
}

// A caller can override the exit: `proxy_url: ""` means the local egress, which
// is how the panel falls back when the bound proxy is invalid. It must work even
// when the worker config itself has no exit.
func TestSessionCodeProxyOverrideUsesLocalEgress(t *testing.T) {
	fixture := &sessionCodeFixture{
		orgsStatus:      http.StatusOK,
		orgsBody:        `[{"uuid":"org-1"}]`,
		authorizeStatus: http.StatusOK,
		authorizeBody:   `{"redirect_uri":"https://platform.claude.com/oauth/code/callback?code=code-9&state=state-1"}`,
	}
	server := newSessionCodeServer(t, fixture)
	t.Setenv(claudeOAuthBaseEnv, server.URL)
	cfg := config.Config{TestEndpoints: true}
	input := `{"session_key":"sk-ant-sid01-test","scope":"user:inference","state":"state-1","code_challenge":"challenge-1","proxy_url":""}`
	var out bytes.Buffer
	if code := runSessionCode(cfg, strings.NewReader(input), &out); code != 0 {
		t.Fatalf("exit code = %d", code)
	}
	var envelope responseEnvelope
	if err := json.Unmarshal(out.Bytes(), &envelope); err != nil {
		t.Fatalf("decode envelope: %v (%s)", err, out.String())
	}
	if !envelope.OK {
		t.Fatalf("envelope = %s", out.String())
	}
	body, _ := envelope.Body.(map[string]any)
	if body["code"] != "code-9" {
		t.Fatalf("body = %+v", body)
	}
	if fixture.requests != 2 {
		t.Fatalf("requests = %d", fixture.requests)
	}
}
