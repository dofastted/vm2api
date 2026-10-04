package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	kinproxy "github.com/dofastted/kin-gateway/worker/internal/proxy"
)

const (
	defaultAnthropicBase = "https://api.anthropic.com"
	defaultOAuthTokenURL = "https://platform.claude.com/v1/oauth/token"
	// DefaultFirstByteSecs waits for Anthropic HTTP headers / first SSE event.
	// Matches sub2api gateway.response_header_timeout (600s). 0 overall request
	// timeout — stream length is bounded by IdleTimeout, not wall-clock Do().
	DefaultFirstByteSecs      = 600
	DefaultIdleTimeoutSecs    = 180
	DefaultRequestTimeoutSecs = 0
)

type Config struct {
	VMID              string          `json:"vm_id"`
	SocketPath        string          `json:"socket_path"`
	CredentialPath    string          `json:"credential_path"`
	ProxyURL          string          `json:"proxy_url"`
	ProxyRequired     bool            `json:"proxy_required"`
	EgressMode        string          `json:"egress_mode"`
	AnthropicBaseURL  string          `json:"anthropic_base_url"`
	OAuthTokenURL     string          `json:"oauth_token_url"`
	InternalToken     string          `json:"internal_token"`
	RefreshSkew       time.Duration   `json:"-"`
	RefreshSkewSecs   int             `json:"refresh_skew_seconds"`
	RequestTimeout    time.Duration   `json:"-"`
	RequestTimeoutSec int             `json:"request_timeout_seconds"`
	FirstByteTimeout  time.Duration   `json:"-"`
	FirstByteSecs     int             `json:"first_byte_timeout_seconds"`
	IdleTimeout       time.Duration   `json:"-"`
	IdleTimeoutSecs   int             `json:"idle_timeout_seconds"`
	MaxRequestBytes   int64           `json:"max_request_bytes"`
	MaxResponseBytes  int64           `json:"max_response_bytes"`
	MaxEventBytes     int             `json:"max_event_bytes"`
	DeliveryMode      string          `json:"delivery_mode"`
	TestEndpoints     bool            `json:"test_endpoints"`
	RuntimeKind       string          `json:"runtime_kind"`
	Telemetry         TelemetryConfig `json:"telemetry"`
	ConfigPath        string          `json:"-"`
}

type TelemetryConfig struct {
	Enabled  bool              `json:"enabled"`
	Identity TelemetryIdentity `json:"identity"`
	Headers  map[string]string `json:"headers"`
	// Betas is the Claude Code main-session header. Empty means the Go default.
	Betas string `json:"betas"`
}

type TelemetryIdentity struct {
	DeviceID           string           `json:"device_id"`
	UserID             string           `json:"user_id"`
	AccountUUID        string           `json:"account_uuid"`
	OrgUUID            string           `json:"org_uuid"`
	Email              string           `json:"email"`
	SessionID          string           `json:"session_id"`
	SubscriptionType   string           `json:"subscription_type"`
	Platform           string           `json:"platform"`
	PlatformRaw        string           `json:"platform_raw"`
	Arch               string           `json:"arch"`
	NodeVersion        string           `json:"node_version"`
	Locale             string           `json:"locale"`
	Timezone           string           `json:"timezone"`
	CLIVersion         string           `json:"cli_version"`
	Entrypoint         string           `json:"entrypoint"`
	Terminal           string           `json:"terminal"`
	PackageManagers    string           `json:"package_managers"`
	LinuxDistroID      string           `json:"linux_distro_id"`
	LinuxDistroVersion string           `json:"linux_distro_version"`
	LinuxKernel        string           `json:"linux_kernel"`
	Process            TelemetryProcess `json:"process"`
	Source             string           `json:"source"`
	Env                map[string]any   `json:"env"`
	Betas              string           `json:"betas"`
}

type TelemetryProcess struct {
	ConstrainedMemory int64   `json:"constrained_memory"`
	RSSRange          []int64 `json:"rss_range"`
	HeapTotalRange    []int64 `json:"heap_total_range"`
	HeapUsedRange     []int64 `json:"heap_used_range"`
	ExternalRange     []int64 `json:"external_range"`
	ArrayBuffersRange []int64 `json:"array_buffers_range"`
}

func Load(path string) (Config, error) {
	var cfg Config
	if strings.TrimSpace(path) == "" {
		return cfg, errors.New("worker config path is required")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return cfg, fmt.Errorf("read worker config: %w", err)
	}
	if err = json.Unmarshal(data, &cfg); err != nil {
		return cfg, fmt.Errorf("decode worker config: %w", err)
	}
	cfg.applyDefaults()
	if err = cfg.Validate(); err != nil {
		return cfg, err
	}
	cfg.ConfigPath = path
	return cfg, nil
}

// LoadTelemetry reads only worker.json's telemetry block.
// Proxy and endpoint validation stay out of this path so a hot reload can
// apply identity, headers, env, and betas without bouncing the process.
func LoadTelemetry(path string) (TelemetryConfig, error) {
	if strings.TrimSpace(path) == "" {
		return TelemetryConfig{}, errors.New("worker config path is required")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return TelemetryConfig{}, fmt.Errorf("read worker config: %w", err)
	}
	var wrap struct {
		Telemetry TelemetryConfig `json:"telemetry"`
	}
	if err = json.Unmarshal(data, &wrap); err != nil {
		return TelemetryConfig{}, fmt.Errorf("decode worker config: %w", err)
	}
	return wrap.Telemetry, nil
}

