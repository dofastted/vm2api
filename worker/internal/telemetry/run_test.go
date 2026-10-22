package telemetry

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dofastted/kin-gateway/worker/internal/config"
	"github.com/dofastted/kin-gateway/worker/internal/credential"
)

func saveCred(t *testing.T, dir string, cred credential.Credential) *credential.Store {
	t.Helper()
	store := credential.NewStore(filepath.Join(dir, "credentials.json"))
	if _, err := store.Save(cred, nil); err != nil {
		t.Fatal(err)
	}
	return store
}

func TestRunDisabledDoesNotPost(t *testing.T) {
	var hits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	base, _ := url.Parse(server.URL)
	store := saveCred(t, t.TempDir(), credential.Credential{
		AccessToken: "tok",
		ExpiresAt:   time.Now().Add(time.Hour).UnixMilli(),
	})
	err := Run(context.Background(), config.Config{}, Deps{
		HTTP:  &Client{HTTP: server.Client(), AnthropicBase: base, Timeout: time.Second},
		Store: store,
		Now:   time.Now,
	})
	if err != nil {
		t.Fatal(err)
	}
	if hits.Load() != 0 {
		t.Fatalf("disabled sidecar posted %d times", hits.Load())
	}
}

func TestRunExpiredTokenSkipsPost(t *testing.T) {
	var hits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	base, _ := url.Parse(server.URL)
	store := saveCred(t, t.TempDir(), credential.Credential{
		AccessToken: "tok",
		ExpiresAt:   time.Now().Add(-time.Hour).UnixMilli(),
	})
	err := Run(context.Background(), config.Config{Telemetry: config.TelemetryConfig{Enabled: true}}, Deps{
		HTTP:  &Client{HTTP: server.Client(), AnthropicBase: base, Timeout: time.Second},
		Store: store,
		Now:   time.Now,
		Sleep: func(context.Context, time.Duration) bool { return false },
	})
	if err != nil {
		t.Fatal(err)
	}
	if hits.Load() != 0 {
		t.Fatalf("expired token posted %d times", hits.Load())
	}
}

func TestRun4xxDoesNotSurface(t *testing.T) {
	var hits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if r.URL.Path != batchPath {
			t.Fatalf("path=%q", r.URL.Path)
		}
		w.WriteHeader(http.StatusForbidden)
	}))
	defer server.Close()
	base, _ := url.Parse(server.URL)
	store := saveCred(t, t.TempDir(), credential.Credential{
		AccessToken: "tok",
		ExpiresAt:   time.Now().Add(time.Hour).UnixMilli(),
	})
	err := Run(context.Background(), config.Config{
		Telemetry: config.TelemetryConfig{Enabled: true, Identity: Identity{DeviceID: "d"}},
	}, Deps{
		HTTP:  &Client{HTTP: server.Client(), AnthropicBase: base, Timeout: time.Second},
		Store: store,
		Now:   time.Now,
		Sleep: func(context.Context, time.Duration) bool { return false },
	})
	if err != nil {
		t.Fatal(err)
	}
	if hits.Load() != 1 {
		t.Fatalf("hits=%d", hits.Load())
	}
}

