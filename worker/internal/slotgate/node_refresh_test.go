package slotgate

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dofastted/kin-gateway/worker/internal/credential"
	kinoauth "github.com/dofastted/kin-gateway/worker/internal/oauth"
)

func refreshFixture(t *testing.T, handler http.Handler) (*publicationFixture, *nodeCredentialRefresher, RefreshIntent, *atomic.Int64) {
	t.Helper()
	f := publishingFixture(t)
	f.publish(t)
	state, _ := f.a.State("v")
	if _, err := f.l.LaunchManifest(context.Background(), launchIntentForTest(state, "refresh-launch"), allowNodeCommandForTest); err != nil {
		t.Fatal(err)
	}
	state, _ = f.a.State("v")
	calls := new(atomic.Int64)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); handler.ServeHTTP(w, r) }))
	t.Cleanup(provider.Close)
	r := &nodeCredentialRefresher{boot: f.l.boot, authority: f.a, root: f.root, nodeID: f.intent.NodeID, policy: f.l.policy, authorize: func(_ context.Context, _ RefreshIntent, dispatch func() error) error { return dispatch() }, newRefresher: func(store *credential.Store) *kinoauth.Refresher {
		return &kinoauth.Refresher{Store: store, Client: provider.Client(), TokenURL: provider.URL, MaxTries: 1}
	}}
	i := RefreshIntent{Action: "credential-refresh", NodeID: f.intent.NodeID, VMID: "v", AllocationID: f.intent.AllocationID, OperationID: "refresh-operation", OwnerID: "refresh-owner", CommandID: "refresh-command", AccountID: "synthetic-account", BGTaskKey: "oauth-refresh:claude:synthetic-account", BGExecutionID: "refresh-execution", BGOwnerID: "refresh-bg-owner", Epoch: "1", Fence: state.Fence, ExpectedGeneration: "1", ManifestRevision: "1", ManifestDigest: state.InitialManifest.Receipt.ManifestDigest, PresetID: initialPresetID, PolicyDigest: f.l.policy.digest(), Force: true}
	return f, r, i, calls
}

func TestNodeRefreshPersistsOneAttemptAndRejectsLateGeneration(t *testing.T) {
	f, r, i, calls := refreshFixture(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `{"access_token":"synthetic-rotated","refresh_token":"synthetic-next","expires_in":3600}`)
	}))
	receipt, err := r.Refresh(context.Background(), i)
	if err != nil || !receipt.OK || !receipt.Finished {
		t.Fatalf("refresh did not complete: %+v %v", receipt, err)
	}
	if receipt.Credential.Generation == "1" || receipt.Credential.AccountUUID != "synthetic-account" {
		t.Fatal("receipt lacks node canonical generation")
	}
	if _, err = r.Refresh(context.Background(), i); err == nil {
		t.Fatal("completed attempt was resubmitted")
	}
	late := i
	late.CommandID = "late-command"
	if _, err = r.Refresh(context.Background(), late); err == nil {
		t.Fatal("late generation reached provider")
	}
	if calls.Load() != 1 {
		t.Fatalf("provider requests=%d want 1", calls.Load())
	}
	state, _ := f.a.State("v")
	if _, err = f.a.readCanonicalCredential(f.root, "v", i.Fence, f.l.policy, state); err != nil {
		t.Fatal(err)
	}
}

func TestNodeRefreshUnknownNeverRetriesOrAcceptsReplacementAttempt(t *testing.T) {
	f, r, i, calls := refreshFixture(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		c, b, _ := w.(http.Hijacker).Hijack()
		fmt.Fprint(b, "HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n{\"access_token\":")
		b.Flush()
		c.Close()
	}))
	if _, err := r.Refresh(context.Background(), i); err == nil {
		t.Fatal("truncated accepted refresh completed")
	}
	replacement := i
	replacement.CommandID = "replacement-command"
	if _, err := r.Refresh(context.Background(), replacement); err == nil {
		t.Fatal("unknown refresh was reissued")
	}
	if calls.Load() != 1 {
		t.Fatalf("provider requests=%d want 1", calls.Load())
	}
	state, _ := f.a.State("v")
	if !hasPendingMutation(state) {
		t.Fatal("unknown refresh released node mutation")
	}
}

func TestNodeRefreshRequiresPrivateOwnershipAndOriginalActiveFence(t *testing.T) {
	f, r, i, calls := refreshFixture(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { t.Error("provider called after denied refresh") }))
	stale := i
	stale.Fence.Incarnation = strings.Repeat("f", 32)
	if _, err := r.Refresh(context.Background(), stale); !errors.Is(err, ErrFenceMismatch) {
		t.Fatalf("stale fence: %v", err)
	}
	f.a.mu.Lock()
	state := f.a.journal.Slots["v"]
	state.InitialManifest.CredentialAuthority = ""
	state.InitialManifest.PrivateCredentialDigest = ""
	state.Credential = nil
	f.a.journal.Slots["v"] = state
	f.a.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err := r.Refresh(ctx, i); err == nil {
		t.Fatal("legacy exposed refresh token was adopted")
	}
	if calls.Load() != 0 {
		t.Fatal("denied refresh reached provider")
	}
}

func TestNodeRefreshProjectionFailuresRemainUnknown(t *testing.T) {
	for _, point := range []string{"before-projection", "after-projection"} {
		t.Run(point, func(t *testing.T) {
			f, r, i, calls := refreshFixture(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				fmt.Fprint(w, `{"access_token":"synthetic-next","expires_in":3600}`)
			}))
			r.fault = func(stage string) error {
				if stage == point {
					return errors.New("synthetic projection failure")
				}
				return nil
			}
			if _, err := r.Refresh(context.Background(), i); err == nil {
				t.Fatal("partial publication completed")
			}
			i.CommandID = "after-partial-publication"
			if _, err := r.Refresh(context.Background(), i); err == nil {
				t.Fatal("partial publication allowed another refresh")
			}
			state, _ := f.a.State("v")
			if calls.Load() != 1 || !hasPendingMutation(state) {
				t.Fatal("partial publication lost its pending attempt")
			}
			if _, err := f.a.Revoke("v", i.Fence); err != nil {
				t.Fatal(err)
			}
			if _, err := f.a.Advance(context.Background(), "v", i.Fence); !errors.Is(err, ErrPendingMutation) {
				t.Fatal("container termination was allowed to clear a node refresh")
			}
		})
	}
}
func TestNodeRefreshCompleteRejectionAllowsLaterOperatorAttempt(t *testing.T) {
	_, r, i, calls := refreshFixture(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(401)
		fmt.Fprint(w, `{"error":"invalid_grant"}`)
	}))
	for _, id := range []string{"first-rejection", "later-operator-attempt"} {
		i.CommandID = id
		receipt, err := r.Refresh(context.Background(), i)
		if err != nil || receipt.OK || !receipt.Finished || receipt.Credential.Generation != "1" {
			t.Fatalf("complete rejection: %+v %v", receipt, err)
		}
	}
	if calls.Load() != 2 {
		t.Fatal("a previous complete rejection permanently suppressed an operator attempt")
	}
}
func TestNodePrivateCredentialStateIsNotMutableThroughSnapshot(t *testing.T) {
	f := publishingFixture(t)
	f.publish(t)
	state, _ := f.a.State("v")
	state.Credential.Generation = "999"
	persisted, _ := f.a.State("v")
	if persisted.Credential.Generation != "1" {
		t.Fatal("snapshot mutated private authority")
	}
}
