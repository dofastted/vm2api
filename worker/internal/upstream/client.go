package upstream

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/dofastted/kin-gateway/worker/internal/credential"
	kinoauth "github.com/dofastted/kin-gateway/worker/internal/oauth"
	kinproxy "github.com/dofastted/kin-gateway/worker/internal/proxy"
	"github.com/imroc/req/v3"
)

type Client struct {
	HTTP           *http.Client
	Store          *credential.Store
	Refresher      *kinoauth.Refresher
	AnthropicBase  *url.URL
	RequestTimeout time.Duration
}

type Response struct {
	Status int
	Header http.Header
	Body   io.ReadCloser
}

func NewHTTPClient(proxyURL string, proxyRequired bool, timeout time.Duration) (*http.Client, error) {
	dialContext, _, err := slotDialers(proxyURL, proxyRequired)
	if err != nil {
		return nil, err
	}
	// Inference: Node.js 24 / Claude Code ClientHello + HTTP/2. Not Chrome.
	// SOCKS dial only — req/v3 owns the uTLS handshake (same as OAuth).
	// timeout<=0 disables req/v3's default overall deadline (2m) so long
	// thinking/streams are bounded only by Pump first-byte + idle.
	client := req.C().
		SetTimeout(timeout).
		SetTLSFingerprintSpec(node24ClientHelloSpecValue).
		SetCookieJar(nil).
		SetProxy(noProxy).
		SetDial(dialContext)
	httpClient := client.GetClient()
	httpClient.Timeout = timeout
	httpClient.CheckRedirect = func(_ *http.Request, _ []*http.Request) error {
		return errors.New("upstream redirects are disabled")
	}
	return httpClient, nil
}

// NewOAuthHTTPClient mirrors Sub2API's Claude OAuth transport: Chrome TLS
// impersonation over the slot-bound SOCKS5 dialer. SetProxyURL is not used —
// that made req/v3 TCP-dial the proxy and then SOCKS-CONNECT to the proxy
// itself (pcap 2026-08-19). The impersonate client must Dial through kinproxy
// with the upstream host as the CONNECT target.
func NewOAuthHTTPClient(proxyURL string, proxyRequired bool, timeout time.Duration) (*http.Client, error) {
	if strings.TrimSpace(proxyURL) == "" {
		if proxyRequired {
			return nil, errors.New("slot proxy is required for OAuth refresh")
		}
		// Process may start without SOCKS; outbound still cannot go direct.
		return refuseHTTPClient(timeout), nil
	}
	dialContext, _, err := slotDialers(proxyURL, proxyRequired)
	if err != nil {
		if strings.Contains(err.Error(), "slot proxy is required") {
			return nil, errors.New("slot proxy is required for OAuth refresh")
		}
		return nil, err
	}
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	client := req.C().
		SetTimeout(timeout).
		ImpersonateChrome().
		SetCookieJar(nil).
		SetProxy(noProxy).
		SetDial(dialContext)
	client.GetClient().CheckRedirect = func(_ *http.Request, _ []*http.Request) error {
		return errors.New("OAuth redirects are disabled")
	}
	return client.GetClient(), nil
}

func NewTransparentHTTPClient(timeout time.Duration) (*http.Client, error) {
	dial := (&net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}).DialContext
	client := req.C().
		SetTimeout(timeout).
		SetTLSFingerprintSpec(node24ClientHelloSpecValue).
		SetCookieJar(nil).
		SetProxy(noProxy).
		SetDial(dial)
	httpClient := client.GetClient()
	httpClient.Timeout = timeout
	httpClient.CheckRedirect = func(_ *http.Request, _ []*http.Request) error {
		return errors.New("upstream redirects are disabled")
	}
	return httpClient, nil
}

func NewTransparentOAuthHTTPClient(timeout time.Duration) (*http.Client, error) {
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	dial := (&net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}).DialContext
	client := req.C().
		SetTimeout(timeout).
		ImpersonateChrome().
		SetCookieJar(nil).
		SetProxy(noProxy).
		SetDial(dial)
	client.GetClient().CheckRedirect = func(_ *http.Request, _ []*http.Request) error {
		return errors.New("OAuth redirects are disabled")
	}
	return client.GetClient(), nil
}

