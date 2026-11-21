// Package codextui drives a real official `codex` TUI process inside a slot
// container over a PTY, exposing the same /internal/v1/codex/responses Unix
// socket contract as the retired HTTP-simulation kernel. Upstream-visible
// TLS, headers and request metadata are produced by the genuine codex binary.
package codextui

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"time"
)

// Config mirrors run/codex-kernel.json written by the control plane
// (writeCodexKernelConfig) plus helper-local tunables via env.
type Config struct {
	VMID           string `json:"vm_id"`
	DeviceID       string `json:"device_id"`
	SocketPath     string `json:"socket_path"`
	CredentialPath string `json:"credential_path"`
	ProxyURL       string `json:"proxy_url"`
	ProxyRequired  bool   `json:"proxy_required"`
	InternalToken  string `json:"internal_token"`
	MaxRequestByte int64  `json:"max_request_bytes"`

	// Helper-local, environment-tunable.
	CodexBin      string        `json:"-"`
	CodexHome     string        `json:"-"`
	WorkspaceRoot string        `json:"-"`
	MaxParallel   int           `json:"-"`
	ReadyTimeout  time.Duration `json:"-"`
	PasteTimeout  time.Duration `json:"-"`
	IdleTimeout   time.Duration `json:"-"`
	TurnTimeout   time.Duration `json:"-"`
}

func envStr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envInt(key string, fallback int) int {
	if v, err := strconv.Atoi(os.Getenv(key)); err == nil && v > 0 {
		return v
	}
	return fallback
}

func envMs(key string, fallback time.Duration) time.Duration {
	if v, err := strconv.Atoi(os.Getenv(key)); err == nil && v > 0 {
		return time.Duration(v) * time.Millisecond
	}
	return fallback
}

// LoadConfig reads the kernel JSON and overlays helper env knobs.
// CODEX_TUI_* vars are honored before KIN_CODEX_BIN etc.
func LoadConfig(path string) (*Config, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	cfg := &Config{}
	if err := json.Unmarshal(raw, cfg); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	runDir := filepath.Dir(path)
	cfg.CodexBin = envStr("CODEX_TUI_BIN", envStr("CODEX_BIN", "codex"))
	cfg.CodexHome = envStr("CODEX_TUI_HOME", filepath.Join(runDir, "codex-home"))
	cfg.WorkspaceRoot = envStr("CODEX_TUI_WORKSPACE", filepath.Join(runDir, "codex-work"))
	cfg.MaxParallel = envInt("CODEX_TUI_MAX_PARALLEL", 4)
	cfg.ReadyTimeout = envMs("CODEX_TUI_READY_TIMEOUT_MS", 45*time.Second)
	cfg.PasteTimeout = envMs("CODEX_TUI_PASTE_TIMEOUT_MS", 20*time.Second)
	cfg.IdleTimeout = envMs("CODEX_TUI_IDLE_TIMEOUT_MS", 180*time.Second)
	cfg.TurnTimeout = envMs("CODEX_TUI_TURN_TIMEOUT_MS", 600*time.Second)
	return cfg, nil
}
