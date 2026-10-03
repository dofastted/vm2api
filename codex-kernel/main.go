package main

import (
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	defaultEndpoint = "https://chatgpt.com/backend-api/codex/responses"
	tokenEndpoint   = "https://auth.openai.com/oauth/token"
	oauthClientID   = "app_EMoamEEZ73f0CkXaXp7hrann"
	oauthScope      = "openid profile email offline_access api.connectors.read api.connectors.invoke"
)

type Config struct {
	SocketPath      string `json:"socket_path"`
	CredentialPath  string `json:"credential_path"`
	ProxyURL        string `json:"proxy_url"`
	ProxyRequired   bool   `json:"proxy_required"`
	InternalToken   string `json:"internal_token"`
	MaxRequestBytes int64  `json:"max_request_bytes"`
	CustomBaseURL   string `json:"custom_base_url"`
}

type Envelope struct {
	Body      map[string]any    `json:"body"`
	Headers   map[string]string `json:"headers"`
	RequestID string            `json:"request_id"`
}

type credentialFile struct {
	Accounts []account `json:"accounts"`
}

type account struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	IDToken      string `json:"id_token"`
	ID           string `json:"id"`
	ExpiresAt    int64  `json:"expires_at"`
}

type server struct {
	cfg     Config
	client  *http.Client
	mu      sync.Mutex
	account account
}

func main() {
	if len(os.Args) != 2 {
		log.Fatal("usage: kin-codex-kernel CONFIG")
	}
	cfgBytes, err := os.ReadFile(os.Args[1])
	if err != nil {
		log.Fatal(err)
	}
	var cfg Config
	if err := json.Unmarshal(cfgBytes, &cfg); err != nil {
		log.Fatal(err)
	}
	if cfg.SocketPath == "" || cfg.CredentialPath == "" {
		log.Fatal("socket_path and credential_path are required")
	}
	if cfg.MaxRequestBytes <= 0 {
		cfg.MaxRequestBytes = 64 << 20
	}
	account, err := loadAccount(cfg.CredentialPath)
	if err != nil {
		log.Fatal(err)
	}
	client, err := buildClient(cfg)
	if err != nil {
		log.Fatal(err)
	}
	s := &server{cfg: cfg, client: client, account: account}
	_ = os.Remove(cfg.SocketPath)
	if err := os.MkdirAll(filepath.Dir(cfg.SocketPath), 0700); err != nil {
		log.Fatal(err)
	}
	listener, err := net.Listen("unix", cfg.SocketPath)
	if err != nil {
		log.Fatal(err)
	}
	_ = os.Chmod(cfg.SocketPath, 0600)
	httpServer := &http.Server{Handler: s.handler(), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		if err := httpServer.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("server: %v", err)
		}
	}()
	log.Printf("kin-codex-kernel listening on %s", cfg.SocketPath)
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT)
	<-signals
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = httpServer.Shutdown(ctx)
}

func loadAccount(path string) (account, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return account{}, err
	}
	var file credentialFile
	if err := json.Unmarshal(b, &file); err != nil {
		return account{}, err
	}
	for _, candidate := range file.Accounts {
		if strings.TrimSpace(candidate.AccessToken) != "" {
			return candidate, nil
		}
	}
	return account{}, fmt.Errorf("credential file has no access token")
}

func buildClient(cfg Config) (*http.Client, error) {
	transport := &http.Transport{
		TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12},
		Proxy:           http.ProxyFromEnvironment,
	}
	if proxy := strings.TrimSpace(cfg.ProxyURL); proxy != "" {
		u, err := url.Parse(proxy)
		if err != nil {
			return nil, err
		}
		if u.Scheme != "http" && u.Scheme != "https" {
			return nil, fmt.Errorf("unsupported proxy scheme %q", u.Scheme)
		}
		transport.Proxy = http.ProxyURL(u)
	} else if cfg.ProxyRequired {
		return nil, fmt.Errorf("proxy required")
	}
	return &http.Client{Transport: transport}, nil
}