func noProxy(*http.Request) (*url.URL, error) {
	return nil, nil
}

func slotDialers(proxyURL string, proxyRequired bool) (dial, dialTLS func(context.Context, string, string) (net.Conn, error), err error) {
	if strings.TrimSpace(proxyURL) != "" {
		socks, socksErr := kinproxy.New(proxyURL, 15*time.Second)
		if socksErr != nil {
			return nil, nil, socksErr
		}
		tlsCfg := &tls.Config{MinVersion: tls.VersionTLS12}
		return socks.DialContext, func(ctx context.Context, network, addr string) (net.Conn, error) {
			raw, dialErr := socks.DialContext(ctx, network, addr)
			if dialErr != nil {
				return nil, dialErr
			}
			host, _, splitErr := net.SplitHostPort(addr)
			if splitErr != nil {
				_ = raw.Close()
				return nil, splitErr
			}
			cfg := tlsCfg.Clone()
			cfg.ServerName = host
			conn := tls.Client(raw, cfg)
			if hsErr := conn.HandshakeContext(ctx); hsErr != nil {
				_ = raw.Close()
				return nil, hsErr
			}
			return conn, nil
		}, nil
	}
	if proxyRequired {
		return nil, nil, errors.New("slot proxy is required")
	}
	refuse := func(context.Context, string, string) (net.Conn, error) {
		return nil, errors.New("slot proxy is required")
	}
	return refuse, refuse, nil
}

func refuseHTTPClient(timeout time.Duration) *http.Client {
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	refuse := func(context.Context, string, string) (net.Conn, error) {
		return nil, errors.New("slot proxy is required")
	}
	client := req.C().
		SetTimeout(timeout).
		SetCookieJar(nil).
		SetProxy(noProxy).
		SetDial(refuse)
	httpClient := client.GetClient()
	httpClient.CheckRedirect = func(_ *http.Request, _ []*http.Request) error {
		return errors.New("upstream redirects are disabled")
	}
	return httpClient
}

func (c *Client) Messages(ctx context.Context, payload json.RawMessage, headers map[string]string) (*Response, error) {
	credentialValue, err := c.ensureCredential(ctx, false)
	if err != nil {
		return nil, err
	}
	// 401 is returned to Node for failover. Do not force-refresh: Anthropic
	// OAuth 401 is often "this endpoint rejected the token", not expiry, and
	// a forced refresh burns a still-valid grant (invalid_grant).
	return c.do(ctx, http.MethodPost, "/v1/messages", payload, headers, credentialValue)
}

func (c *Client) CountTokens(ctx context.Context, payload json.RawMessage, headers map[string]string) (*Response, error) {
	credentialValue, err := c.ensureCredential(ctx, false)
	if err != nil {
		return nil, err
	}
	return c.do(ctx, http.MethodPost, "/v1/messages/count_tokens", payload, headers, credentialValue)
}

func (c *Client) Get(ctx context.Context, path string, headers map[string]string) (*Response, error) {
	credentialValue, err := c.ensureCredential(ctx, false)
	if err != nil {
		return nil, err
	}
	return c.do(ctx, http.MethodGet, path, nil, headers, credentialValue)
}

func (c *Client) Post(ctx context.Context, path string, payload []byte, headers map[string]string) (*Response, error) {
	credentialValue, err := c.ensureCredential(ctx, false)
	if err != nil {
		return nil, err
	}
	return c.do(ctx, http.MethodPost, path, payload, headers, credentialValue)
}

func (c *Client) ensureCredential(ctx context.Context, force bool) (credential.Credential, error) {
	if c.Refresher != nil {
		// Sole refresh manager. Do not add a parallel ticker or Node-side token grant.
		result, err := c.Refresher.Ensure(ctx, force)
		if err != nil {
			return credential.Credential{}, err
		}
		return result.Credential, nil
	}
	if c.Store == nil {
		return credential.Credential{}, errors.New("credential store is not configured")
	}
	current, err := c.Store.Status()
	if err != nil {
		return credential.Credential{}, err
	}
	if !current.Valid() {
		return credential.Credential{}, errors.New("credential has no access token")
	}
	return current, nil
}

