package slotgate

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/dofastted/kin-gateway/worker/internal/credential"
	kinoauth "github.com/dofastted/kin-gateway/worker/internal/oauth"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const commandRefresh CommandKind = "credential-refresh"

type RefreshIntent struct {
	Action             string `json:"action"`
	NodeID             string `json:"node_id"`
	VMID               string `json:"vm_id"`
	AllocationID       string `json:"allocation_id"`
	OperationID        string `json:"operation_id"`
	OwnerID            string `json:"owner_id"`
	CommandID          string `json:"command_id"`
	AccountID          string `json:"account_id"`
	BGTaskKey          string `json:"bg_task_key"`
	BGExecutionID      string `json:"bg_execution_id"`
	BGOwnerID          string `json:"bg_owner_id"`
	Epoch              string `json:"epoch"`
	Fence              Fence  `json:"fence"`
	ExpectedGeneration string `json:"expected_credential_generation"`
	ManifestRevision   string `json:"manifest_revision"`
	ManifestDigest     string `json:"manifest_digest"`
	PresetID           string `json:"preset_id"`
	PolicyDigest       string `json:"policy_digest"`
	Force              bool   `json:"force"`
}

func validRefreshIntent(i RefreshIntent) bool {
	if i.Action != "credential-refresh" || !validAllocation(AllocationIntent{i.NodeID, i.VMID, i.AllocationID, i.OperationID, i.OwnerID}, i.Epoch) || !vmIDRe.MatchString(i.CommandID) || !vmIDRe.MatchString(i.AccountID) || !vmIDRe.MatchString(i.BGOwnerID) || i.BGTaskKey != "oauth-refresh:claude:"+i.AccountID || !vmIDRe.MatchString(i.BGExecutionID) || validateExecutor(i.Fence.Executor) != nil || i.Fence.Executor.Kind != "container" || i.Fence.Generation == 0 || !validAuthorityID(i.Fence.Incarnation) || i.ManifestRevision != "1" || !validDigest(i.ManifestDigest) || !validDigest(i.PolicyDigest) || i.PresetID != initialPresetID {
		return false
	}
	n, err := strconv.ParseInt(i.ExpectedGeneration, 10, 64)
	return err == nil && n > 0 && n < 1<<63-1 && strconv.FormatInt(n, 10) == i.ExpectedGeneration
}
func (i RefreshIntent) digest() string {
	force := "0"
	if i.Force {
		force = "1"
	}
	e := i.Fence.Executor
	return hashText(strings.Join([]string{"slotgate-refresh-v1", i.Action, i.NodeID, i.VMID, i.AllocationID, i.OperationID, i.OwnerID, i.CommandID, i.AccountID, i.BGTaskKey, i.BGExecutionID, i.BGOwnerID, i.Epoch, strconv.FormatUint(i.Fence.Generation, 10), i.Fence.Incarnation, e.Kind, e.NodeBootID, e.ContainerID, e.DockerDaemonID, e.StartedAt, i.ExpectedGeneration, i.ManifestRevision, i.ManifestDigest, i.PresetID, i.PolicyDigest, force}, "\x00"))
}

type PublicCredential struct {
	Generation   string `json:"generation"`
	ExpiresAt    string `json:"expires_at"`
	AccountUUID  string `json:"account_uuid"`
	OrgUUID      string `json:"org_uuid,omitempty"`
	Email        string `json:"email,omitempty"`
	HasAccess    bool   `json:"has_access"`
	HasRefresh   bool   `json:"has_refresh"`
	NeedsRefresh bool   `json:"needs_refresh"`
}
type RefreshReceipt struct {
	Intent       RefreshIntent    `json:"intent"`
	IntentDigest string           `json:"intent_digest"`
	Finished     bool             `json:"finished"`
	OK           bool             `json:"ok"`
	Status       int              `json:"status"`
	Refreshed    bool             `json:"refreshed"`
	ErrorCode    string           `json:"error_code,omitempty"`
	Credential   PublicCredential `json:"credential"`
}
type RefreshAuthorizer func(context.Context, RefreshIntent, func() error) error
type nodeCredentialRefresher struct {
	authority    *Authority
	root         string
	nodeID       string
	policy       DockerLaunchPolicy
	authorize    RefreshAuthorizer
	newRefresher func(*credential.Store) *kinoauth.Refresher
	fault        func(string) error
}

