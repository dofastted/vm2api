package slotgate

// sealNotStarted is a deny operation, not execution or termination authority.
// It shares DispatchCommand's lock and journal: once this commit succeeds no
// delayed prepare/forward with the same ID can send a byte. A dispatched marker
// always wins, even if the response or the controller has subsequently vanished.
func (a *Authority) sealNotStarted(vm string, fence Fence, id string) (*recoveryCommandStatus, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !vmIDRe.MatchString(vm) || !validAuthorityID(id) || !publicHealthString(id) {
		return nil, ErrInvalidAuthority
	}
	state, err := a.match(vm, fence)
	if err != nil {
		return nil, err
	}
	if state.Phase != PhaseActive || state.Allocation == nil || state.InitialManifest == nil || hasPendingMutation(state) {
		return nil, ErrAuthorityPhase
	}
	if err = validateInitialManifest(vm, state); err != nil {
		return nil, err
	}
	manifestFence := state.InitialManifest.Receipt.Intent.Fence
	if fence.Generation != manifestFence.Generation || fence.Incarnation != manifestFence.Incarnation {
		return nil, ErrFenceMismatch
	}
	command, exists := state.Commands[id]
	if exists {
		if command.Fence != fence {
			return nil, ErrFenceMismatch
		}
		if command.Kind != CommandForward {
			return nil, ErrManagementDenied
		}
		if command.Dispatched {
			return nil, ErrCommandDispatched
		}
		if command.Status != CommandPending && command.Status != CommandNotStarted {
			return nil, ErrCommandOwner
		}
	} else {
		token, err := randomAuthorityID()
		if err != nil {
			return nil, err
		}
		command = CommandRecord{ID: id, Kind: CommandForward, Status: CommandPending, Fence: fence, Runtime: a.runtime, Token: token}
	}
	if command.Status != CommandNotStarted {
		command.Status = CommandNotStarted
		state.Commands[id] = command
		if _, err = a.commit(vm, state); err != nil {
			return nil, err
		}
	}
	return &recoveryCommandStatus{ID: command.ID, Fence: command.Fence, Status: command.Status, Dispatched: false}, nil
}
