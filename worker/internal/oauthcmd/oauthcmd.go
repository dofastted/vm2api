package oauthcmd

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/dofastted/kin-gateway/worker/internal/config"
	"github.com/dofastted/kin-gateway/worker/internal/credential"
	kinoauth "github.com/dofastted/kin-gateway/worker/internal/oauth"
	"github.com/dofastted/kin-gateway/worker/internal/upstream"
)

const (
	requestTimeout       = 30 * time.Second
	maxBodyBytes         = 4 << 20
	claudeResetUsagePath = "/api/oauth/usage?cedar_ember=1&skip_spend=1"
)

var (
	resetOrgPattern     = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	resetGrantPattern   = regexp.MustCompile(`^[a-z0-9_-]{1,40}$`)
	resetRequestPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
)

type resetRedeemInput struct {
	OrganizationUUID string `json:"organization_uuid"`
	GrantID          string `json:"grant_id"`
	RequestID        string `json:"request_id"`
}
type responseEnvelope struct {
	OK             bool              `json:"ok"`
	Status         int               `json:"status"`
	Body           any               `json:"body"`
	Headers        map[string]string `json:"headers"`
	RefreshUnknown bool              `json:"refresh_unknown,omitempty"`
}

type countTokensInput struct {
	Body    json.RawMessage   `json:"body"`
	Headers map[string]string `json:"headers"`
}

// Run executes one OAuth-related worker operation.
func Run(args []string, stdin io.Reader, stdout io.Writer) int {
	op, configPath, force, ok := parseArgs(args)
	if !ok {
		return writeAndReturn(stdout, errorEnvelope(0, "invalid_arguments", "invalid oauth arguments"), 2)
	}
	if err := validateOperation(op); err != nil {
		return writeAndReturn(stdout, errorEnvelope(0, "invalid_arguments", err.Error()), 2)
	}

	cfg, err := config.Load(configPath)
	if err != nil {
		code := "config_failed"
		if strings.Contains(strings.ToLower(err.Error()), "proxy_required") {
			code = "proxy_required"
		}
		return writeAndReturn(stdout, errorEnvelope(0, code, errorMessage(code)), 0)
	}

	httpClient, err := oauthHTTPClient(cfg)
	if err != nil {
		code := classifyError(err)
		return writeAndReturn(stdout, errorEnvelope(0, code, errorMessage(code)), 0)
	}
	store := credential.NewStore(cfg.CredentialPath)
	refresher := &kinoauth.Refresher{
		Store:    store,
		Client:   httpClient,
		TokenURL: cfg.OAuthTokenURL,
		Skew:     cfg.RefreshSkew,
	}
	ctx, cancel := context.WithTimeout(context.Background(), requestTimeout)
	defer cancel()

	if op == "refresh" {
		result, err := refresher.Ensure(ctx, force)
		if err != nil {
			return writeAndReturn(stdout, refreshErrorEnvelope(refreshErrorStatus(err), err), 0)
		}
		return writeAndReturn(stdout, responseEnvelope{
			OK:     true,
			Status: http.StatusOK,
			Body: map[string]any{
				"refreshed":   result.Refreshed,
				"expires_at":  result.Credential.ExpiresAt,
				"has_access":  result.Credential.Valid(),
				"has_refresh": strings.TrimSpace(result.Credential.RefreshToken) != "",
			},
			Headers: map[string]string{},
		}, 0)
	}

	baseURL, err := url.Parse(cfg.AnthropicBaseURL)
	if err != nil {
		return writeAndReturn(stdout, errorEnvelope(0, "config_failed", errorMessage("config_failed")), 0)
	}
	client := &upstream.Client{
		HTTP:          httpClient,
		Store:         store,
		Refresher:     refresher,
		AnthropicBase: baseURL,
	}
	headers := requestHeaders(cfg, op)
	var response *upstream.Response
	switch op {
	case "usage":
		response, err = client.Get(ctx, "/api/oauth/usage", headers)
	case "profile":
		response, err = client.Get(ctx, "/api/oauth/profile", headers)
	case "models":
		response, err = client.Get(ctx, "/v1/models?limit=1000", headers)
	case "count-tokens":
		var input countTokensInput
		if err = decodeCountTokens(stdin, &input); err == nil {
			headers = mergeHeaders(headers, input.Headers)
			headers["user-agent"] = userAgent(cfg)
			response, err = client.CountTokens(ctx, input.Body, headers)
		} else {
			return writeAndReturn(stdout, errorEnvelope(0, "invalid_arguments", "invalid count-tokens input"), 2)
		}
	case "reset-status":
		// cedar_ember hides grants unless the caller is the external CLI surface.
		// The slot telemetry UA is claude-code/<ver>, which upstream answers as ineligible_reason=surface.
		headers["user-agent"] = claudeResetUserAgent(cfg)
		headers["x-app"] = "cli"
		response, err = client.Get(ctx, claudeResetUsagePath, headers)
	case "reset-redeem":
		var redeemInput resetRedeemInput
		if err = decodeResetRedeem(stdin, &redeemInput); err != nil {
			return writeAndReturn(stdout, errorEnvelope(0, "invalid_arguments", "invalid reset redeem request"), 2)
		}
		target, pathErr := resetRedeemPath(redeemInput.OrganizationUUID)
		if pathErr != nil {
			return writeAndReturn(stdout, errorEnvelope(0, "invalid_arguments", "invalid reset redeem request"), 2)
		}
		payload, marshalErr := json.Marshal(map[string]string{
			"program":    "cedar_ember",
			"grant_id":   redeemInput.GrantID,
			"request_id": redeemInput.RequestID,
		})
		if marshalErr != nil {
			return writeAndReturn(stdout, errorEnvelope(0, "invalid_arguments", "invalid reset redeem request"), 2)
		}
		headers["user-agent"] = claudeResetUserAgent(cfg)
		headers["x-app"] = "cli"
		response, err = client.Post(ctx, target, payload, headers)
	}
	if err != nil {
		return writeAndReturn(stdout, refreshErrorEnvelope(0, err), 0)
	}
	return writeUpstreamResponse(stdout, response)
}

