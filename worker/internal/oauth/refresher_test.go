package oauth

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dofastted/kin-gateway/worker/internal/credential"
)

func TestEnsureDeduplicatesConcurrentRefresh(t *testing.T) {
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		calls.Add(1)
		time.Sleep(30 * time.Millisecond)
		var body map[string]string
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Errorf("decode refresh body: %v", err)
		}
		if body["refresh_token"] != "refresh-1" || body["grant_type"] != "refresh_token" {
			t.Errorf("unexpected refresh body: %#v", body)
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"access_token":"access-2","refresh_token":"refresh-2","expires_in":28800,"scope":"user:inference"}`))
	}))
	defer upstream.Close()

	store := credential.NewStore(filepath.Join(t.TempDir(), "credentials.json"))
	if _, err := store.Save(credential.Credential{
		AccessToken:  "access-1",
		RefreshToken: "refresh-1",
		ExpiresAt:    time.Now().Add(-time.Minute).UnixMilli(),
	}, nil); err != nil {
		t.Fatal(err)
	}
	var attempts []Attempt
	refresher := &Refresher{
		Store:     store,
		Client:    upstream.Client(),
		TokenURL:  upstream.URL,
		Skew:      5 * time.Minute,
		MaxTries:  1,
		OnAttempt: func(attempt Attempt) { attempts = append(attempts, attempt) },
	}
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			result, err := refresher.Ensure(context.Background(), false)
			if err != nil {
				t.Errorf("Ensure: %v", err)
				return
			}
			if result.Credential.AccessToken != "access-2" {
				t.Errorf("access token = %q", result.Credential.AccessToken)
			}
		}()
	}
	wg.Wait()
	if calls.Load() != 1 {
		t.Fatalf("refresh calls = %d, want 1", calls.Load())
	}
	if len(attempts) != 2 || attempts[0].Phase != "start" || attempts[1].Phase != "success" ||
		attempts[0].AttemptID == "" || attempts[0].AttemptID != attempts[1].AttemptID {
		t.Fatalf("actual refresh notifications = %#v", attempts)
	}
	if _, err := refresher.Ensure(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	if len(attempts) != 2 || calls.Load() != 1 {
		t.Fatalf("cached credential produced a refresh notification or network request")
	}
	current, err := store.Status()
	if err != nil {
		t.Fatal(err)
	}
	if current.RefreshToken != "refresh-2" || current.AccessToken != "access-2" {
		t.Fatalf("stored credential = %#v", current)
	}
}

func TestEnsurePreservesSetupTokenTypeAndFullScopes(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"access_token":"access-2","refresh_token":"refresh-2","expires_in":28800,"scope":"user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload"}`))
	}))
	defer upstream.Close()

	store := credential.NewStore(filepath.Join(t.TempDir(), "credentials.json"))
	if _, err := store.Save(credential.Credential{
		Type:         credential.TypeSetupToken,
		AccessToken:  "access-1",
		RefreshToken: "refresh-1",
		ExpiresAt:    time.Now().Add(-time.Minute).UnixMilli(),
		Scopes: []string{
			"user:profile",
			"user:inference",
			"user:sessions:claude_code",
			"user:mcp_servers",
			"user:file_upload",
		},
	}, nil); err != nil {
		t.Fatal(err)
	}
	refresher := &Refresher{Store: store, Client: upstream.Client(), TokenURL: upstream.URL, MaxTries: 1}
	if _, err := refresher.Ensure(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	current, err := store.Status()
	if err != nil {
		t.Fatal(err)
	}
	if current.Type != credential.TypeSetupToken || current.RefreshToken != "refresh-2" {
		t.Fatalf("stored credential = %#v, want setup-token with rotated refresh", current)
	}
	if got := strings.Join(current.Scopes, " "); got != "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload" {
		t.Fatalf("scopes = %q", got)
	}
}

func TestEnsureDoesNotPersistAfterCancellation(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		time.Sleep(100 * time.Millisecond)
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"access_token":"too-late","refresh_token":"too-late","expires_in":28800}`))
	}))
	defer upstream.Close()
	store := credential.NewStore(filepath.Join(t.TempDir(), "credentials.json"))
	original, err := store.Save(credential.Credential{
		AccessToken:  "access-old",
		RefreshToken: "refresh-old",
		ExpiresAt:    time.Now().Add(-time.Minute).UnixMilli(),
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	refresher := &Refresher{Store: store, Client: upstream.Client(), TokenURL: upstream.URL, MaxTries: 1}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err = refresher.Ensure(ctx, true); err == nil {
		t.Fatal("expected cancellation error")
	}
	current, err := store.Status()
	if err != nil {
		t.Fatal(err)
	}
	if current.Generation != original.Generation || current.AccessToken != original.AccessToken {
		t.Fatalf("credential changed after cancellation: before=%#v after=%#v", original, current)
	}
}

func TestEnsureStripsLegacyEmailOnRefresh(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"access_token":"access-new","refresh_token":"refresh-new","expires_in":28800}`))
	}))
	defer upstream.Close()
	credPath := filepath.Join(t.TempDir(), "credentials.json")
	seed := `{"email":"top@example.com","claudeAiOauth":{"accessToken":"access-old","refreshToken":"refresh-old","expiresAt":1,"email":"legacy@example.com","accountUuid":"acct-1","orgUuid":"org-1"}}`
	if err := os.WriteFile(credPath, []byte(seed), 0o600); err != nil {
		t.Fatal(err)
	}
	store := credential.NewStore(credPath)
	refresher := &Refresher{Store: store, Client: upstream.Client(), TokenURL: upstream.URL, MaxTries: 1}
	result, err := refresher.Ensure(context.Background(), true)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Refreshed || result.Credential.AccessToken != "access-new" || result.Credential.Email != "" {
		t.Fatalf("unexpected refresh result: %#v", result)
	}
	raw, err := os.ReadFile(credPath)
	if err != nil {
		t.Fatal(err)
	}
	text := string(raw)
	if strings.Contains(text, "example.com") || strings.Contains(text, `"email"`) {
		t.Fatalf("refreshed credentials still contain email: %s", text)
	}
}
