package oauthcmd

import (
	"bytes"
	"encoding/json"
	kinoauth "github.com/dofastted/kin-gateway/worker/internal/oauth"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dofastted/kin-gateway/worker/internal/credential"
)

func TestExpiredCredentialRefreshesBeforeProfileAndPersists(t *testing.T) {
	var refreshCalls, profileCalls int
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/oauth/token":
			refreshCalls++
			writer.Header().Set("Content-Type", "application/json")
			_, _ = writer.Write([]byte(`{"access_token":"access-new","refresh_token":"refresh-new","expires_in":28800}`))
		case "/api/oauth/profile":
			profileCalls++
			if request.Header.Get("Authorization") != "Bearer access-new" {
				t.Fatalf("authorization = %q", request.Header.Get("Authorization"))
			}
			writer.Header().Set("Content-Type", "application/json")
			_, _ = writer.Write([]byte(`{"email":"user@example.com"}`))
		default:
			t.Fatalf("unexpected path %s", request.URL.Path)
		}
	}))
	defer server.Close()

	configPath, _ := testConfig(t, server.URL, server.URL+"/oauth/token", nil)
	credPath := filepath.Join(filepath.Dir(configPath), "credentials.json")
	saveCredential(t, credPath, credential.Credential{
		AccessToken:  "access-old",
		RefreshToken: "refresh-old",
		ExpiresAt:    time.Now().Add(-time.Minute).UnixMilli(),
	})

	var output bytes.Buffer
	if code := Run([]string{"profile", "--config", configPath}, nil, &output); code != 0 {
		t.Fatalf("exit code = %d, output = %s", code, output.String())
	}
	var envelope responseEnvelope
	decodeOutput(t, &output, &envelope)
	if !envelope.OK {
		t.Fatalf("envelope = %+v", envelope)
	}
	if refreshCalls != 1 || profileCalls != 1 {
		t.Fatalf("refresh calls=%d profile calls=%d", refreshCalls, profileCalls)
	}
	current, err := credential.NewStore(credPath).Status()
	if err != nil {
		t.Fatal(err)
	}
	if current.AccessToken != "access-new" || current.RefreshToken != "refresh-new" {
		t.Fatalf("credential = %+v", current)
	}
}

func TestRefreshOutputNeverContainsTokens(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"access_token":"secret-access","refresh_token":"secret-refresh","expires_in":3600}`))
	}))
	defer server.Close()

	configPath, _ := testConfig(t, server.URL, server.URL, nil)
	credPath := filepath.Join(filepath.Dir(configPath), "credentials.json")
	saveCredential(t, credPath, credential.Credential{
		AccessToken:  "old-access",
		RefreshToken: "old-refresh",
		ExpiresAt:    time.Now().Add(-time.Minute).UnixMilli(),
	})

	var output bytes.Buffer
	if code := Run([]string{"refresh", "--config", configPath}, nil, &output); code != 0 {
		t.Fatalf("exit code = %d, output = %s", code, output.String())
	}
	if strings.Contains(output.String(), "secret-access") || strings.Contains(output.String(), "secret-refresh") {
		t.Fatalf("refresh output leaked token: %s", output.String())
	}
	var envelope responseEnvelope
	decodeOutput(t, &output, &envelope)
	if !envelope.OK || envelope.Status != http.StatusOK {
		t.Fatalf("envelope = %+v", envelope)
	}
}

func TestCountTokensReadsStdin(t *testing.T) {
	var gotBody map[string]any
	var gotBeta string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/v1/messages/count_tokens" {
			t.Fatalf("path = %s", request.URL.Path)
		}
		if err := json.NewDecoder(request.Body).Decode(&gotBody); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		gotBeta = request.Header.Get("Anthropic-Beta")
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"input_tokens":12}`))
	}))
	defer server.Close()

	configPath, _ := testConfig(t, server.URL, server.URL, nil)
	credPath := filepath.Join(filepath.Dir(configPath), "credentials.json")
	saveCredential(t, credPath, credential.Credential{AccessToken: "access-live", ExpiresAt: time.Now().Add(time.Hour).UnixMilli()})

	input := `{"body":{"model":"claude-test","messages":[]},"headers":{"anthropic-beta":"beta-from-node"}}`
	var output bytes.Buffer
	if code := Run([]string{"count-tokens", "--config", configPath}, strings.NewReader(input), &output); code != 0 {
		t.Fatalf("exit code = %d, output = %s", code, output.String())
	}
	var envelope responseEnvelope
	decodeOutput(t, &output, &envelope)
	if !envelope.OK || gotBody["model"] != "claude-test" || gotBeta != "beta-from-node" {
		t.Fatalf("envelope=%+v body=%v beta=%q", envelope, gotBody, gotBeta)
	}
}