func publicCredential(data []byte, identity credentialIdentity) (PublicCredential, error) {
	summary, _, err := nodeCredentialSummary(data, identity)
	if err != nil {
		return PublicCredential{}, err
	}
	encoded, _ := json.Marshal(summary)
	var result PublicCredential
	if err = json.Unmarshal(encoded, &result); err != nil {
		return result, err
	}
	return result, nil
}
func (r *nodeCredentialRefresher) Refresh(ctx context.Context, i RefreshIntent) (RefreshReceipt, error) {
	if r.authorize == nil || i.NodeID != r.nodeID || !validRefreshIntent(i) || i.PolicyDigest != r.policy.digest() {
		return RefreshReceipt{}, ErrManagementDenied
	}
	var state AuthorityState
	var handle CommandHandle
	err := r.authorize(ctx, i, func() error { var err error; handle, state, err = r.authority.beginCredentialRefresh(i); return err })
	if err != nil {
		return RefreshReceipt{}, err
	}
	canonical, err := r.authority.readCanonicalCredential(r.root, i.VMID, i.Fence, r.policy, state)
	if err != nil {
		return RefreshReceipt{}, err
	}
	// The durable start precedes the provider request. An ambiguous failure
	// retains this mutation; later file observations never authorize replay.
	store := credential.NewStore(filepath.Join(r.authority.root, "credentials", i.VMID, i.Fence.Incarnation, "credentials.json"))
	refresher := &kinoauth.Refresher{Store: store, Client: &http.Client{Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, TokenURL: "https://platform.claude.com/v1/oauth/token"}
	if r.newRefresher != nil {
		refresher = r.newRefresher(store)
	}
	result, refreshErr := refresher.Ensure(ctx, i.Force)
	receipt := RefreshReceipt{Intent: i, IntentDigest: i.digest(), Finished: true, OK: refreshErr == nil, Status: 200, Refreshed: result.Refreshed}
	if refreshErr != nil {
		var rejection *kinoauth.RefreshError
		if !errors.As(refreshErr, &rejection) || rejection.Unknown {
			return RefreshReceipt{}, ErrAuthorityUnavailable
		}
		receipt.Status = rejection.Status
		if receipt.Status < 400 || receipt.Status > 599 {
			receipt.Status = 400
		}
		receipt.ErrorCode = "credential_refresh_rejected"
	} else {
		canonical, err = readNodeCredential(r.authority.root, i.VMID, i.Fence)
		if err != nil {
			return RefreshReceipt{}, err
		}
	}
	receipt.Credential, err = publicCredential(canonical, state.InitialManifest.Identity)
	if err != nil {
		return RefreshReceipt{}, err
	}
	projection, err := credentialProjection(canonical)
	if err != nil {
		return RefreshReceipt{}, err
	}
	if refreshErr == nil {
		if err = publishFault(r.fault, "before-projection"); err != nil {
			return RefreshReceipt{}, err
		}
		if err = publishCredentialProjection(r.root, i.VMID, i.Fence, r.policy, projection); err != nil {
			return RefreshReceipt{}, err
		}
		if err = publishFault(r.fault, "after-projection"); err != nil {
			return RefreshReceipt{}, err
		}
	}
	err = r.authorize(ctx, i, func() error {
		return r.authority.completeCredentialRefresh(handle, receipt, nodeCredentialState{Generation: receipt.Credential.Generation, CanonicalDigest: hashBytes(canonical), ProjectionDigest: hashBytes(projection)})
	})
	return receipt, err
}
func (a *Authority) beginCredentialRefresh(i RefreshIntent) (CommandHandle, AuthorityState, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	state, err := a.match(i.VMID, i.Fence)
	if err != nil {
		return CommandHandle{}, state, err
	}
	if !validRefreshIntent(i) || state.Phase != PhaseActive || state.InitialManifest == nil || state.InitialManifest.CredentialAuthority != nodePrivateCredentialAuthority || state.Allocation == nil || state.Allocation.AllocationID != i.AllocationID || state.InitialManifest.Identity.AccountUUID != i.AccountID || state.InitialManifest.Receipt.ManifestDigest != i.ManifestDigest || state.InitialManifest.Receipt.Intent.PolicyDigest != i.PolicyDigest || !validNodeCredentialState(state.Credential) || state.Credential.Generation != i.ExpectedGeneration {
		return CommandHandle{}, state, ErrManagementDenied
	}
	if _, ok := state.Commands[i.CommandID]; ok {
		return CommandHandle{}, state, ErrCommandExists
	}
	for _, command := range state.Commands {
		if pendingCommand(command) {
			return CommandHandle{}, state, ErrPendingMutation
		}
	}
	token, err := randomAuthorityID()
	if err != nil {
		return CommandHandle{}, state, err
	}
	copy := i
	state.Commands[i.CommandID] = CommandRecord{ID: i.CommandID, Kind: commandRefresh, Status: CommandPending, Fence: i.Fence, Runtime: a.runtime, Token: token, Dispatched: true, Refresh: &copy}
	state, err = a.commit(i.VMID, state)
	return CommandHandle{VMID: i.VMID, ID: i.CommandID, Fence: i.Fence, runtime: a.runtime, token: token}, state, err
}
func (a *Authority) completeCredentialRefresh(handle CommandHandle, receipt RefreshReceipt, credential nodeCredentialState) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	state, command, err := a.command(handle)
	if err != nil {
		return err
	}
	if state.Phase != PhaseActive || state.Fence != handle.Fence || command.Kind != commandRefresh || command.Status != CommandPending || command.Refresh == nil || *command.Refresh != receipt.Intent || !validRefreshReceipt(receipt) || !validNodeCredentialState(&credential) || credential.Generation != receipt.Credential.Generation {
		return ErrAuthorityPhase
	}
	command.Status = CommandCompleted
	command.RefreshReceipt = &receipt
	state.Commands[handle.ID] = command
	state.Credential = &credential
	_, err = a.commit(handle.VMID, state)
	return err
}
func validRefreshReceipt(r RefreshReceipt) bool {
	return validRefreshIntent(r.Intent) && r.IntentDigest == r.Intent.digest() && r.Finished && r.Credential.AccountUUID == r.Intent.AccountID && r.Credential.Generation != "" && ((r.OK && r.Status == 200 && r.ErrorCode == "") || (!r.OK && r.Status >= 400 && r.Status <= 599 && r.ErrorCode == "credential_refresh_rejected"))
}
func validateRefreshCommand(vm string, c CommandRecord) error {
	if c.Kind != commandRefresh {
		if c.Refresh != nil || c.RefreshReceipt != nil {
			return ErrInvalidAuthority
		}
		return nil
	}
	if c.Refresh == nil || !validRefreshIntent(*c.Refresh) || c.Refresh.VMID != vm || c.Refresh.CommandID != c.ID || c.Refresh.Fence != c.Fence {
		return ErrInvalidAuthority
	}
	if c.RefreshReceipt != nil && (c.Status != CommandCompleted || c.RefreshReceipt.Intent != *c.Refresh || !validRefreshReceipt(*c.RefreshReceipt)) {
		return ErrInvalidAuthority
	}
	if c.Status == CommandCompleted && c.RefreshReceipt == nil {
		return ErrInvalidAuthority
	}
	return nil
}
