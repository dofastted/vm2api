package oauth

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/dofastted/kin-gateway/worker/internal/credential"
)

const DefaultClientID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"

type Refresher struct {
	Store     *credential.Store
	Client    *http.Client
	TokenURL  string
	ClientID  string
	Skew      time.Duration
	MaxTries  int
	mu        sync.Mutex
	inFlight  chan struct{}
	last      Result
	lastError error
}

type Result struct {
	Credential credential.Credential
	Refreshed  bool
	Shared     bool
}

type tokenResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int64  `json:"expires_in"`
	Scope        string `json:"scope"`
	Error        string `json:"error"`
	Description  string `json:"error_description"`
}

type RefreshError struct {
	Status    int
	Code      string
	Message   string
	Retryable bool
	Unknown   bool
	Cause     error
}

func (e *RefreshError) Unwrap() error { return e.Cause }

func IsRefreshUnknown(err error) bool {
	var refreshErr *RefreshError
	return errors.As(err, &refreshErr) && refreshErr.Unknown
}

func unknownRefresh(status int, cause error) *RefreshError {
	return &RefreshError{Status: status, Code: "refresh_outcome_unknown", Message: "OAuth refresh outcome is unknown", Unknown: true, Cause: cause}
}

func (e *RefreshError) Error() string {
	if e == nil {
		return ""
	}
	if e.Code != "" {
		return fmt.Sprintf("OAuth refresh failed (%s): %s", e.Code, e.Message)
	}
	return fmt.Sprintf("OAuth refresh failed (HTTP %d): %s", e.Status, e.Message)
}

// Ensure is the only refresh manager. Inference and the panel both call this.
// There is no background ticker. force is reserved for an explicit operator retry.
func (r *Refresher) Ensure(ctx context.Context, force bool) (Result, error) {
	r.mu.Lock()
	if current := r.inFlight; current != nil {
		r.mu.Unlock()
		select {
		case <-ctx.Done():
			return Result{}, ctx.Err()
		case <-current:
			r.mu.Lock()
			result := r.last
			err := r.lastError
			r.mu.Unlock()
			result.Shared = true
			return result, err
		}
	}
	r.inFlight = make(chan struct{})
	done := r.inFlight
	r.mu.Unlock()

	result, err := r.ensureLocked(ctx, force)
	r.mu.Lock()
	r.last = result
	r.lastError = err
	r.inFlight = nil
	close(done)
	r.mu.Unlock()
	return result, err
}

func (r *Refresher) ensureLocked(ctx context.Context, force bool) (Result, error) {
	if r.Store == nil {
		return Result{}, errors.New("credential store is not configured")
	}
	if r.Client == nil {
		return Result{}, errors.New("OAuth HTTP client is not configured")
	}
	var result Result
	err := r.Store.WithLock(ctx, func() error {
		current, document, loadErr := r.Store.Load()
		if loadErr != nil {
			return loadErr
		}
		if current.IsAPIKey() {
			if !current.Valid() {
				return &RefreshError{Code: "api_key_missing", Message: "console API key is missing"}
			}
			result.Credential = current
			return nil
		}
		if !force && !current.NeedsRefresh(time.Now(), r.refreshSkew()) {
			result.Credential = current
			return nil
		}
		if strings.TrimSpace(current.RefreshToken) == "" {
			return &RefreshError{Code: "refresh_token_missing", Message: "credential has no refresh token"}
		}
		refreshed, refreshErr := r.requestWithRetry(ctx, current)
		if refreshErr != nil {
			// Neither cancellation nor a later file observation proves what this
			// accepted request did to the rotating refresh token.
			if IsRefreshUnknown(refreshErr) {
				return refreshErr
			}
			if ctx.Err() != nil {
				return ctx.Err()
			}
			latest, _, latestErr := r.Store.Load()
			if latestErr == nil && latest.Generation != current.Generation && !latest.NeedsRefresh(time.Now(), r.refreshSkew()) {
				result.Credential = latest
				result.Shared = true
				return nil
			}
			return refreshErr
		}
		if ctx.Err() != nil {
			return unknownRefresh(0, ctx.Err())
		}
		refreshed.Generation = current.Generation
		saved, saveErr := r.Store.Save(refreshed, document)
		if saveErr != nil {
			return unknownRefresh(0, saveErr)
		}
		result.Credential = saved
		result.Refreshed = true
		return nil
	})
	return result, err
}

