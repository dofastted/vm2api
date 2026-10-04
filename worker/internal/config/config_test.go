package config

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestLoadRuntimeKindDefaultsDocker(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "worker.json")
	sock := filepath.ToSlash(filepath.Join(dir, "worker.sock"))
	cred := filepath.ToSlash(filepath.Join(dir, "credentials.json"))
	raw := fmt.Sprintf(`{
  "vm_id": "vm-01",
  "socket_path": %q,
  "credential_path": %q,
  "proxy_url": "socks5h://127.0.0.1:1080",
  "proxy_required": true,
  "test_endpoints": true,
  "anthropic_base_url": "http://127.0.0.1:9",
  "oauth_token_url": "http://127.0.0.1:9"
}`, sock, cred)
	if err := os.WriteFile(path, []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.RuntimeKind != "docker" {
		t.Fatalf("RuntimeKind=%q", cfg.RuntimeKind)
	}
	if cfg.ConfigPath != path {
		t.Fatalf("ConfigPath=%q", cfg.ConfigPath)
	}
	if cfg.FirstByteSecs != DefaultFirstByteSecs {
		t.Fatalf("FirstByteSecs=%d", cfg.FirstByteSecs)
	}
	if cfg.IdleTimeoutSecs != DefaultIdleTimeoutSecs {
		t.Fatalf("IdleTimeoutSecs=%d", cfg.IdleTimeoutSecs)
	}
	if cfg.RequestTimeoutSec != DefaultRequestTimeoutSecs {
		t.Fatalf("RequestTimeoutSec=%d", cfg.RequestTimeoutSec)
	}
}

func TestLoadTransparentAllowsEmptyProxyURL(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "worker.json")
	sock := filepath.ToSlash(filepath.Join(dir, "worker.sock"))
	cred := filepath.ToSlash(filepath.Join(dir, "credentials.json"))
	raw := fmt.Sprintf(`{
  "vm_id": "vm-01",
  "socket_path": %q,
  "credential_path": %q,
  "proxy_url": "",
  "proxy_required": false,
  "egress_mode": "transparent",
  "test_endpoints": true,
  "anthropic_base_url": "http://127.0.0.1:9",
  "oauth_token_url": "http://127.0.0.1:9"
}`, sock, cred)
	if err := os.WriteFile(path, []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.EgressMode != "transparent" {
		t.Fatalf("EgressMode=%q", cfg.EgressMode)
	}
	if cfg.ProxyURL != "" {
		t.Fatalf("ProxyURL=%q", cfg.ProxyURL)
	}
}

func TestLoadTelemetryKeepsEnvBetasAndSource(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "worker.json")
	raw := `{
  "vm_id": "",
  "proxy_url": "",
  "telemetry": {
    "enabled": true,
    "betas": "thinking-binding-controls-2026-08-01",
    "headers": {"user-agent": "claude-code/2.1.278"},
    "identity": {
      "device_id": "dev",
      "cli_version": "2.1.278",
      "source": "official-cc-init",
      "betas": "thinking-binding-controls-2026-08-01",
      "env": {"version": "2.1.278", "linux_kernel": "6.8.0", "platform": "linux"}
    }
  }
}`
	if err := os.WriteFile(path, []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
	tel, err := LoadTelemetry(path)
	if err != nil {
		t.Fatal(err)
	}
	if !tel.Enabled || tel.Betas == "" || tel.Identity.Source != "official-cc-init" {
		t.Fatalf("telemetry=%+v", tel)
	}
	if tel.Identity.Env["linux_kernel"] != "6.8.0" || tel.Identity.Env["version"] != "2.1.278" {
		t.Fatalf("env=%v", tel.Identity.Env)
	}
	if tel.Headers["user-agent"] != "claude-code/2.1.278" {
		t.Fatalf("headers=%v", tel.Headers)
	}
}

func TestHTTPProxySchemesAllowed(t *testing.T) {
	// Load validates the same defaults used by a real worker.
	for _, scheme := range []string{"http", "https"} {
		dir := t.TempDir()
		filename := filepath.Join(dir, "worker.json")
		raw := fmt.Sprintf(`{"vm_id":"fixture","socket_path":%q,"credential_path":%q,"proxy_url":%q}`, filepath.Join(dir, "worker.sock"), filepath.Join(dir, "credentials.json"), scheme+"://user:pass@proxy.invalid")
		if err := os.WriteFile(filename, []byte(raw), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := Load(filename); err != nil {
			t.Fatalf("%s: %v", scheme, err)
		}
	}
}