func TestUnknownOperationReturnsTwo(t *testing.T) {
	var output bytes.Buffer
	if code := Run([]string{"unknown", "--config", "/tmp/unused"}, nil, &output); code != 2 {
		t.Fatalf("exit code = %d, output = %s", code, output.String())
	}
	var envelope responseEnvelope
	decodeOutput(t, &output, &envelope)
	if envelope.OK || envelope.Body == nil {
		t.Fatalf("envelope = %+v", envelope)
	}
}

func TestResetStatusRequestsCedarEmber(t *testing.T) {
	var gotPath, gotBeta, gotApp, gotUA string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		gotPath = request.URL.RequestURI()
		gotBeta = request.Header.Get("anthropic-beta")
		gotApp = request.Header.Get("x-app")
		gotUA = request.Header.Get("User-Agent")
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"cedar_ember":{"eligible":false,"grants":[]}}`))
	}))
	defer server.Close()
	configPath, credPath := testConfig(t, server.URL, server.URL+"/oauth/token", map[string]string{"User-Agent": "claude-code/2.1.293"})
	saveCredential(t, credPath, credential.Credential{AccessToken: "access-live", ExpiresAt: time.Now().Add(time.Hour).UnixMilli()})
	var output bytes.Buffer
	if code := Run([]string{"reset-status", "--config", configPath}, strings.NewReader(""), &output); code != 0 {
		t.Fatalf("exit code = %d, output = %s", code, output.String())
	}
	if gotPath != "/api/oauth/usage?cedar_ember=1&skip_spend=1" || gotBeta != "oauth-2025-04-20" || gotApp != "cli" {
		t.Fatalf("path=%q beta=%q app=%q", gotPath, gotBeta, gotApp)
	}
	if gotUA != "claude-cli/2.1.293 (external, cli)" {
		t.Fatalf("user-agent=%q", gotUA)
	}
}

func TestResetRedeemPostsSelectedGrant(t *testing.T) {
	const org = "11111111-1111-4111-8111-111111111111"
	var gotPath, gotMethod string
	var gotBody map[string]string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		gotPath = request.URL.Path
		gotMethod = request.Method
		defer request.Body.Close()
		if err := json.NewDecoder(request.Body).Decode(&gotBody); err != nil {
			t.Errorf("decode body: %v", err)
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"result":"reset","cleared":["five_hour"]}`))
	}))
	defer server.Close()
	configPath, credPath := testConfig(t, server.URL, server.URL+"/oauth/token", nil)
	saveCredential(t, credPath, credential.Credential{AccessToken: "access-live", ExpiresAt: time.Now().Add(time.Hour).UnixMilli()})
	var output bytes.Buffer
	input := `{"organization_uuid":"` + org + `","grant_id":"grant_next","request_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}`
	if code := Run([]string{"reset-redeem", "--config", configPath}, strings.NewReader(input), &output); code != 0 {
		t.Fatalf("exit code = %d, output = %s", code, output.String())
	}
	if gotMethod != http.MethodPost || gotPath != "/api/organizations/"+org+"/reset_rate_limits" {
		t.Fatalf("method=%s path=%s", gotMethod, gotPath)
	}
	if gotBody["program"] != "cedar_ember" || gotBody["grant_id"] != "grant_next" {
		t.Fatalf("body=%v", gotBody)
	}
	if strings.Contains(output.String(), "access-live") {
		t.Fatal("token leaked")
	}
}

func TestResetRedeemRejectsBadGrantBeforeNetwork(t *testing.T) {
	called := false
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		called = true
		writer.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	configPath, credPath := testConfig(t, server.URL, server.URL+"/oauth/token", nil)
	saveCredential(t, credPath, credential.Credential{AccessToken: "access-live", ExpiresAt: time.Now().Add(time.Hour).UnixMilli()})
	var output bytes.Buffer
	input := `{"organization_uuid":"11111111-1111-4111-8111-111111111111","grant_id":"Grant Next","request_id":"abc"}`
	if code := Run([]string{"reset-redeem", "--config", configPath}, strings.NewReader(input), &output); code != 2 {
		t.Fatalf("exit code = %d, output = %s", code, output.String())
	}
	if called {
		t.Fatal("upstream called")
	}
	if strings.Contains(output.String(), "Grant Next") {
		t.Fatal("grant id echoed")
	}
}

func TestUpstream401ReturnsFailedEnvelope(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusUnauthorized)
		_, _ = writer.Write([]byte(`{"error":{"type":"authentication_error","message":"unauthorized"}}`))
	}))
	defer server.Close()

	configPath, _ := testConfig(t, server.URL, server.URL, nil)
	credPath := filepath.Join(filepath.Dir(configPath), "credentials.json")
	saveCredential(t, credPath, credential.Credential{AccessToken: "access-live", ExpiresAt: time.Now().Add(time.Hour).UnixMilli()})

	var output bytes.Buffer
	if code := Run([]string{"usage", "--config", configPath}, nil, &output); code != 0 {
		t.Fatalf("exit code = %d, output = %s", code, output.String())
	}
	var envelope responseEnvelope
	decodeOutput(t, &output, &envelope)
	if envelope.OK || envelope.Status != http.StatusUnauthorized {
		t.Fatalf("envelope = %+v", envelope)
	}
}