func TestRunPostsInitSuccessAndEval(t *testing.T) {
	var hits atomic.Int32
	var batches, evals atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		switch r.URL.Path {
		case batchPath:
			batches.Add(1)
		case evalPath:
			evals.Add(1)
		default:
			t.Fatalf("path=%q", r.URL.Path)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	base, _ := url.Parse(server.URL)
	store := saveCred(t, t.TempDir(), credential.Credential{
		AccessToken: "tok",
		ExpiresAt:   time.Now().Add(time.Hour).UnixMilli(),
		Email:       "slot@example.com",
	})
	err := Run(context.Background(), config.Config{
		Telemetry: config.TelemetryConfig{Enabled: true, Identity: Identity{DeviceID: "d", Platform: "linux"}},
	}, Deps{
		HTTP:  &Client{HTTP: server.Client(), AnthropicBase: base, Timeout: time.Second},
		Store: store,
		Now:   time.Now,
		Sleep: func(context.Context, time.Duration) bool { return false },
	})
	if err != nil {
		t.Fatal(err)
	}
	if batches.Load() < 2 || evals.Load() != 1 {
		t.Fatalf("hits=%d batches=%d evals=%d", hits.Load(), batches.Load(), evals.Load())
	}
}

func TestRunReloadsTelemetryWithoutRestart(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "worker.json")
	stamp := time.Now()
	id1 := strings.Repeat("ab", 32)
	id2 := strings.Repeat("cd", 32)
	write := func(enabled bool, device string) {
		cpu := "CPU-" + device[:2]
		raw := fmt.Sprintf(`{"telemetry":{"enabled":%t,"betas":"thinking-binding-controls-2026-08-01","identity":{"user_id":%q,"platform":"linux","cli_version":"2.1.278","env":{"version":"2.1.278","platform":"linux","shell":"zsh","cpu_model":%q,"cpu_cores":8,"memory_bytes":8589934592}}}}`, enabled, device, cpu)
		if err := os.WriteFile(path, []byte(raw), 0o600); err != nil {
			t.Fatal(err)
		}
		stamp = stamp.Add(time.Second)
		if err := os.Chtimes(path, stamp, stamp); err != nil {
			t.Fatal(err)
		}
	}
	write(true, id1)
	var bodies atomic.Value
	bodies.Store("")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != batchPath {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		buf, _ := io.ReadAll(r.Body)
		bodies.Store(bodies.Load().(string) + string(buf) + "\n")
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	base, _ := url.Parse(server.URL)
	store := saveCred(t, dir, credential.Credential{
		AccessToken: "tok",
		ExpiresAt:   time.Now().Add(time.Hour).UnixMilli(),
	})
	ticks := 0
	err := Run(context.Background(), config.Config{
		ConfigPath: path,
		Telemetry:  config.TelemetryConfig{Enabled: false},
	}, Deps{
		HTTP:  &Client{HTTP: server.Client(), AnthropicBase: base, Timeout: time.Second},
		Store: store,
		Now:   time.Now,
		Sleep: func(context.Context, time.Duration) bool {
			ticks++
			if ticks == 1 {
				write(true, id2)
				return true
			}
			return false
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	got := bodies.Load().(string)
	if !strings.Contains(got, id2) || !strings.Contains(got, `"shell":"zsh"`) {
		t.Fatalf("reloaded body missing new identity: %s", got)
	}
	if strings.Contains(got, "thinking-binding-controls-2026-08-01") {
		t.Fatalf("betas were uploaded: %s", got)
	}
	if strings.Contains(got, "2.1.241") {
		t.Fatalf("stale version in %s", got)
	}
	if strings.Contains(got, `"cpu_model"`) || strings.Contains(got, `"memory_bytes"`) {
		t.Fatalf("guest hardware was uploaded: %s", got)
	}
}

func TestUploadLogKeepsFortyLinesAndDropsIdentity(t *testing.T) {
	dir := t.TempDir()
	cfg := config.Config{ConfigPath: filepath.Join(dir, "worker.json")}
	payload := Event{EventType: "ClaudeCodeInternalEvent", EventData: map[string]any{
		"event_name": "tengu_init",
		"email":      "person@example.com",
		"device_id":  "abc",
		"auth":       map[string]any{"account_uuid": "acct", "organization_uuid": "org"},
		"env":        map[string]any{"platform": "linux"},
	}}
	for range 45 {
		recordUpload(cfg, "batch", "tengu_init", nil, BatchRequest{Events: []Event{payload}})
	}
	raw, err := os.ReadFile(filepath.Join(dir, "telemetry-upload.log"))
	if err != nil {
		t.Fatal(err)
	}
	text := string(raw)
	lines := strings.Split(strings.TrimRight(text, "\n"), "\n")
	if len(lines) != uploadLogLines {
		t.Fatalf("lines=%d", len(lines))
	}
	for _, secret := range []string{"person@example.com", "account_uuid", "organization_uuid", "device_id"} {
		if strings.Contains(text, secret) {
			t.Fatalf("log kept %s", secret)
		}
	}
	if !strings.Contains(text, `"events":[`) || !strings.Contains(text, `"platform":"linux"`) || !strings.Contains(text, "batch tengu_init ok") {
		t.Fatalf("log lost the upload shape: %s", text)
	}
}

func TestBatchInterval(t *testing.T) {
	tests := []struct {
		secs int
		want time.Duration
	}{
		{0, defaultBatchInterval},
		{30, defaultBatchInterval},
		{59, defaultBatchInterval},
		{60, 60 * time.Second},
		{120, 120 * time.Second},
		{86400, 24 * time.Hour},
		{86401, defaultBatchInterval},
		{100000, defaultBatchInterval},
	}
	for _, tc := range tests {
		got := batchInterval(config.TelemetryConfig{UploadIntervalSecs: tc.secs})
		if got != tc.want {
			t.Fatalf("secs=%d got %s want %s", tc.secs, got, tc.want)
		}
	}
}

func TestRunBatchCadence(t *testing.T) {
	tests := []struct {
		name string
		secs int
		wait time.Duration
	}{
		{name: "missing", wait: 10 * time.Minute},
		{name: "120s", secs: 120, wait: 120 * time.Second},
		{name: "too-small", secs: 30, wait: 10 * time.Minute},
		{name: "too-large", secs: 100000, wait: 10 * time.Minute},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var inits, successes atomic.Int32
			var at10s atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != batchPath {
					w.WriteHeader(http.StatusNoContent)
					return
				}
				buf, _ := io.ReadAll(r.Body)
				body := string(buf)
				if strings.Contains(body, `"event_name":"tengu_init"`) {
					inits.Add(1)
				}
				if strings.Contains(body, `"event_name":"tengu_api_success"`) {
					successes.Add(1)
				}
				w.WriteHeader(http.StatusNoContent)
			}))
			defer server.Close()
			base, _ := url.Parse(server.URL)
			store := saveCred(t, t.TempDir(), credential.Credential{
				AccessToken: "tok",
				ExpiresAt:   time.Now().Add(time.Hour).UnixMilli(),
			})
			clock := time.Unix(1_700_000_000, 0)
			start := clock
			err := Run(context.Background(), config.Config{
				Telemetry: config.TelemetryConfig{
					Enabled:            true,
					Identity:           Identity{DeviceID: "d"},
					UploadIntervalSecs: tc.secs,
				},
			}, Deps{
				HTTP:  &Client{HTTP: server.Client(), AnthropicBase: base, Timeout: time.Second},
				Store: store,
				Now:   func() time.Time { return clock },
				Sleep: func(_ context.Context, d time.Duration) bool {
					if clock.Sub(start) >= 10*time.Second && at10s.CompareAndSwap(0, -1) {
						at10s.Store(successes.Load())
					}
					if clock.Sub(start) >= tc.wait {
						return false
					}
					clock = clock.Add(d)
					return true
				},
			})
			if err != nil {
				t.Fatal(err)
			}
			if inits.Load() != 1 {
				t.Fatalf("inits=%d", inits.Load())
			}
			if at10s.Load() != 1 {
				t.Fatalf("successes after 10s=%d", at10s.Load())
			}
			if successes.Load() != 2 {
				t.Fatalf("successes=%d after %s", successes.Load(), tc.wait)
			}
		})
	}
}