func parseArgs(args []string) (string, string, bool, bool) {
	if len(args) == 0 {
		return "", "", false, false
	}
	fs := flag.NewFlagSet("oauth", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	configPath := fs.String("config", "", "path to worker JSON config")
	force := fs.Bool("force", false, "force OAuth refresh")
	if err := fs.Parse(args[1:]); err != nil {
		return "", "", false, false
	}
	if fs.NArg() != 0 || strings.TrimSpace(*configPath) == "" {
		return "", "", false, false
	}
	return args[0], *configPath, *force, true
}

func validateOperation(op string) error {
	switch op {
	case "refresh", "usage", "profile", "models", "count-tokens", "reset-status", "reset-redeem":
		return nil
	default:
		return fmt.Errorf("unknown oauth operation %q", op)
	}
}

func oauthHTTPClient(cfg config.Config) (*http.Client, error) {
	if cfg.EgressMode == "transparent" {
		return upstream.NewTransparentOAuthHTTPClient(requestTimeout)
	}
	return upstream.NewOAuthHTTPClient(cfg.ProxyURL, cfg.ProxyRequired, requestTimeout)
}

func requestHeaders(cfg config.Config, op string) map[string]string {
	headers := map[string]string{"user-agent": userAgent(cfg)}
	switch op {
	case "usage", "profile", "models", "reset-status", "reset-redeem":
		headers["anthropic-beta"] = "oauth-2025-04-20"
	}
	return headers
}

func userAgent(cfg config.Config) string {
	for key, value := range cfg.Telemetry.Headers {
		if strings.EqualFold(strings.TrimSpace(key), "user-agent") && strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	if version := strings.TrimSpace(cfg.Telemetry.Identity.CLIVersion); version != "" {
		return "claude-cli/" + version + " (external, cli)"
	}
	return "claude-cli/2.1.293 (external, cli)"
}

func claudeResetUserAgent(cfg config.Config) string {
	version := strings.TrimSpace(cfg.Telemetry.Identity.CLIVersion)
	if version == "" {
		version = "2.1.293"
	}
	return "claude-cli/" + version + " (external, cli)"
}

func mergeHeaders(base, extra map[string]string) map[string]string {
	merged := make(map[string]string, len(base)+len(extra))
	for key, value := range base {
		merged[strings.ToLower(strings.TrimSpace(key))] = value
	}
	for key, value := range extra {
		merged[strings.ToLower(strings.TrimSpace(key))] = value
	}
	return merged
}

func decodeCountTokens(reader io.Reader, input *countTokensInput) error {
	if reader == nil {
		return errors.New("count-tokens input is required")
	}
	raw, err := io.ReadAll(io.LimitReader(reader, maxBodyBytes+1))
	if err != nil {
		return err
	}
	if len(raw) > maxBodyBytes {
		return errors.New("count-tokens input is too large")
	}
	if err := json.Unmarshal(raw, input); err != nil {
		return err
	}
	if len(input.Body) == 0 || bytes.Equal(bytes.TrimSpace(input.Body), []byte("null")) {
		return errors.New("count-tokens body is required")
	}
	return nil
}

func decodeResetRedeem(reader io.Reader, input *resetRedeemInput) error {
	if reader == nil {
		return errors.New("reset redeem input is required")
	}
	raw, err := io.ReadAll(io.LimitReader(reader, maxBodyBytes+1))
	if err != nil {
		return err
	}
	if len(raw) == 0 || len(raw) > maxBodyBytes {
		return errors.New("reset redeem input is invalid")
	}
	if err := json.Unmarshal(raw, input); err != nil {
		return err
	}
	if !resetGrantPattern.MatchString(input.GrantID) || !resetRequestPattern.MatchString(input.RequestID) {
		return errors.New("reset redeem input is invalid")
	}
	return nil
}

func resetRedeemPath(org string) (string, error) {
	if !resetOrgPattern.MatchString(org) || strings.EqualFold(org, "00000000-0000-0000-0000-000000000000") {
		return "", errors.New("invalid organization")
	}
	return "/api/organizations/" + strings.ToLower(org) + "/reset_rate_limits", nil
}

func writeUpstreamResponse(stdout io.Writer, response *upstream.Response) int {
	if response == nil || response.Body == nil {
		return writeAndReturn(stdout, errorEnvelope(0, "upstream_transport_error", errorMessage("upstream_transport_error")), 0)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, maxBodyBytes))
	if err != nil {
		return writeAndReturn(stdout, errorEnvelope(response.Status, "upstream_transport_error", errorMessage("upstream_transport_error")), 0)
	}
	var body any
	if err := json.Unmarshal(raw, &body); err != nil {
		body = map[string]any{
			"error": map[string]string{
				"code":    "non_json",
				"message": firstBytes(raw, 300),
			},
		}
	}
	return writeAndReturn(stdout, responseEnvelope{
		OK:      response.Status >= 200 && response.Status < 300,
		Status:  response.Status,
		Body:    body,
		Headers: safeHeaders(response.Header),
	}, 0)
}

func safeHeaders(headers http.Header) map[string]string {
	result := make(map[string]string)
	for key, values := range headers {
		lower := strings.ToLower(strings.TrimSpace(key))
		switch lower {
		case "set-cookie", "authorization", "x-api-key":
			continue
		}
		if len(values) > 0 {
			result[lower] = strings.Join(values, ", ")
		}
	}
	return result
}

func firstBytes(raw []byte, limit int) string {
	if len(raw) > limit {
		raw = raw[:limit]
	}
	return string(raw)
}

func errorEnvelope(status int, code, message string) responseEnvelope {
	return responseEnvelope{
		OK:     false,
		Status: status,
		Body: map[string]any{
			"error": map[string]string{
				"code":    code,
				"message": message,
			},
		},
		Headers: map[string]string{},
	}
}

func refreshErrorEnvelope(status int, err error) responseEnvelope {
	code := classifyError(err)
	envelope := errorEnvelope(status, code, errorMessage(code))
	envelope.RefreshUnknown = kinoauth.IsRefreshUnknown(err)
	return envelope
}

func classifyError(err error) string {
	if err == nil {
		return ""
	}
	var refreshErr *kinoauth.RefreshError
	if errors.As(err, &refreshErr) {
		if refreshErr.Code == "api_key_missing" {
			return "credential_required"
		}
		return "refresh_failed"
	}
	lower := strings.ToLower(err.Error())
	switch {
	case strings.Contains(lower, "proxy required"),
		strings.Contains(lower, "socks"):
		return "proxy_required"
	case strings.Contains(lower, "upstream transport"),
		strings.Contains(lower, "oauth refresh transport"):
		return "upstream_transport_error"
	case strings.Contains(lower, "credential"),
		strings.Contains(lower, "read credentials"),
		strings.Contains(lower, "decode credentials"),
		strings.Contains(lower, "access token"):
		return "credential_required"
	default:
		return "upstream_transport_error"
	}
}

func refreshErrorStatus(err error) int {
	var refreshErr *kinoauth.RefreshError
	if errors.As(err, &refreshErr) && refreshErr.Status >= 100 && refreshErr.Status <= 599 {
		return refreshErr.Status
	}
	return 0
}

func errorMessage(code string) string {
	switch code {
	case "config_failed":
		return "worker config failed"
	case "proxy_required":
		return "slot SOCKS5 is required"
	case "refresh_failed":
		return "OAuth refresh failed"
	case "credential_required":
		return "credential is required"
	case "upstream_transport_error":
		return "upstream transport failed"
	default:
		return code
	}
}

func writeAndReturn(stdout io.Writer, response responseEnvelope, code int) int {
	if err := json.NewEncoder(stdout).Encode(response); err != nil {
		return 1
	}
	return code
}
