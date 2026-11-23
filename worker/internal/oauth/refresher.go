package oauth

import (
	"bytes"
	"context"
	cryptorand "crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"net/http/httptrace"
	"strings"
	"sync"
	"sync/atomic"
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
	OnAttempt func(Attempt)
}

type Attempt struct {
	Type      string `json:"type"`
	AttemptID string `json:"attempt_id"`
	Phase     string `json:"phase"`
	ErrorCode string `json:"error_code,omitempty"`
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
		pending, journalErr := pendingAttempt(r.Store, current.RefreshToken)
		if journalErr != nil {
			return &RefreshError{Code: "refresh_journal_failed", Message: "read refresh attempt journal failed", Retryable: true}
		}
		if pending {
			return &RefreshError{Code: CodeOutcomeUnknown, Message: "an earlier refresh with this token has no recorded result; re-authorize the slot"}
		}
		attemptID, idErr := newAttemptID()
		if idErr != nil {
			return idErr
		}
		if err := writeAttemptJournal(r.Store, current.RefreshToken, attemptID); err != nil {
			return &RefreshError{Code: "refresh_journal_failed", Message: "write refresh attempt journal failed", Retryable: true}
		}
		// Every exit below either resolves the attempt or leaves it on disk as unknown.
		resolved := false
		defer func() {
			if resolved {
				_ = clearAttemptJournal(r.Store)
			}
		}()
		var attemptErr error
		if r.OnAttempt != nil {
			r.OnAttempt(Attempt{Type: "oauth_attempt", AttemptID: attemptID, Phase: "start"})
			defer func() {
				phase, code := "failure", attemptErrorCode(attemptErr)
				if result.Refreshed {
					phase, code = "success", ""
				}
				r.OnAttempt(Attempt{Type: "oauth_attempt", AttemptID: attemptID, Phase: phase, ErrorCode: code})
			}()
		}
		refreshed, refreshErr := r.requestWithRetry(ctx, current)
		if refreshErr != nil {
			attemptErr = refreshErr
			unknown := isOutcomeUnknown(refreshErr)
			resolved = !unknown
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
		// From here the old token is spent upstream: losing the answer leaves the attempt unknown.
		if ctx.Err() != nil {
			attemptErr = ctx.Err()
			return ctx.Err()
		}
		refreshed.Generation = current.Generation
		saved, saveErr := r.Store.Save(refreshed, document)
		if saveErr != nil {
			attemptErr = &RefreshError{Code: CodeOutcomeUnknown, Message: "refreshed credential could not be saved"}
			return fmt.Errorf("%w: %v", attemptErr, saveErr)
		}
		resolved = true
		result.Credential = saved
		result.Refreshed = true
		return nil
	})
	return result, err
}

func newAttemptID() (string, error) {
	var id [16]byte
	if _, err := cryptorand.Read(id[:]); err != nil {
		return "", err
	}
	id[6] = (id[6] & 0x0f) | 0x40
	id[8] = (id[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", id[:4], id[4:6], id[6:8], id[8:10], id[10:]), nil
}

func isOutcomeUnknown(err error) bool {
	var refreshErr *RefreshError
	return errors.As(err, &refreshErr) && refreshErr.Code == CodeOutcomeUnknown
}

// attemptErrorCode is what the attempt event reports; only the upstream can say invalid_grant.
func attemptErrorCode(err error) string {
	var refreshErr *RefreshError
	if errors.As(err, &refreshErr) {
		switch refreshErr.Code {
		case CodeOutcomeUnknown, "invalid_grant", "invalid_refresh_token":
			return refreshErr.Code
		}
	}
	return "refresh_failed"
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
		if errors.As(err, &refreshErr) && !refreshErr.Retryable {
			break // includes an unknown outcome: the same token must not go out twice
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
	// Once the request is written the token endpoint may have rotated the token, answer or not.
	var wrote atomic.Bool
	request = request.WithContext(httptrace.WithClientTrace(request.Context(), &httptrace.ClientTrace{
		WroteRequest: func(httptrace.WroteRequestInfo) { wrote.Store(true) },
	}))
	unknown := func(message string) error {
		return &RefreshError{Code: CodeOutcomeUnknown, Message: message}
	}
	response, err := r.Client.Do(request)
	if err != nil {
		if wrote.Load() {
			return credential.Credential{}, unknown("refresh request was sent but no response arrived")
		}
		return credential.Credential{}, fmt.Errorf("OAuth refresh transport: %w", err)
	}
	defer response.Body.Close()
	success := response.StatusCode >= 200 && response.StatusCode < 300
	data, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		if success {
			return credential.Credential{}, unknown("refresh succeeded upstream but the response was cut short")
		}
		return credential.Credential{}, fmt.Errorf("read OAuth refresh response: %w", err)
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
	if decodeErr != nil || strings.TrimSpace(decoded.AccessToken) == "" {
		// A 2xx means the exchange happened; without a token in hand its result is lost.
		return credential.Credential{}, unknown("refresh response has no usable access_token")
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