func TestRunReloadsUploadIntervalWithoutResendingInit(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "worker.json")
	stamp := time.Now()
	write := func(secs int) {
		raw := fmt.Sprintf(`{"telemetry":{"enabled":true,"upload_interval_seconds":%d,"identity":{"device_id":"dev"}}}`, secs)
		if err := os.WriteFile(path, []byte(raw), 0o600); err != nil {
			t.Fatal(err)
		}
		stamp = stamp.Add(time.Second)
		if err := os.Chtimes(path, stamp, stamp); err != nil {
			t.Fatal(err)
		}
	}
	write(600)
	var inits, successes atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != batchPath {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		buf, _ := io.ReadAll(r.Body)
		body := string(buf)
		if strings.Contains(body, `"event_name":"tengu_init"`) {
			inits.Add(1)
		}
		if strings.Contains(body, `"event_name":"tengu_api_success"`) {
			successes.Add(1)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	base, _ := url.Parse(server.URL)
	store := saveCred(t, dir, credential.Credential{
		AccessToken: "tok",
		ExpiresAt:   time.Now().Add(time.Hour).UnixMilli(),
	})
	clock := time.Unix(1_700_000_000, 0)
	start := clock
	var afterReload int32
	err := Run(context.Background(), config.Config{
		ConfigPath: path,
		Telemetry:  config.TelemetryConfig{Enabled: false},
	}, Deps{
		HTTP:       &Client{HTTP: server.Client(), AnthropicBase: base, Timeout: time.Second},
		Store:      store,
		ConfigPath: path,
		LoadConfig: config.LoadTelemetry,
		Now:        func() time.Time { return clock },
		Sleep: func(_ context.Context, d time.Duration) bool {
			if clock.Equal(start) {
				write(60)
			}
			if clock.Sub(start) == time.Second {
				afterReload = successes.Load()
			}
			if clock.Sub(start) >= 60*time.Second {
				return false
			}
			clock = clock.Add(d)
			return true
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if inits.Load() != 1 {
		t.Fatalf("init resent: inits=%d", inits.Load())
	}
	if afterReload != 1 {
		t.Fatalf("successes=%d right after interval reload", afterReload)
	}
	if successes.Load() != 2 {
		t.Fatalf("successes=%d, interval reload did not apply", successes.Load())
	}
}
