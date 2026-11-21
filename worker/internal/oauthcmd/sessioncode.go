package oauthcmd

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/dofastted/kin-gateway/worker/internal/config"
	"github.com/dofastted/kin-gateway/worker/internal/upstream"
)

// The cookie import's browser stage. It has to go through the Chrome TLS
// transport (`upstream.NewOAuthHTTPClient`): claude.ai answers a Node/undici
// request that only *claims* to be Chrome with
// `400 invalid_request_error: missing_client_attestation`, while the same
// request over the Chrome TLS transport is accepted.
const (
	sessionCodeTimeout  = 60 * time.Second
	sessionCodeMaxBody  = 4 << 20
	claudeOAuthClientID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
	claudeOAuthRedirect = "https://platform.claude.com/oauth/code/callback"
	claudeOAuthBaseURL  = "https://claude.ai"
	claudeOAuthBaseEnv  = "KIN_CLAUDE_OAUTH_BASE_URL"
	claudeOrgListPath   = "/api/organizations"
	claudeAuthorizePath = "/v1/oauth/%s/authorize"
)

type sessionCodeInput struct {
	SessionKey    string `json:"session_key"`
	OrgUUID       string `json:"org_uuid"`
	Scope         string `json:"scope"`
	State         string `json:"state"`
	CodeChallenge string `json:"code_challenge"`
	// Optional exit override. Present-but-empty means the local egress (direct
	// dial), which is how the caller falls back when the bound proxy is invalid.
	ProxyURL *string `json:"proxy_url"`
}

type claudeOrganization struct {
	UUID      string  `json:"uuid"`
	RavenType *string `json:"raven_type"`
}

// oauthStageError keeps the upstream status and body so the JS caller can map
// the failure the same way it maps its own hops.
type oauthStageError struct {
	Code    string
	Status  int
	Message string
}

func (e *oauthStageError) Error() string { return e.Message }

func runSessionCode(cfg config.Config, stdin io.Reader, stdout io.Writer) int {
	input, err := decodeSessionCode(stdin)
	if err != nil {
		return writeAndReturn(stdout, errorEnvelope(0, "invalid_arguments", "invalid session-code input"), 2)
	}
	client, err := sessionCodeClient(cfg, input.ProxyURL)
	if err != nil {
		code := classifyError(err)
		return writeAndReturn(stdout, errorEnvelope(0, code, errorMessage(code)), 0)
	}
	base := claudeOAuthBase(cfg)
	ctx, cancel := context.WithTimeout(context.Background(), sessionCodeTimeout)
	defer cancel()

	org, err := resolveOrganization(ctx, client, base, input)
	if err != nil {
		return writeSessionCodeError(stdout, err)
	}
	code, state, redirect, err := authorizeCode(ctx, client, base, org, input)
	if err != nil {
		return writeSessionCodeError(stdout, err)
	}
	return writeAndReturn(stdout, responseEnvelope{
		OK:     true,
		Status: http.StatusOK,
		Body: map[string]any{
			"org_uuid":     org,
			"code":         code,
			"state":        state,
			"redirect_uri": redirect,
		},
		Headers: map[string]string{},
	}, 0)
}

func writeSessionCodeError(stdout io.Writer, err error) int {
	var stage *oauthStageError
	if errors.As(err, &stage) {
		return writeAndReturn(stdout, errorEnvelope(stage.Status, stage.Code, stage.Message), 0)
	}
	code := classifyError(err)
	return writeAndReturn(stdout, errorEnvelope(0, code, errorMessage(code)), 0)
}

func decodeSessionCode(reader io.Reader) (sessionCodeInput, error) {
	var input sessionCodeInput
	if reader == nil {
		return input, errors.New("session-code input is required")
	}
	raw, err := io.ReadAll(io.LimitReader(reader, sessionCodeMaxBody+1))
	if err != nil {
		return input, err
	}
	if len(raw) == 0 || len(raw) > sessionCodeMaxBody {
		return input, errors.New("session-code input is invalid")
	}
	if err := json.Unmarshal(raw, &input); err != nil {
		return input, err
	}
	input.SessionKey = strings.TrimSpace(input.SessionKey)
	input.OrgUUID = strings.ToLower(strings.TrimSpace(input.OrgUUID))
	input.Scope = strings.TrimSpace(input.Scope)
	input.State = strings.TrimSpace(input.State)
	input.CodeChallenge = strings.TrimSpace(input.CodeChallenge)
	if input.ProxyURL != nil {
		trimmed := strings.TrimSpace(*input.ProxyURL)
		input.ProxyURL = &trimmed
	}
	if input.SessionKey == "" || input.Scope == "" || input.State == "" || input.CodeChallenge == "" {
		return input, errors.New("session-code input is incomplete")
	}
	if input.OrgUUID != "" && !resetOrgPattern.MatchString(input.OrgUUID) {
		return input, errors.New("session-code organization is invalid")
	}
	return input, nil
}

func sessionCodeClient(cfg config.Config, override *string) (*http.Client, error) {
	if override != nil {
		if url := strings.TrimSpace(*override); url != "" {
			return upstream.NewOAuthHTTPClient(url, false, sessionCodeTimeout)
		}
		return upstream.NewTransparentOAuthHTTPClient(sessionCodeTimeout)
	}
	if cfg.EgressMode == "transparent" {
		return upstream.NewTransparentOAuthHTTPClient(sessionCodeTimeout)
	}
	if strings.TrimSpace(cfg.ProxyURL) == "" {
		// NewOAuthHTTPClient would hand back a client that refuses every dial,
		// which reads as "upstream transport failed"; name the real reason.
		return nil, errors.New("slot proxy is required")
	}
	return upstream.NewOAuthHTTPClient(cfg.ProxyURL, cfg.ProxyRequired, sessionCodeTimeout)
}

