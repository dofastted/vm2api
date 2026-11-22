package oauth

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"

	"github.com/dofastted/kin-gateway/worker/internal/credential"
)

// CodeOutcomeUnknown marks a refresh that reached the token endpoint without a usable
// answer. The refresh token may already be spent upstream, so it is never sent again.
const CodeOutcomeUnknown = "refresh_outcome_unknown"

// The journal lives next to the credential and outlives this process: a control-plane
// retry, a worker restart or a second caller all see that the last send with this exact
// refresh token never resolved. It names the token by digest only.
type attemptJournal struct {
	Token     string `json:"refresh_token_sha256"`
	AttemptID string `json:"attempt_id,omitempty"`
	StartedAt int64  `json:"started_at"`
}

func attemptJournalPath(store *credential.Store) string {
	return store.Path + ".refresh-attempt"
}

func tokenDigest(refreshToken string) string {
	sum := sha256.Sum256([]byte(refreshToken))
	return hex.EncodeToString(sum[:])
}

// pendingAttempt reports whether a send with this refresh token is unresolved. A journal
// for another token (rotated by the in-slot CLI or by re-authorization) is stale and removed.
func pendingAttempt(store *credential.Store, refreshToken string) (bool, error) {
	data, err := os.ReadFile(attemptJournalPath(store))
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	var journal attemptJournal
	if json.Unmarshal(data, &journal) != nil || journal.Token == "" {
		// Unreadable means a write was cut short: treat it as unresolved rather than guess.
		return true, nil
	}
	if journal.Token != tokenDigest(refreshToken) {
		return false, clearAttemptJournal(store)
	}
	return true, nil
}

func writeAttemptJournal(store *credential.Store, refreshToken, attemptID string) error {
	data, err := json.Marshal(attemptJournal{Token: tokenDigest(refreshToken), AttemptID: attemptID, StartedAt: time.Now().UnixMilli()})
	if err != nil {
		return err
	}
	path := attemptJournalPath(store)
	if err = os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err = file.Write(data); err == nil {
		err = file.Sync() // must be on disk before the request can leave
	}
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	return err
}

func clearAttemptJournal(store *credential.Store) error {
	err := os.Remove(attemptJournalPath(store))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}
