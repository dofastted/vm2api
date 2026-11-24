package credential

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestStorePreservesUnknownFieldsAndRotatesGeneration(t *testing.T) {
	path := filepath.Join(t.TempDir(), "credentials.json")
	seed := map[string]any{
		"unknownTop": "keep",
		"claudeAiOauth": map[string]any{
			"accessToken":   "old-access",
			"refreshToken":  "old-refresh",
			"expiresAt":     time.Now().Add(time.Hour).UnixMilli(),
			"unknownOAuth":  "keep-too",
			"kinGeneration": float64(10),
		},
	}
	data, _ := json.Marshal(seed)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	store := NewStore(path)
	current, document, err := store.Load()
	if err != nil {
		t.Fatal(err)
	}
	current.AccessToken = "new-access"
	current.RefreshToken = "new-refresh"
	saved, err := store.Save(current, document)
	if err != nil {
		t.Fatal(err)
	}
	if saved.Generation <= 10 {
		t.Fatalf("generation = %d, want > 10", saved.Generation)
	}
	_, decoded, err := store.Load()
	if err != nil {
		t.Fatal(err)
	}
	if decoded["unknownTop"] != "keep" {
		t.Fatalf("unknown top-level field was lost: %#v", decoded)
	}
	oauth := decoded["claudeAiOauth"].(map[string]any)
	if oauth["unknownOAuth"] != "keep-too" {
		t.Fatalf("unknown OAuth field was lost: %#v", oauth)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("credential mode = %o, want 600", info.Mode().Perm())
	}
}