// claudeOAuthBase is fixed; TestEndpoints unlocks the override for Go tests.
func claudeOAuthBase(cfg config.Config) string {
	if !cfg.TestEndpoints {
		return claudeOAuthBaseURL
	}
	if value := strings.TrimSpace(os.Getenv(claudeOAuthBaseEnv)); value != "" {
		return strings.TrimSuffix(value, "/")
	}
	return claudeOAuthBaseURL
}

func resolveOrganization(ctx context.Context, client *http.Client, base string, input sessionCodeInput) (string, error) {
	if input.OrgUUID != "" {
		return input.OrgUUID, nil
	}
	status, raw, err := doOAuthRequest(ctx, client, http.MethodGet, base+claudeOrgListPath, input.SessionKey, nil)
	if err != nil {
		return "", err
	}
	if status < 200 || status >= 300 {
		return "", stageError("get_organizations", status, raw)
	}
	var orgs []claudeOrganization
	if err := json.Unmarshal(raw, &orgs); err != nil {
		return "", &oauthStageError{Code: "get_organizations_failed", Status: status, Message: "get_organizations failed: non-json reply"}
	}
	if len(orgs) == 0 {
		return "", &oauthStageError{Code: "organization_missing", Status: status, Message: "no organizations found for sessionKey"}
	}
	picked := orgs[0]
	for _, org := range orgs {
		if org.RavenType != nil && strings.EqualFold(*org.RavenType, "team") {
			picked = org
			break
		}
	}
	uuid := strings.ToLower(strings.TrimSpace(picked.UUID))
	if uuid == "" {
		return "", &oauthStageError{Code: "organization_missing", Status: status, Message: "organization uuid missing in organizations response"}
	}
	return uuid, nil
}

func authorizeCode(ctx context.Context, client *http.Client, base, org string, input sessionCodeInput) (code, state, redirect string, err error) {
	body, err := json.Marshal(map[string]string{
		"response_type":         "code",
		"client_id":             claudeOAuthClientID,
		"organization_uuid":     org,
		"redirect_uri":          claudeOAuthRedirect,
		"scope":                 input.Scope,
		"state":                 input.State,
		"code_challenge":        input.CodeChallenge,
		"code_challenge_method": "S256",
	})
	if err != nil {
		return "", "", "", err
	}
	target := base + fmt.Sprintf(claudeAuthorizePath, url.PathEscape(org))
	status, raw, err := doOAuthRequest(ctx, client, http.MethodPost, target, input.SessionKey, body)
	if err != nil {
		return "", "", "", err
	}
	if status < 200 || status >= 300 {
		return "", "", "", stageError("authorize", status, raw)
	}
	var reply struct {
		RedirectURI string `json:"redirect_uri"`
	}
	if err := json.Unmarshal(raw, &reply); err != nil || strings.TrimSpace(reply.RedirectURI) == "" {
		return "", "", "", &oauthStageError{Code: "authorize_no_code", Status: status, Message: "authorize_no_code: missing redirect_uri"}
	}
	parsed, err := url.Parse(reply.RedirectURI)
	if err != nil {
		return "", "", "", &oauthStageError{Code: "authorize_no_code", Status: status, Message: "authorize_no_code: invalid redirect_uri"}
	}
	query := parsed.Query()
	code = query.Get("code")
	state = query.Get("state")
	if code == "" {
		return "", "", "", &oauthStageError{Code: "authorize_no_code", Status: status, Message: "authorize_no_code: redirect_uri missing code"}
	}
	return code, state, reply.RedirectURI, nil
}

func doOAuthRequest(ctx context.Context, client *http.Client, method, target, sessionKey string, body []byte) (int, []byte, error) {
	var reader io.Reader
	if body != nil {
		reader = strings.NewReader(string(body))
	}
	req, err := http.NewRequestWithContext(ctx, method, target, reader)
	if err != nil {
		return 0, nil, err
	}
	// Browser headers. The Chrome UA/H2 fingerprint comes from the
	// transport; a hand-written UA is what got the attestation gate.
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Accept-Language", "en-US,en;q=0.9")
	req.Header.Set("Cache-Control", "no-cache")
	req.Header.Set("Cookie", "sessionKey="+sessionKey)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if method == http.MethodPost {
		req.Header.Set("Origin", "https://claude.ai")
		req.Header.Set("Referer", "https://claude.ai/new")
	}
	res, err := client.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, sessionCodeMaxBody))
	if err != nil {
		return res.StatusCode, nil, err
	}
	return res.StatusCode, raw, nil
}

// stageError names the upstream refusal so the panel does not report a stale
// session cookie for an edge decision.
func stageError(stage string, status int, raw []byte) error {
	detail := string(raw)
	if len(detail) > 300 {
		detail = detail[:300]
	}
	lower := strings.ToLower(detail)
	switch {
	case strings.Contains(lower, "missing_client_attestation"):
		return &oauthStageError{Code: "client_attestation_required", Status: status, Message: stage + " failed: " + detail}
	case strings.Contains(lower, "origin not allowed"):
		return &oauthStageError{Code: "origin_rejected", Status: status, Message: stage + " failed: " + detail}
	case strings.Contains(lower, "not fresh enough"):
		return &oauthStageError{Code: "session_stale_relogin", Status: status, Message: stage + " failed: " + detail}
	}
	return &oauthStageError{Code: stage + "_failed", Status: status, Message: fmt.Sprintf("%s failed: %d %s", stage, status, detail)}
}
