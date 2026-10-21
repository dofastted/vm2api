package slotgate

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func testExecutor(n string) ExecutorIdentity {
	return ExecutorIdentity{Kind: "container", ContainerID: strings.Repeat(n, 64), StartedAt: "2026-10-21T00:00:00Z", NodeBootID: "test-node-boot"}
}

func terminatedExecutor(_ context.Context, executor ExecutorIdentity) (TerminationProof, error) {
	return TerminationProof{ID: "proof-1", Executor: executor, Scope: "container_removed", ObservedAt: "2026-10-21T00:01:00Z"}, nil
}

func authorityForTest(t *testing.T, root string, verify TerminationVerifier) *Authority {
	t.Helper()
	a, err := OpenAuthority(root, verify)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { a.Close() })
	return a
}

func launchForTest(t *testing.T, a *Authority, vm string, executor ExecutorIdentity) AuthorityState {
	t.Helper()
	s, err := a.CreateSlot(vm)
	if err != nil {
		t.Fatal(err)
	}
	launch, err := a.BeginLaunch(vm, s.Fence, "launch-"+vm)
	if err != nil {
		t.Fatal(err)
	}
	s, err = a.BindExecutor(launch, executor)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func requireAuthorityError(t *testing.T, err, want error) {
	t.Helper()
	if !errors.Is(err, want) {
		t.Fatalf("error = %v, want %v", err, want)
	}
}

func TestAuthorityAllowsConcurrentControllersWithinOneIncarnation(t *testing.T) {
	a := authorityForTest(t, t.TempDir(), terminatedExecutor)
	s := launchForTest(t, a, "vm-1", testExecutor("a"))
	first, err := a.BeginCommand("vm-1", s.Fence, "controller-a-request", CommandForward)
	if err != nil {
		t.Fatal(err)
	}
	second, err := a.BeginCommand("vm-1", s.Fence, "controller-b-request", CommandForward)
	if err != nil {
		t.Fatalf("another controller must share the active incarnation: %v", err)
	}
	if err = a.CompleteCommand(first); err != nil {
		t.Fatal(err)
	}
	if err = a.CompleteCommand(second); err != nil {
		t.Fatal(err)
	}
	if _, err = a.BeginCommand("vm-1", s.Fence, first.ID, CommandForward); !errors.Is(err, ErrCommandExists) {
		t.Fatalf("completed command was replayed: %v", err)
	}
}

func TestAuthorityRevocationRequiresProofAndRejectsCapturedOldCommands(t *testing.T) {
	a := authorityForTest(t, t.TempDir(), terminatedExecutor)
	old := launchForTest(t, a, "vm-1", testExecutor("a"))
	pending, err := a.BeginCommand("vm-1", old.Fence, "old-request", CommandForward)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = a.Revoke("vm-1", old.Fence); err != nil {
		t.Fatal(err)
	}
	_, err = a.BeginCommand("vm-1", old.Fence, "late-old-command", CommandMutation)
	requireAuthorityError(t, err, ErrAuthorityPhase)
	next, err := a.Advance(context.Background(), "vm-1", old.Fence)
	if err != nil {
		t.Fatal(err)
	}
	if next.Phase != PhaseVacant || next.Fence.Generation != old.Fence.Generation+1 || next.Fence.Incarnation == old.Fence.Incarnation || next.Fence.Executor.Kind != "" {
		t.Fatalf("new incarnation must be vacant: %+v", next)
	}
	if next.Commands[pending.ID].Status != CommandTerminated || next.LastTermination == nil {
		t.Fatal("verified termination must retain the old command and proof")
	}
	_, err = a.BeginCommand("vm-1", old.Fence, "delayed-after-takeover", CommandMutation)
	requireAuthorityError(t, err, ErrFenceMismatch)
	requireAuthorityError(t, a.CompleteCommand(pending), ErrFenceMismatch)
	launch, err := a.BeginLaunch("vm-1", next.Fence, "launch-new")
	if err != nil {
		t.Fatal(err)
	}
	active, err := a.BindExecutor(launch, testExecutor("b"))
	if err != nil {
		t.Fatal(err)
	}
	_, err = a.BeginCommand("vm-1", active.Fence, pending.ID, CommandForward)
	requireAuthorityError(t, err, ErrCommandExists)
}

func TestAuthorityRejectsUnverifiedOrWrongExecutorProof(t *testing.T) {
	for _, tc := range []struct {
		name   string
		verify TerminationVerifier
	}{
		{"missing", nil},
		{"failure", func(context.Context, ExecutorIdentity) (TerminationProof, error) {
			return TerminationProof{}, errors.New("termination unconfirmed")
		}},
		{"wrong identity", func(ctx context.Context, _ ExecutorIdentity) (TerminationProof, error) {
			return terminatedExecutor(ctx, testExecutor("b"))
		}},
		{"cancel ack", func(_ context.Context, e ExecutorIdentity) (TerminationProof, error) {
			return TerminationProof{ID: "ack", Executor: e, Scope: "cancel_ack", ObservedAt: "2026-10-21T00:01:00Z"}, nil
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := authorityForTest(t, t.TempDir(), tc.verify)
			s := launchForTest(t, a, "vm-1", testExecutor("a"))
			if _, err := a.Revoke("vm-1", s.Fence); err != nil {
				t.Fatal(err)
			}
			if _, err := a.Advance(context.Background(), "vm-1", s.Fence); err == nil {
				t.Fatal("unverified termination advanced generation")
			}
			got, err := a.State("vm-1")
			if err != nil || got.Fence != s.Fence || got.Phase != PhaseRevoking {
				t.Fatalf("state changed without proof: %+v, %v", got, err)
			}
		})
	}
}

func TestAuthorityPendingMutationCannotBeClearedByExecutorTermination(t *testing.T) {
	verified := 0
	a := authorityForTest(t, t.TempDir(), func(ctx context.Context, e ExecutorIdentity) (TerminationProof, error) {
		verified++
		return terminatedExecutor(ctx, e)
	})
	s := launchForTest(t, a, "vm-1", testExecutor("a"))
	command, err := a.BeginCommand("vm-1", s.Fence, "docker-restart", CommandMutation)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = a.Revoke("vm-1", s.Fence); err != nil {
		t.Fatal(err)
	}
	_, err = a.Advance(context.Background(), "vm-1", s.Fence)
	requireAuthorityError(t, err, ErrPendingMutation)
	if verified != 0 {
		t.Fatal("executor termination does not settle a delayed Docker operation")
	}
	if err = a.CompleteCommand(command); err != nil {
		t.Fatal(err)
	}
	if _, err = a.Advance(context.Background(), "vm-1", s.Fence); err != nil {
		t.Fatal(err)
	}
}

func TestAuthorityRestartRetainsPendingWorkAndRejectsOldDaemonCompletion(t *testing.T) {
	for _, kind := range []CommandKind{CommandForward, CommandMutation} {
		t.Run(string(kind), func(t *testing.T) {
			root := t.TempDir()
			a := authorityForTest(t, root, terminatedExecutor)
			s := launchForTest(t, a, "vm-1", testExecutor("a"))
			command, err := a.BeginCommand("vm-1", s.Fence, "pending", kind)
			if err != nil {
				t.Fatal(err)
			}
			if err = a.Close(); err != nil {
				t.Fatal(err)
			}
			reopened := authorityForTest(t, root, terminatedExecutor)
			got, err := reopened.State("vm-1")
			if err != nil || got.Phase != PhaseRevoking || got.Commands[command.ID].Status != CommandUnknown {
				t.Fatalf("restart admitted unknown work: %+v, %v", got, err)
			}
			_, err = reopened.BeginCommand("vm-1", s.Fence, "after-restart", CommandForward)
			requireAuthorityError(t, err, ErrAuthorityPhase)
			requireAuthorityError(t, reopened.CompleteCommand(command), ErrCommandOwner)
			_, err = reopened.Advance(context.Background(), "vm-1", s.Fence)
			if kind == CommandMutation {
				requireAuthorityError(t, err, ErrPendingMutation)
			} else if err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestAuthorityRestartNeverReplaysLaunchWithUnknownImmutableIdentity(t *testing.T) {
	root := t.TempDir()
	a := authorityForTest(t, root, terminatedExecutor)
	s, err := a.CreateSlot("vm-1")
	if err != nil {
		t.Fatal(err)
	}
	launch, err := a.BeginLaunch("vm-1", s.Fence, "launch-may-have-started")
	if err != nil {
		t.Fatal(err)
	}
	if err = a.Close(); err != nil {
		t.Fatal(err)
	}
	reopened := authorityForTest(t, root, terminatedExecutor)
	_, err = reopened.BindExecutor(launch, testExecutor("a"))
	requireAuthorityError(t, err, ErrCommandOwner)
	_, err = reopened.Advance(context.Background(), "vm-1", s.Fence)
	requireAuthorityError(t, err, ErrPendingMutation)
}

func TestAuthorityCompletedStatePersistsAndSnapshotsCannotModifyAuthority(t *testing.T) {
	root := t.TempDir()
	a := authorityForTest(t, root, terminatedExecutor)
	s := launchForTest(t, a, "vm-1", testExecutor("a"))
	command, err := a.BeginCommand("vm-1", s.Fence, "completed", CommandForward)
	if err != nil {
		t.Fatal(err)
	}
	if err = a.CompleteCommand(command); err != nil {
		t.Fatal(err)
	}
	snapshot, err := a.State("vm-1")
	if err != nil {
		t.Fatal(err)
	}
	delete(snapshot.Commands, command.ID)
	if err = a.Close(); err != nil {
		t.Fatal(err)
	}
	reopened := authorityForTest(t, root, terminatedExecutor)
	got, err := reopened.State("vm-1")
	if err != nil || got.Phase != PhaseActive || got.Fence != s.Fence || got.Commands[command.ID].Status != CommandCompleted {
		t.Fatalf("completed state lost: %+v, %v", got, err)
	}
	_, err = reopened.BeginCommand("vm-1", s.Fence, command.ID, CommandForward)
	requireAuthorityError(t, err, ErrCommandExists)
}

func TestAuthorityEveryMutationChecksCapturedGenerationIncarnationAndIdentity(t *testing.T) {
	a := authorityForTest(t, t.TempDir(), terminatedExecutor)
	s := launchForTest(t, a, "vm-1", testExecutor("a"))
	for _, alter := range []func(*Fence){
		func(f *Fence) { f.Generation++ },
		func(f *Fence) { f.Incarnation = "another-incarnation" },
		func(f *Fence) { f.Executor = testExecutor("b") },
	} {
		wrong := s.Fence
		alter(&wrong)
		_, err := a.BeginCommand("vm-1", wrong, "stale", CommandMutation)
		requireAuthorityError(t, err, ErrFenceMismatch)
		_, err = a.Revoke("vm-1", wrong)
		requireAuthorityError(t, err, ErrFenceMismatch)
		_, err = a.Advance(context.Background(), "vm-1", wrong)
		requireAuthorityError(t, err, ErrFenceMismatch)
	}
}

func TestAuthoritySerializesSameNodeJournalAcrossProcesses(t *testing.T) {
	root := t.TempDir()
	a := authorityForTest(t, root, terminatedExecutor)
	_, err := OpenAuthority(root, terminatedExecutor)
	requireAuthorityError(t, err, ErrAuthorityLocked)
	if err = a.Close(); err != nil {
		t.Fatal(err)
	}
	authorityForTest(t, root, terminatedExecutor)
}

func TestAuthorityInvalidJournalIsNotReinitialized(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "authority.json"), []byte(`{"version":1,"slots":`), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := OpenAuthority(root, terminatedExecutor)
	if err == nil {
		t.Fatal("corrupt authority was treated as a new node")
	}
	data, readErr := os.ReadFile(filepath.Join(root, "authority.json"))
	if readErr != nil || string(data) != `{"version":1,"slots":` {
		t.Fatalf("invalid journal overwritten: %q, %v", data, readErr)
	}
}

func TestAuthorityDurabilityFailurePreventsAuthorizationAndPoisonsInstance(t *testing.T) {
	root := t.TempDir()
	a := authorityForTest(t, root, terminatedExecutor)
	s := launchForTest(t, a, "vm-1", testExecutor("a"))
	file := filepath.Join(root, "authority.json")
	if err := os.Rename(file, file+".saved"); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(file, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := a.BeginCommand("vm-1", s.Fence, "must-not-send", CommandForward); err == nil {
		t.Fatal("command authorized before durable commit")
	}
	if err := os.Remove(file); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(file+".saved", file); err != nil {
		t.Fatal(err)
	}
	_, err := a.BeginCommand("vm-1", s.Fence, "still-must-not-send", CommandForward)
	requireAuthorityError(t, err, ErrAuthorityUnavailable)
}

func TestAuthoritySlowTerminationVerificationDoesNotSerializeOtherVMs(t *testing.T) {
	entered, proceed := make(chan struct{}), make(chan struct{})
	a := authorityForTest(t, t.TempDir(), func(ctx context.Context, e ExecutorIdentity) (TerminationProof, error) {
		close(entered)
		<-proceed
		return terminatedExecutor(ctx, e)
	})
	first := launchForTest(t, a, "vm-1", testExecutor("a"))
	second := launchForTest(t, a, "vm-2", testExecutor("b"))
	if _, err := a.Revoke("vm-1", first.Fence); err != nil {
		t.Fatal(err)
	}
	advanced := make(chan error, 1)
	go func() { _, err := a.Advance(context.Background(), "vm-1", first.Fence); advanced <- err }()
	<-entered
	commandDone := make(chan error, 1)
	go func() {
		_, err := a.BeginCommand("vm-2", second.Fence, "parallel-vm", CommandForward)
		commandDone <- err
	}()
	select {
	case err := <-commandDone:
		close(proceed)
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		close(proceed)
		t.Fatal("another VM waited behind termination verification")
	}
	if err := <-advanced; err != nil {
		t.Fatal(err)
	}
}