func (r *Refresher) requestWithRetry(ctx context.Context, current credential.Credential) (credential.Credential, error) {
	tries := r.MaxTries
	if tries <= 0 {
		tries = 3
	}
	var lastErr error
	for attempt := 0; attempt < tries; attempt++ {
		if attempt > 0 {
			delay := time.Duration(300*(1<<(attempt-1))) * time.Millisecond
			delay += time.Duration(rand.Intn(151)) * time.Millisecond
			timer := time.NewTimer(delay)
			select {
			case <-ctx.Done():
				timer.Stop()
				return credential.Credential{}, ctx.Err()
			case <-timer.C:
			}
		}
		next, err := r.request(ctx, current)
		if err == nil {
			return next, nil
		}
		lastErr = err
		var refreshErr *RefreshError
		// Retry only a fully read, explicit provider rejection. Replaying a
		// transport-unknown request can consume the same rotating token twice.
		if !errors.As(err, &refreshErr) || refreshErr.Unknown || !refreshErr.Retryable {
			break
		}
	}
	return credential.Credential{}, lastErr
}

func (r *Refresher) request(ctx context.Context, current credential.Credential) (credential.Credential, error) {
	payload := map[string]string{
		"grant_type":    "refresh_token",
		"refresh_token": current.RefreshToken,
		"client_id":     r.clientID(),
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return credential.Credential{}, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, r.TokenURL, bytes.NewReader(body))
	if err != nil {
		return credential.Credential{}, fmt.Errorf("build OAuth refresh request: %w", err)
	}
	request.Header.Set("Accept", "application/json, text/plain, */*")
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("User-Agent", "axios/1.13.6")
	response, err := r.Client.Do(request)
	if err != nil {
		return credential.Credential{}, unknownRefresh(0, err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, (1<<20)+1))
	if err != nil {
		return credential.Credential{}, unknownRefresh(response.StatusCode, err)
	}
	if len(data) > 1<<20 {
		return credential.Credential{}, unknownRefresh(response.StatusCode, errors.New("OAuth refresh response exceeds limit"))
	}
	var decoded tokenResponse
	decodeErr := json.Unmarshal(data, &decoded)
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		code := strings.TrimSpace(decoded.Error)
		message := strings.TrimSpace(decoded.Description)
		if message == "" {
			message = strings.TrimSpace(string(data))
		}
		if len(message) > 300 {
			message = message[:300]
		}
		retryable := response.StatusCode == http.StatusTooManyRequests || response.StatusCode >= 500
		if code == "invalid_grant" || code == "invalid_refresh_token" || response.StatusCode == http.StatusBadRequest {
			retryable = false
		}
		return credential.Credential{}, &RefreshError{
			Status:    response.StatusCode,
			Code:      code,
			Message:   message,
			Retryable: retryable,
		}
	}
	if decodeErr != nil {
		return credential.Credential{}, unknownRefresh(response.StatusCode, decodeErr)
	}
	if strings.TrimSpace(decoded.AccessToken) == "" {
		return credential.Credential{}, &RefreshError{Status: response.StatusCode, Code: "missing_access_token", Message: "refresh response has no access_token", Unknown: true}
	}
	refreshToken := strings.TrimSpace(decoded.RefreshToken)
	if refreshToken == "" {
		refreshToken = current.RefreshToken
	}
	expiresAt := time.Now().Add(time.Duration(decoded.ExpiresIn) * time.Second).UnixMilli()
	if decoded.ExpiresIn <= 0 {
		expiresAt = time.Now().Add(8 * time.Hour).UnixMilli()
	}
	scopes := current.Scopes
	if decoded.Scope != "" {
		scopes = strings.Fields(decoded.Scope)
	}
	return credential.Credential{
		Type:         current.Type,
		AccessToken:  strings.TrimSpace(decoded.AccessToken),
		RefreshToken: refreshToken,
		ExpiresAt:    expiresAt,
		Generation:   current.Generation,
		Email:        current.Email,
		AccountUUID:  current.AccountUUID,
		OrgUUID:      current.OrgUUID,
		Scopes:       scopes,
		AuthScheme:   current.AuthScheme,
	}, nil
}

func (r *Refresher) refreshSkew() time.Duration {
	if r.Skew <= 0 {
		return 5 * time.Minute
	}
	return r.Skew
}

func (r *Refresher) clientID() string {
	if strings.TrimSpace(r.ClientID) == "" {
		return DefaultClientID
	}
	return strings.TrimSpace(r.ClientID)
}
