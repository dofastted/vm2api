package codextui

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// credentials is codex-credentials.json as written by the control plane.
type credentials struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	IDToken      string `json:"id_token"`
	AccountID    string `json:"account_id"`
}

// loadCredentials tolerates both flat and {"tokens":{...}} shapes.
func loadCredentials(path string) (*credentials, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	c := &credentials{}
	if err := json.Unmarshal(raw, c); err == nil && c.AccessToken != "" {
		return c, nil
	}
	var nested struct {
		Tokens credentials `json:"tokens"`
	}
	if err := json.Unmarshal(raw, &nested); err != nil || nested.Tokens.AccessToken == "" {
		return nil, fmt.Errorf("credential file %s lacks access_token", path)
	}
	return &nested.Tokens, nil
}

// authJSON mirrors ~/.codex/auth.json produced by `codex login` (ChatGPT mode).
type authJSON struct {
	AuthMode  string `json:"auth_mode"`
	OpenAIKey any    `json:"OPENAI_API_KEY"`
	Tokens    struct {
		IDToken      string `json:"id_token"`
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		AccountID    string `json:"account_id"`
	} `json:"tokens"`
	LastRefresh string `json:"last_refresh"`
}

// ensureHome creates CODEX_HOME with the slot's auth.json and config.toml.
// auth.json is rewritten each boot so control-plane credential refresh lands;
// sessions/, history.jsonl and helper state persist across turns.
func ensureHome(cfg *Config) error {
	home := cfg.CodexHome
	if err := os.MkdirAll(home, 0o700); err != nil {
		return err
	}
	creds, err := loadCredentials(cfg.CredentialPath)
	if err != nil {
		return err
	}
	auth := authJSON{AuthMode: "chatgpt", LastRefresh: time.Now().UTC().Format(time.RFC3339)}
	auth.Tokens.IDToken = creds.IDToken
	auth.Tokens.AccessToken = creds.AccessToken
	auth.Tokens.RefreshToken = creds.RefreshToken
	auth.Tokens.AccountID = creds.AccountID
	buf, _ := json.MarshalIndent(auth, "", "  ")
	if err := os.WriteFile(filepath.Join(home, "auth.json"), buf, 0o600); err != nil {
		return err
	}
	return writeConfigToml(cfg, "")
}

// writeConfigToml writes the slot config once. Project-trust lookup walks
// ancestor paths (config/src/project_trust_tests.rs), so trusting the
// workspace root covers every per-turn child directory — no per-turn rewrite.
func writeConfigToml(cfg *Config, trustDir string) error {
	cfgPath := filepath.Join(cfg.CodexHome, "config.toml")
	base := fmt.Sprintf(`# managed by codex-tui-helper; do not edit by hand
approval_policy = "never"
sandbox_mode = "read-only"
check_for_update_on_startup = false
hide_agent_reasoning = false
notify = []

[projects.%q]
trust_level = "trusted"
`, cfg.WorkspaceRoot)
	existing, _ := os.ReadFile(cfgPath)
	if trustDir == "" || len(existing) == 0 {
		return os.WriteFile(cfgPath, []byte(base), 0o600)
	}
	// A per-turn dir is already trusted via the root entry above; only an
	// out-of-tree dir would need its own entry.
	if filepath.IsAbs(trustDir) && !strings.HasPrefix(trustDir, cfg.WorkspaceRoot) {
		entry := fmt.Sprintf("\n[projects.%q]\ntrust_level = \"trusted\"\n", trustDir)
		return os.WriteFile(cfgPath, append(existing, []byte(entry)...), 0o600)
	}
	return nil
}
