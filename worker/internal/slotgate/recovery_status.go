package slotgate

import (
	"encoding/hex"
	"strings"
)

// Historical status is a read of an original execution identity. It does not
// authorize dispatch and deliberately does not require a dead controller's
// nonce/runtime or match the current generation of the slot.
type recoveryCommandStatus struct {
	ID         string            `json:"id"`
	Fence      Fence             `json:"fence"`
	Status     CommandStatus     `json:"status"`
	Dispatched bool              `json:"dispatched"`
	Receipt    *inferenceReceipt `json:"-"`
}

func (a *Authority) recoveryStatus(vm string, fence Fence, id string) (*recoveryCommandStatus, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if err := a.available(); err != nil {
		return nil, err
	}
	incarnation, err := hex.DecodeString(fence.Incarnation)
	if !vmIDRe.MatchString(vm) || !validAuthorityID(id) || !publicHealthString(id) || fence.Generation == 0 || err != nil || len(incarnation) != 16 || strings.ToLower(fence.Incarnation) != fence.Incarnation || validateExecutor(fence.Executor) != nil {
		return nil, ErrInvalidAuthority
	}
	state, ok := a.journal.Slots[vm]
	if !ok {
		return nil, nil
	}
	command, ok := state.Commands[id]
	if !ok {
		return nil, nil
	}
	if command.Fence != fence {
		return nil, ErrFenceMismatch
	}
	if command.Kind != CommandForward {
		return nil, ErrManagementDenied
	}
	return &recoveryCommandStatus{ID: command.ID, Fence: command.Fence, Status: command.Status, Dispatched: command.Dispatched, Receipt: cloneInferenceReceipt(command.TerminalReceipt)}, nil
}
