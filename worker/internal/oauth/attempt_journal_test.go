package oauth

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dofastted/kin-gateway/worker/internal/credential"
)

func expiredStore(t *testing.T, refreshToken string) *credential.Store {
	t.Helper()
	store := credential.NewStore(filepath.Join(t.TempDir(), "credentials.json"))
	if _, err := store.Save(credential.Credential{
		AccessToken:  "fixture-access",
		RefreshToken: refreshToken,
		ExpiresAt:    time.Now().Add(-time.Minute).UnixMilli(),
	}, nil); err != nil {
		t.Fatal(err)
	}
	return store
}

func journalExists(store *credential.Store) bool {
	_, err := os.Stat(attemptJournalPath(store))
	return err == nil
}

func outcomeUnknown(err error) bool {
	var refreshErr *RefreshError
	return errors.As(err, &refreshErr) && refreshErr.Code == CodeOutcomeUnknown
}

func TestTruncatedSuccessIsNeverResentWithTheSameToken(t *testing.T) {
	var posts atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		posts.Add(1)
		// The exchange completed upstream; only the success body was cut short.
		w.Header().Set("Content-Length", "80")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"access_token":`))
	}))
	defer upstream.Close()
	store := expiredStore(t, "fixture-refresh")
	refresher := &Refresher{Store: store, Client: upstream.Client(), TokenURL: upstream.URL, MaxTries: 3}

	_, err := refresher.Ensure(context.Background(), false)
	if !outcomeUnknown(err) {
		t.Fatalf("expected %s, got %v", CodeOutcomeUnknown, err)
	}
	if posts.Load() != 1 {
		t.Fatalf("a sent request with an unknown result must not be retried, got %d POSTs", posts.Load())
	}
	// A later caller (control-plane retry, restart) still must not spend the same token again.
	_, err = refresher.Ensure(context.Background(), true)
	if !outcomeUnknown(err) || posts.Load() != 1 {
		t.Fatalf("pending attempt must block re-sending: err=%v posts=%d", err, posts.Load())
	}
	if !journalExists(store) {
		t.Fatal("the unresolved attempt must stay on disk")
	}
}

func TestUnsentRequestStaysRetryable(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	_ = listener.Close() // nothing listens: the dial fails before any byte is written
	store := expiredStore(t, "fixture-refresh")
	refresher := &Refresher{Store: store, Client: &http.Client{Timeout: time.Second}, TokenURL: "http://" + address, MaxTries: 1}

	_, err = refresher.Ensure(context.Background(), false)
	if err == nil || outcomeUnknown(err) {
		t.Fatalf("a request that never left is a plain retryable failure, got %v", err)
	}
	if journalExists(store) {
		t.Fatal("an attempt known not to have been sent must not block the next one")
	}
}

func TestAuthoritativeRejectionClearsTheAttempt(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":"invalid_grant","error_description":"revoked"}`))
	}))
	defer upstream.Close()
	store := expiredStore(t, "fixture-refresh")
	refresher := &Refresher{Store: store, Client: upstream.Client(), TokenURL: upstream.URL, MaxTries: 1}

	_, err := refresher.Ensure(context.Background(), false)
	var refreshErr *RefreshError
	if !errors.As(err, &refreshErr) || refreshErr.Code != "invalid_grant" {
		t.Fatalf("expected invalid_grant, got %v", err)
	}
	if journalExists(store) {
		t.Fatal("an answered attempt is resolved")
	}
}

func TestSuccessClearsTheAttempt(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"access-2","refresh_token":"refresh-2","expires_in":28800}`))
	}))
	defer upstream.Close()
	store := expiredStore(t, "fixture-refresh")
	refresher := &Refresher{Store: store, Client: upstream.Client(), TokenURL: upstream.URL, MaxTries: 1}

	result, err := refresher.Ensure(context.Background(), false)
	if err != nil || !result.Refreshed || result.Credential.RefreshToken != "refresh-2" {
		t.Fatalf("expected refresh, got %+v %v", result, err)
	}
	if journalExists(store) {
		t.Fatal("a saved refresh is resolved")
	}
}

func TestPendingAttemptForAnotherTokenIsIgnored(t *testing.T) {
	var posts atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		posts.Add(1)
		_, _ = w.Write([]byte(`{"access_token":"access-3","refresh_token":"refresh-3","expires_in":28800}`))
	}))
	defer upstream.Close()
	store := expiredStore(t, "rotated-by-cli")
	// Left behind for a token the in-slot CLI (or a re-authorization) has since replaced.
	if err := writeAttemptJournal(store, "older-token", "fixture"); err != nil {
		t.Fatal(err)
	}
	refresher := &Refresher{Store: store, Client: upstream.Client(), TokenURL: upstream.URL, MaxTries: 1}

	if _, err := refresher.Ensure(context.Background(), false); err != nil {
		t.Fatalf("a journal for a different token must not block: %v", err)
	}
	if posts.Load() != 1 || journalExists(store) {
		t.Fatalf("expected one POST and a cleared journal, got %d", posts.Load())
	}
}

func TestCancelledAfterSendIsUnknown(t *testing.T) {
	received := make(chan struct{}, 1)
	release := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, _ *http.Request) {
		received <- struct{}{}
		<-release
	}))
	defer upstream.Close()
	defer close(release)
	store := expiredStore(t, "fixture-refresh")
	refresher := &Refresher{Store: store, Client: upstream.Client(), TokenURL: upstream.URL, MaxTries: 3}
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		<-received
		cancel()
	}()

	_, err := refresher.Ensure(ctx, false)
	if err == nil {
		t.Fatal("expected failure")
	}
	if !journalExists(store) {
		t.Fatalf("a request the server already received has no known result, got %v without a pending attempt", err)
	}
}