func (c *Client) do(
	ctx context.Context,
	method string,
	path string,
	payload []byte,
	headers map[string]string,
	cred credential.Credential,
) (*Response, error) {
	if c.HTTP == nil {
		return nil, errors.New("upstream HTTP client is not configured")
	}
	target, err := c.resolve(path)
	if err != nil {
		return nil, err
	}
	var body io.Reader
	if payload != nil {
		body = bytes.NewReader(payload)
	}
	request, err := http.NewRequestWithContext(ctx, method, target, body)
	if err != nil {
		return nil, fmt.Errorf("build upstream request: %w", err)
	}
	for key, value := range headers {
		if !allowedHeader(key) || strings.TrimSpace(value) == "" {
			continue
		}
		request.Header.Set(key, value)
	}
	request.Header.Del("Cookie")
	applyCredentialAuth(request, cred)
	if request.Header.Get("Content-Type") == "" && payload != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if request.Header.Get("Accept") == "" {
		request.Header.Set("Accept", "application/json")
	}
	if request.Header.Get("Anthropic-Version") == "" {
		request.Header.Set("Anthropic-Version", "2023-06-01")
	}
	response, err := c.HTTP.Do(request)
	if err != nil {
		return nil, fmt.Errorf("upstream transport: %w", err)
	}
	return &Response{
		Status: response.StatusCode,
		Header: response.Header.Clone(),
		Body:   response.Body,
	}, nil
}

func applyCredentialAuth(request *http.Request, cred credential.Credential) {
	token := cred.Token()
	if cred.ResolvedAuthScheme() == credential.AuthSchemeBearer {
		request.Header.Del("X-Api-Key")
		request.Header.Set("Authorization", "Bearer "+token)
		return
	}
	request.Header.Del("Authorization")
	request.Header.Set("X-Api-Key", token)
}

func (c *Client) resolve(path string) (string, error) {
	if c.AnthropicBase == nil {
		return "", errors.New("Anthropic base URL is not configured")
	}
	relative, err := url.Parse(path)
	if err != nil {
		return "", err
	}
	target := c.AnthropicBase.ResolveReference(relative)
	if !sameOrigin(c.AnthropicBase, target) {
		return "", errors.New("upstream path escaped Anthropic origin")
	}
	return target.String(), nil
}

func sameOrigin(left, right *url.URL) bool {
	if left == nil || right == nil {
		return false
	}
	return strings.EqualFold(left.Scheme, right.Scheme) &&
		strings.EqualFold(left.Hostname(), right.Hostname()) &&
		normalizedPort(left) == normalizedPort(right)
}

func normalizedPort(value *url.URL) string {
	if value.Port() != "" {
		return value.Port()
	}
	if value.Scheme == "https" {
		return "443"
	}
	return "80"
}

func allowedHeader(key string) bool {
	switch strings.ToLower(strings.TrimSpace(key)) {
	case "accept",
		"accept-language",
		"anthropic-beta",
		"anthropic-dangerous-direct-browser-access",
		"anthropic-version",
		"content-type",
		"user-agent",
		"x-app",
		"x-claude-code-agent-type",
		"x-claude-code-compaction",
		"x-claude-code-context-compacted",
		"x-claude-code-prev-tool-durations",
		"x-claude-code-prompt-id",
		"x-claude-code-request-class",
		"x-claude-code-session-id",
		"x-client-request-id",
		"x-stainless-arch",
		"x-stainless-helper-method",
		"x-stainless-lang",
		"x-stainless-os",
		"x-stainless-package-version",
		"x-stainless-retry-count",
		"x-stainless-runtime",
		"x-stainless-runtime-version",
		"x-stainless-timeout":
		return true
	default:
		return false
	}
}
