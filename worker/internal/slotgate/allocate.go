package slotgate

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strconv"
	"strings"
)

var (
	ErrManagementDenied      = errors.New("management_denied")
	ErrManagementUnavailable = errors.New("management_authority_unavailable")
	ErrAllocationConflict    = errors.New("allocation_conflict")
)

type AllocationIntent struct {
	NodeID       string `json:"node_id"`
	VMID         string `json:"vm_id"`
	AllocationID string `json:"allocation_id"`
	OperationID  string `json:"operation_id"`
	OwnerID      string `json:"owner_id"`
}

type AllocationReceipt struct {
	AllocationIntent
	Epoch        string `json:"epoch"`
	IntentDigest string `json:"intent_digest"`
	Fence        Fence  `json:"fence"`
}

func (i AllocationIntent) digest() string {
	digest := sha256.Sum256([]byte(strings.Join([]string{"slotgate-allocate-v1", i.NodeID, i.VMID, i.AllocationID, i.OperationID, i.OwnerID}, "\x00")))
	return hex.EncodeToString(digest[:])
}

func validAllocation(i AllocationIntent, epoch string) bool {
	for _, value := range []string{i.NodeID, i.VMID, i.AllocationID, i.OperationID, i.OwnerID} {
		if !vmIDRe.MatchString(value) {
			return false
		}
	}
	n, err := strconv.ParseUint(epoch, 10, 63)
	return err == nil && n > 0 && strconv.FormatUint(n, 10) == epoch
}

// Allocate changes only the node journal. The caller is a trusted authorizer
// holding a live grant lock; no directory, process or container is created.
func (a *Authority) Allocate(intent AllocationIntent, epoch string) (AllocationReceipt, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if err := a.available(); err != nil {
		return AllocationReceipt{}, err
	}
	if !validAllocation(intent, epoch) {
		return AllocationReceipt{}, ErrInvalidAuthority
	}
	for vm, state := range a.journal.Slots {
		if state.Allocation != nil && state.Allocation.AllocationID == intent.AllocationID && vm != intent.VMID {
			return AllocationReceipt{}, ErrAllocationConflict
		}
	}
	if state, exists := a.journal.Slots[intent.VMID]; exists {
		if state.Allocation == nil || state.Allocation.AllocationIntent != intent || state.Allocation.Epoch != epoch {
			return AllocationReceipt{}, ErrAllocationConflict
		}
		// Return the original vacant fence, never relabel an old allocation
		// with a later active executor or generation from State().
		return *state.Allocation, nil
	}
	incarnation, err := randomAuthorityID()
	if err != nil {
		return AllocationReceipt{}, err
	}
	receipt := AllocationReceipt{AllocationIntent: intent, Epoch: epoch, IntentDigest: intent.digest(), Fence: Fence{Generation: 1, Incarnation: incarnation}}
	state := AuthorityState{Fence: receipt.Fence, Phase: PhaseVacant, Commands: map[string]CommandRecord{}, Allocation: &receipt}
	if _, err = a.commit(intent.VMID, state); err != nil {
		return AllocationReceipt{}, err
	}
	return receipt, nil
}

type allocationAuthorizer func(context.Context, AllocationIntent, func(string) error) error
type allocationManager struct {
	authority *Authority
	nodeID    string
	authorize allocationAuthorizer
}

func (m *allocationManager) Allocate(ctx context.Context, intent AllocationIntent) (AllocationReceipt, error) {
	if m.authorize == nil || intent.NodeID != m.nodeID {
		return AllocationReceipt{}, ErrManagementDenied
	}
	var receipt AllocationReceipt
	err := m.authorize(ctx, intent, func(epoch string) error {
		var err error
		receipt, err = m.authority.Allocate(intent, epoch)
		return err
	})
	if err != nil {
		return AllocationReceipt{}, err
	}
	return receipt, nil
}