func TestMissingCredentialReturnsCredentialRequired(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		t.Fatal("upstream should not be called without credentials")
	}))
	defer server.Close()

	configPath, _ := testConfig(t, server.URL, server.URL, nil)
	var output bytes.Buffer
	if code := Run([]string{"usage", "--config", configPath}, nil, &output); code != 0 {
		t.Fatalf("exit code = %d, output = %s", code, output.String())
	}
	var envelope responseEnvelope
	decodeOutput(t, &output, &envelope)
	if envelope.OK || envelope.Status != 0 {
		t.Fatalf("envelope = %+v", envelope)
	}
	body, ok := envelope.Body.(map[string]any)
	if !ok {
		t.Fatalf("body = %#v", envelope.Body)
	}
	errorBody, ok := body["error"].(map[string]any)
	if !ok || errorBody["code"] != "credential_required" {
		t.Fatalf("error body = %#v", body["error"])
	}
}

func testConfig(t *testing.T, anthropicURL, tokenURL string, headers map[string]string) (string, string) {
	t.Helper()
	dir := t.TempDir()
	configPath := filepath.Join(dir, "worker.json")
	credentialPath := filepath.Join(dir, "credentials.json")
	raw := map[string]any{
		"vm_id":              "vm-test",
		"socket_path":        filepath.Join(dir, "worker.sock"),
		"credential_path":    credentialPath,
		"proxy_required":     true,
		"egress_mode":        "transparent",
		"test_endpoints":     true,
		"anthropic_base_url": anthropicURL,
		"oauth_token_url":    tokenURL,
	}
	for key, value := range headers {
		if strings.EqualFold(strings.TrimSpace(key), "user-agent") {
			raw["oauth_user_agent"] = value
		}
	}
	data, err := json.Marshal(raw)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(configPath, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return configPath, credentialPath
}

func saveCredential(t *testing.T, path string, value credential.Credential) {
	t.Helper()
	if _, err := credential.NewStore(path).Save(value, nil); err != nil {
		t.Fatal(err)
	}
}

func decodeOutput(t *testing.T, output *bytes.Buffer, envelope *responseEnvelope) {
	t.Helper()
	lines := bytes.Split(bytes.TrimSpace(output.Bytes()), []byte("\n"))
	if err := json.Unmarshal(lines[len(lines)-1], envelope); err != nil {
		t.Fatalf("decode output: %v; output=%s", err, output.String())
	}
}

func TestAttemptGuardFlagAndUnknownOutcome(t *testing.T) {
	op, configPath, force, ok := parseArgs([]string{"refresh", "--config", "/run/kin/worker.json", "--attempt-guard"})
	if !ok || op != "refresh" || configPath != "/run/kin/worker.json" || force {
		t.Fatalf("--attempt-guard must be accepted: %q %q %v %v", op, configPath, force, ok)
	}
	unknown := &kinoauth.RefreshError{Code: kinoauth.CodeOutcomeUnknown, Message: "lost"}
	if got := classifyError(unknown); got != kinoauth.CodeOutcomeUnknown {
		t.Fatalf("unknown outcome must reach the control plane as itself, got %q", got)
	}
	if got := classifyError(&kinoauth.RefreshError{Status: 400, Code: "invalid_grant"}); got != "refresh_failed" {
		t.Fatalf("an upstream rejection keeps its existing code, got %q", got)
	}
}

// The control plane uses this to learn, without touching any token or the network, whether a
// node's worker keeps the refresh-attempt journal. An older worker has no such operation (and
// rejects --attempt-guard) so it answers invalid_arguments instead.
func TestGuardProbeReportsJournalSupportWithoutConfigOrNetwork(t *testing.T) {
	var out bytes.Buffer
	code := Run([]string{"guard-probe", "--config", "/definitely/not/there.json"}, strings.NewReader(""), &out)
	if code != 0 {
		t.Fatalf("exit %d: %s", code, out.String())
	}
	var response struct {
		OK     bool           `json:"ok"`
		Status int            `json:"status"`
		Body   map[string]any `json:"body"`
	}
	if err := json.Unmarshal(out.Bytes(), &response); err != nil {
		t.Fatalf("decode %q: %v", out.String(), err)
	}
	if !response.OK || response.Status != 200 || response.Body["attempt_guard"] != true {
		t.Fatalf("unexpected probe answer: %s", out.String())
	}
}