func (s *server) handler() http.Handler {
	mux := http.NewServeMux()
	auth := func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if s.cfg.InternalToken != "" && r.Header.Get("x-kin-internal-token") != s.cfg.InternalToken {
				http.Error(w, `{"ok":false,"error":{"code":"internal_auth_failed"}}`, http.StatusUnauthorized)
				return
			}
			next(w, r)
		}
	}
	mux.HandleFunc("GET /internal/health", auth(s.health))
	mux.HandleFunc("POST /internal/v1/codex/responses", auth(s.responses))
	mux.HandleFunc("POST /internal/v1/cancel", auth(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	return mux
}

func (s *server) health(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("content-type", "application/json")
	_, _ = w.Write([]byte(`{"ok":true,"status":"ready","kernel":"codex-go","version":"routing-hint"}`))
}

func (s *server) responses(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, s.cfg.MaxRequestBytes)
	var envelope Envelope
	if err := json.NewDecoder(r.Body).Decode(&envelope); err != nil {
		http.Error(w, `{"type":"error","error":{"code":"invalid_json"}}`, http.StatusBadRequest)
		return
	}
	body := envelope.Body
	if body == nil {
		body = map[string]any{}
	}
	if err := s.refreshIfNeeded(r.Context()); err != nil {
		http.Error(w, jsonError("credential_refresh_failed", err.Error()), http.StatusBadGateway)
		return
	}

	model, _ := body["model"].(string)
	tier, _ := body["service_tier"].(string)
	tier = strings.ToLower(strings.TrimSpace(tier))
	if tier == "fast" {
		tier = "priority"
		body["service_tier"] = tier
	}

	requestHeaders := make(map[string]string, len(envelope.Headers)+6)
	for key, value := range envelope.Headers {
		if strings.TrimSpace(value) == "" || hopByHopHeader(key) {
			continue
		}
		requestHeaders[key] = value
	}
	if model != "" {
		hint := "model=" + strings.TrimSpace(model)
		if tier != "" && tier != "default" {
			hint += ";tier=" + tier
		}
		requestHeaders["x-codex-routing-hint"] = hint
	}

	s.mu.Lock()
	accessToken := s.account.AccessToken
	accountID := accountIDFromToken(accessToken)
	if accountID == "" {
		accountID = s.account.ID
	}
	s.mu.Unlock()
	requestHeaders["Authorization"] = "Bearer " + accessToken
	if accountID != "" {
		requestHeaders["chatgpt-account-id"] = accountID
	}
	requestHeaders["Content-Type"] = "application/json"
	requestHeaders["User-Agent"] = "codex_cli_rs/0.153.4 (linux x86_64)"
	if requestHeaders["originator"] == "" {
		requestHeaders["originator"] = "Codex"
	}

	payload, err := json.Marshal(body)
	if err != nil {
		http.Error(w, `{"type":"error","error":{"code":"invalid_body"}}`, http.StatusBadRequest)
		return
	}
	endpoint := strings.TrimSpace(s.cfg.CustomBaseURL)
	if endpoint == "" {
		endpoint = defaultEndpoint
	}
	response, err := s.post(r.Context(), endpoint, payload, requestHeaders)
	if err != nil {
		http.Error(w, jsonError("upstream_transport", err.Error()), http.StatusBadGateway)
		return
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusUnauthorized {
		if refreshErr := s.refresh(r.Context()); refreshErr == nil {
			s.mu.Lock()
			requestHeaders["Authorization"] = "Bearer " + s.account.AccessToken
			s.mu.Unlock()
			if response.Body != nil {
				_ = response.Body.Close()
			}
			response, err = s.post(r.Context(), endpoint, payload, requestHeaders)
			if err != nil {
				http.Error(w, jsonError("upstream_transport", err.Error()), http.StatusBadGateway)
				return
			}
			defer response.Body.Close()
		}
	}
	for key, values := range response.Header {
		lower := strings.ToLower(key)
		if lower == "content-length" || lower == "transfer-encoding" || lower == "connection" {
			continue
		}
		for _, value := range values {
			w.Header().Add(key, value)
		}
	}
	w.WriteHeader(response.StatusCode)
	if flusher, ok := w.(http.Flusher); ok {
		flusher.Flush()
	}
	_, _ = io.Copy(w, response.Body)
}

func (s *server) post(ctx context.Context, endpoint string, payload []byte, headers map[string]string) (*http.Response, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(string(payload)))
	if err != nil {
		return nil, err
	}
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	return s.client.Do(request)
}

