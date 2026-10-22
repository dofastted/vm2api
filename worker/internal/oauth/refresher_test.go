package oauth

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dofastted/kin-gateway/worker/internal/credential"
)

func TestRefreshNeverRetriesAnAcceptedUnknownAttempt(t *testing.T) {
	for _, headers := range []bool{false, true} {
		t.Run(fmt.Sprintf("response_headers_%v", headers), func(t *testing.T) {
			var calls atomic.Int32
			upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				_, _ = io.Copy(io.Discard, request.Body)
				if calls.Add(1) > 1 {
					writer.WriteHeader(http.StatusBadRequest)
					_, _ = writer.Write([]byte(`{"error":"invalid_grant"}`))
					return
				}
				conn, buffered, err := writer.(http.Hijacker).Hijack()
				if err != nil {
					t.Error(err)
					return
				}
				if headers {
					_, _ = buffered.WriteString("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 500\r\n\r\n{\"access_token\":\"synthetic-lost")
					_ = buffered.Flush()
				}
				_ = conn.Close()
			}))
			defer upstream.Close()
			store := credential.NewStore(filepath.Join(t.TempDir(), "credentials.json"))
			original, err := store.Save(credential.Credential{AccessToken: "synthetic-old-at", RefreshToken: "synthetic-old-rt", ExpiresAt: 1}, nil)
			if err != nil {
				t.Fatal(err)
			}
			refresher := &Refresher{Store: store, Client: upstream.Client(), TokenURL: upstream.URL, MaxTries: 3}
			if _, err = refresher.Ensure(context.Background(), true); err == nil {
				t.Fatal("accepted truncated refresh must remain unknown")
			}
			if calls.Load() != 1 {
				t.Fatalf("refresh calls = %d, want 1 after accepted unknown attempt", calls.Load())
			}
			current, err := store.Status()
			if err != nil {
				t.Fatal(err)
			}
			if current.RefreshToken != original.RefreshToken || current.Generation != original.Generation {
				t.Fatal("unknown refresh changed stored credential")
			}
		})
	}
}

func TestRefreshMayRetryADefinitivelyCompleteRejection(t *testing.T) {
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		if calls.Add(1) == 1 {
			writer.WriteHeader(http.StatusServiceUnavailable)
			_, _ = writer.Write([]byte(`{"error":"temporarily_unavailable"}`))
			return
		}
		_, _ = writer.Write([]byte(`{"access_token":"synthetic-new-at"}`))
	}))
	defer upstream.Close()
	store := credential.NewStore(filepath.Join(t.TempDir(), "credentials.json"))
	if _, err := store.Save(credential.Credential{AccessToken: "synthetic-old-at", RefreshToken: "synthetic-old-rt", ExpiresAt: 1}, nil); err != nil {
		t.Fatal(err)
	}
	refresher := &Refresher{Store: store, Client: upstream.Client(), TokenURL: upstream.URL, MaxTries: 2}
	if _, err := refresher.Ensure(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 2 {
		t.Fatalf("refresh calls = %d, want 2 after complete rejection", calls.Load())
	}
	current, err := store.Status()
	if err != nil {
		t.Fatal(err)
	}
	if current.RefreshToken != "synthetic-old-rt" {
		t.Fatal("an access-only response must retain the existing refresh token")
	}
}

func TestUnknownRefreshCannotBecomeSuccessFromNewFileObservation(t *testing.T) {
	store := credential.NewStore(filepath.Join(t.TempDir(), "credentials.json"))
	original, err := store.Save(credential.Credential{AccessToken: "synthetic-old-at", RefreshToken: "synthetic-old-rt", ExpiresAt: 1}, nil)
	if err != nil {
		t.Fatal(err)
	}
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if _, err := store.Save(credential.Credential{AccessToken: "synthetic-observed-at", RefreshToken: "synthetic-observed-rt", ExpiresAt: time.Now().Add(time.Hour).UnixMilli(), Generation: original.Generation + 1}, nil); err != nil {
			t.Error(err)
		}
		conn, buffered, err := writer.(http.Hijacker).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		_, _ = buffered.WriteString("HTTP/1.1 200 OK\r\nContent-Length: 500\r\n\r\n{\"access_token\":\"synthetic-lost")
		_ = buffered.Flush()
		_ = conn.Close()
	}))
	defer upstream.Close()
	refresher := &Refresher{Store: store, Client: upstream.Client(), TokenURL: upstream.URL, MaxTries: 1}
	if _, err = refresher.Ensure(context.Background(), true); err == nil {
		t.Fatal("later credential observation replaced an unknown refresh result with success")
	}
}

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
	refresher := &Refresher{
		Store:    store,
		Client:   upstream.Client(),
		TokenURL: upstream.URL,
		Skew:     5 * time.Minute,
		MaxTries: 1,
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