func (c *Config) applyDefaults() {
	if c.SocketPath == "" {
		c.SocketPath = "/run/kin/worker.sock"
	}
	if c.CredentialPath == "" {
		c.CredentialPath = "/home/kincli/.claude/credentials.json"
	}
	if c.AnthropicBaseURL == "" {
		c.AnthropicBaseURL = defaultAnthropicBase
	}
	if c.OAuthTokenURL == "" {
		c.OAuthTokenURL = defaultOAuthTokenURL
	}
	if c.RefreshSkewSecs <= 0 {
		c.RefreshSkewSecs = 300
	}
	if c.RequestTimeoutSec < 0 {
		c.RequestTimeoutSec = DefaultRequestTimeoutSecs
	}
	if c.FirstByteSecs <= 0 {
		c.FirstByteSecs = DefaultFirstByteSecs
	}
	if c.IdleTimeoutSecs <= 0 {
		c.IdleTimeoutSecs = DefaultIdleTimeoutSecs
	}
	if c.MaxRequestBytes <= 0 {
		c.MaxRequestBytes = 32 << 20
	}
	if c.MaxResponseBytes <= 0 {
		c.MaxResponseBytes = 64 << 20
	}
	if c.MaxEventBytes <= 0 {
		c.MaxEventBytes = 32 << 20
	}
	if c.DeliveryMode == "" {
		c.DeliveryMode = "realtime"
	}
	if strings.TrimSpace(c.RuntimeKind) == "" {
		c.RuntimeKind = "docker"
	}
	c.RefreshSkew = time.Duration(c.RefreshSkewSecs) * time.Second
	c.RequestTimeout = time.Duration(c.RequestTimeoutSec) * time.Second
	c.FirstByteTimeout = time.Duration(c.FirstByteSecs) * time.Second
	c.IdleTimeout = time.Duration(c.IdleTimeoutSecs) * time.Second
}

func (c Config) Validate() error {
	if strings.TrimSpace(c.VMID) == "" {
		return errors.New("vm_id is required")
	}
	if !filepath.IsAbs(c.SocketPath) {
		return errors.New("socket_path must be absolute")
	}
	if !filepath.IsAbs(c.CredentialPath) {
		return errors.New("credential_path must be absolute")
	}
	if c.ProxyRequired && strings.TrimSpace(c.ProxyURL) == "" && strings.TrimSpace(c.EgressMode) != "transparent" {
		return errors.New("proxy_required but proxy_url is empty")
	}
	if c.ProxyURL != "" {
		if _, err := kinproxy.New(c.ProxyURL, 15*time.Second); err != nil {
			return fmt.Errorf("invalid proxy_url: %w", err)
		}
	}

	if err := validateEndpoint(c.AnthropicBaseURL, "api.anthropic.com", c.TestEndpoints); err != nil {
		return fmt.Errorf("anthropic_base_url: %w", err)
	}
	if err := validateEndpoint(c.OAuthTokenURL, "platform.claude.com", c.TestEndpoints); err != nil {
		return fmt.Errorf("oauth_token_url: %w", err)
	}
	if c.DeliveryMode != "realtime" && c.DeliveryMode != "verified" {
		return fmt.Errorf("delivery_mode must be realtime or verified, got %q", c.DeliveryMode)
	}
	mode := strings.TrimSpace(c.EgressMode)
	if mode != "" && mode != "transparent" && mode != "socks" {
		return fmt.Errorf("egress_mode must be transparent or socks, got %q", c.EgressMode)
	}
	return nil
}

func validateEndpoint(raw, productionHost string, allowTest bool) error {
	u, err := url.Parse(raw)
	if err != nil {
		return err
	}
	if u.Scheme != "https" && !(allowTest && u.Scheme == "http") {
		return errors.New("endpoint must use https")
	}
	if !allowTest && !strings.EqualFold(u.Hostname(), productionHost) {
		return fmt.Errorf("endpoint host must be %s", productionHost)
	}
	return nil
}

func FromEnv() (Config, error) {
	cfg := Config{
		VMID:             os.Getenv("KIN_VM_ID"),
		SocketPath:       os.Getenv("KIN_WORKER_SOCKET"),
		CredentialPath:   os.Getenv("KIN_CREDENTIAL_PATH"),
		ProxyURL:         os.Getenv("KIN_PROXY_URL"),
		ProxyRequired:    envBool("KIN_PROXY_REQUIRED", true),
		AnthropicBaseURL: os.Getenv("KIN_ANTHROPIC_BASE_URL"),
		OAuthTokenURL:    os.Getenv("KIN_OAUTH_TOKEN_URL"),
		InternalToken:    os.Getenv("KIN_WORKER_INTERNAL_TOKEN"),
		DeliveryMode:     os.Getenv("KIN_STREAM_DELIVERY_MODE"),
		TestEndpoints:    envBool("KIN_WORKER_TEST_ENDPOINTS", false),
		RuntimeKind:      os.Getenv("KIN_RUNTIME_KIND"),
	}
	cfg.RefreshSkewSecs = envInt("KIN_REFRESH_SKEW_SECONDS", 300)
	cfg.RequestTimeoutSec = envInt("KIN_WORKER_REQUEST_TIMEOUT_SECONDS", DefaultRequestTimeoutSecs)
	cfg.FirstByteSecs = envInt("KIN_WORKER_FIRST_BYTE_SECONDS", DefaultFirstByteSecs)
	cfg.IdleTimeoutSecs = envInt("KIN_WORKER_IDLE_SECONDS", DefaultIdleTimeoutSecs)
	cfg.applyDefaults()
	return cfg, cfg.Validate()
}

func envBool(key string, fallback bool) bool {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	value, err := strconv.ParseBool(raw)
	if err != nil {
		return fallback
	}
	return value
}

func envInt(key string, fallback int) int {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}
	return value
}