func (s *server) refreshIfNeeded(ctx context.Context) error {
	s.mu.Lock()
	expiresAt := s.account.ExpiresAt
	refreshToken := s.account.RefreshToken
	s.mu.Unlock()
	if expiresAt == 0 || refreshToken == "" {
		return nil
	}
	if expiresAt < 1_000_000_000_000 {
		expiresAt *= 1000
	}
	if time.Now().Add(60*time.Second).UnixMilli() < expiresAt {
		return nil
	}
	return s.refresh(ctx)
}

func (s *server) refresh(ctx context.Context) error {
	s.mu.Lock()
	refreshToken := s.account.RefreshToken
	s.mu.Unlock()
	if refreshToken == "" {
		return fmt.Errorf("refresh token missing")
	}
	form := url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {refreshToken},
		"client_id":     {oauthClientID},
		"scope":         {oauthScope},
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, tokenEndpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return err
	}
	request.Header.Set("accept", "application/json")
	request.Header.Set("content-type", "application/x-www-form-urlencoded")
	request.Header.Set("user-agent", "codex_cli_rs/0.153.4 (linux x86_64)")
	response, err := s.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	var token struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		IDToken      string `json:"id_token"`
		ExpiresIn    int64  `json:"expires_in"`
	}
	if err := json.NewDecoder(response.Body).Decode(&token); err != nil {
		return err
	}
	if response.StatusCode >= 400 || strings.TrimSpace(token.AccessToken) == "" {
		return fmt.Errorf("refresh rejected with status %d", response.StatusCode)
	}
	if token.RefreshToken == "" {
		token.RefreshToken = refreshToken
	}
	s.mu.Lock()
	s.account.AccessToken = token.AccessToken
	s.account.RefreshToken = token.RefreshToken
	s.account.IDToken = token.IDToken
	if token.ExpiresIn > 0 {
		s.account.ExpiresAt = time.Now().Add(time.Duration(token.ExpiresIn) * time.Second).UnixMilli()
	}
	updated := s.account
	s.mu.Unlock()
	return persistAccount(s.cfg.CredentialPath, updated)
}

func persistAccount(path string, updated account) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var file credentialFile
	if err := json.Unmarshal(b, &file); err != nil || len(file.Accounts) == 0 {
		return fmt.Errorf("invalid credential file")
	}
	for i := range file.Accounts {
		if file.Accounts[i].ID == updated.ID || i == 0 {
			file.Accounts[i].AccessToken = updated.AccessToken
			file.Accounts[i].RefreshToken = updated.RefreshToken
			file.Accounts[i].IDToken = updated.IDToken
			file.Accounts[i].ExpiresAt = updated.ExpiresAt
			break
		}
	}
	encoded, err := json.MarshalIndent(file, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(encoded, '\n'), 0600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func hopByHopHeader(key string) bool {
	switch strings.ToLower(key) {
	case "authorization", "cookie", "proxy-authorization", "host", "content-length", "connection", "transfer-encoding":
		return true
	default:
		return false
	}
}

func jsonError(code, message string) string {
	b, _ := json.Marshal(map[string]any{"type": "error", "error": map[string]string{"code": code, "message": message}})
	return string(b)
}

func accountIDFromToken(token string) string {
	parts := strings.Split(token, ".")
	if len(parts) < 2 {
		return ""
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return ""
	}
	var claims map[string]any
	if json.Unmarshal(payload, &claims) != nil {
		return ""
	}
	if auth, ok := claims["https://api.openai.com/auth"].(map[string]any); ok {
		if id, ok := auth["chatgpt_account_id"].(string); ok {
			return id
		}
	}
	return ""
}