func TestStoreLockSerializesWriters(t *testing.T) {
	path := filepath.Join(t.TempDir(), "credentials.json")
	if err := os.WriteFile(path, []byte(`{"claudeAiOauth":{"accessToken":"a","refreshToken":"r","expiresAt":1}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	store := NewStore(path)
	var (
		mu      sync.Mutex
		active  int
		maxSeen int
	)
	run := func() error {
		return store.WithLock(context.Background(), func() error {
			mu.Lock()
			active++
			if active > maxSeen {
				maxSeen = active
			}
			mu.Unlock()
			time.Sleep(20 * time.Millisecond)
			mu.Lock()
			active--
			mu.Unlock()
			return nil
		})
	}
	var wg sync.WaitGroup
	for i := 0; i < 5; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := run(); err != nil {
				t.Errorf("WithLock: %v", err)
			}
		}()
	}
	wg.Wait()
	if maxSeen != 1 {
		t.Fatalf("max concurrent lock holders = %d, want 1", maxSeen)
	}
}

func TestAPIKeyNeverNeedsRefresh(t *testing.T) {
	cred := Credential{Type: TypeAPIKey, APIKey: "sk-ant-api03-test"}
	if !cred.Valid() {
		t.Fatal("api key should be valid")
	}
	if cred.NeedsRefresh(time.Now(), time.Hour) {
		t.Fatal("api key must not refresh")
	}
}

func TestSetupTokenWithoutRefreshNeverNeedsRefresh(t *testing.T) {
	cred := Credential{Type: TypeOfficialSetupToken, AccessToken: "sk-ant-oat01-live"}
	if cred.NeedsRefresh(time.Now(), time.Hour) {
		t.Fatal("official setup-token without refresh must not refresh")
	}
	cred.ExpiresAt = time.Now().Add(24 * time.Hour).UnixMilli()
	if cred.NeedsRefresh(time.Now(), time.Hour) {
		t.Fatal("unexpired setup-token must not refresh")
	}
}

func TestSaveSetupTokenClearsRefresh(t *testing.T) {
	path := filepath.Join(t.TempDir(), "credentials.json")
	if err := os.WriteFile(path, []byte(`{"type":"oauth","claudeAiOauth":{"accessToken":"old","refreshToken":"old-rt","expiresAt":1}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	store := NewStore(path)
	current, document, err := store.Load()
	if err != nil {
		t.Fatal(err)
	}
	current.Type = TypeOfficialSetupToken
	current.AccessToken = "sk-ant-oat01-setup"
	current.RefreshToken = ""
	current.ExpiresAt = time.Now().Add(365 * 24 * time.Hour).UnixMilli()
	current.Scopes = []string{"user:inference"}
	saved, err := store.Save(current, document)
	if err != nil {
		t.Fatal(err)
	}
	if saved.RefreshToken != "" {
		t.Fatalf("saved refresh = %q, want empty", saved.RefreshToken)
	}
	loaded, document, err := store.Load()
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Type != TypeOfficialSetupToken || loaded.RefreshToken != "" {
		t.Fatalf("loaded = %#v", loaded)
	}
	oauth := nestedMap(document, "claudeAiOauth")
	if _, ok := oauth["refreshToken"]; ok {
		t.Fatalf("refreshToken should be deleted: %#v", oauth)
	}
}

func TestFullScopeSetupTokenLabelPreservesExplicitType(t *testing.T) {
	path := filepath.Join(t.TempDir(), "credentials.json")
	seed := `{"type":"setup-token","claudeAiOauth":{"accessToken":"full","refreshToken":"refresh","scopes":["user:profile","user:inference","user:sessions:claude_code"]}}`
	if err := os.WriteFile(path, []byte(seed), 0o600); err != nil {
		t.Fatal(err)
	}
	loaded, _, err := NewStore(path).Load()
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Type != TypeSetupToken || loaded.RefreshToken != "refresh" {
		t.Fatalf("loaded = %#v, want setup-token with refresh", loaded)
	}
}

func TestStoreRoundTripAPIKey(t *testing.T) {
	path := filepath.Join(t.TempDir(), "credentials.json")
	store := NewStore(path)
	saved, err := store.Save(Credential{
		Type:    TypeAPIKey,
		APIKey:  "sk-ant-api03-live",
		BaseURL: "https://api.anthropic.com",
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !saved.IsAPIKey() || saved.Token() != "sk-ant-api03-live" {
		t.Fatalf("saved = %#v", saved)
	}
	loaded, document, err := store.Load()
	if err != nil {
		t.Fatal(err)
	}
	if !loaded.IsAPIKey() || loaded.Token() != "sk-ant-api03-live" {
		t.Fatalf("loaded = %#v", loaded)
	}
	if _, ok := document["claudeAiOauth"]; ok {
		t.Fatal("api key document still has claudeAiOauth")
	}
}

func TestStoreRoundTripAuthScheme(t *testing.T) {
	path := filepath.Join(t.TempDir(), "credentials.json")
	store := NewStore(path)
	if _, err := store.Save(Credential{
		Type:       TypeAPIKey,
		APIKey:     "sk-ant-api03-live",
		AuthScheme: AuthSchemeBearer,
	}, nil); err != nil {
		t.Fatal(err)
	}
	loaded, _, err := store.Load()
	if err != nil {
		t.Fatal(err)
	}
	if loaded.ResolvedAuthScheme() != AuthSchemeBearer {
		t.Fatalf("scheme = %q", loaded.AuthScheme)
	}
}

func TestDecodeImportAPIKey(t *testing.T) {
	cred, err := DecodeImport(strings.NewReader(`{"type":"apikey","api_key":"sk-ant-api03-imported","email":"hidden@example.com"}`), 4096)
	if err != nil {
		t.Fatal(err)
	}
	if !cred.IsAPIKey() || cred.Token() != "sk-ant-api03-imported" {
		t.Fatalf("decoded = %#v", cred)
	}
	if cred.Email != "" {
		t.Fatalf("email should be ignored on import, got %q", cred.Email)
	}
}

func TestStoreSaveExcludesAndStripsEmail(t *testing.T) {
	path := filepath.Join(t.TempDir(), "credentials.json")
	seed := `{
		"email": "top@example.com",
		"emailAddress": "top-addr@example.com",
		"email_address": "top-snake@example.com",
		"claudeAiOauth": {
			"accessToken": "old-access",
			"refreshToken": "old-refresh",
			"expiresAt": 1900000000000,
			"email": "oauth@example.com",
			"emailAddress": "oauth-addr@example.com",
			"email_address": "oauth-snake@example.com",
			"accountUuid": "acct-1",
			"orgUuid": "org-1"
		}
	}`
	if err := os.WriteFile(path, []byte(seed), 0o600); err != nil {
		t.Fatal(err)
	}
	store := NewStore(path)
	current, document, err := store.Load()
	if err != nil {
		t.Fatal(err)
	}
	if current.Email != "" {
		t.Fatalf("load should not expose email, got %q", current.Email)
	}
	current.AccessToken = "new-access"
	current.Email = "should-not-write@example.com"
	if _, err := store.Save(current, document); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	text := string(raw)
	for _, forbidden := range []string{"example.com", `"email"`, "emailAddress", "email_address"} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("saved OAuth credentials still contain %s: %s", forbidden, text)
		}
	}

	apiSeed := map[string]any{
		"email": "api-top@example.com",
		"anthropicApiKey": map[string]any{
			"apiKey":        "sk-ant-api03-old",
			"email":         "api@example.com",
			"emailAddress":  "api-addr@example.com",
			"email_address": "api-snake@example.com",
		},
	}
	if _, err := store.Save(Credential{
		Type:   TypeAPIKey,
		APIKey: "sk-ant-api03-new",
		Email:  "should-not-write@example.com",
	}, apiSeed); err != nil {
		t.Fatal(err)
	}
	rawAPI, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	apiText := string(rawAPI)
	for _, forbidden := range []string{"example.com", `"email"`, "emailAddress", "email_address"} {
		if strings.Contains(apiText, forbidden) {
			t.Fatalf("saved API key credentials still contain %s: %s", forbidden, apiText)
		}
	}
}
