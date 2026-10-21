package slotgate

import (
	"context"
	"testing"
)

// An existing directory is not proof that node-owned publication completed.
// In particular, a leftover tree after rename/journal failure must not launch.
func TestInitialPublishUnrecordedTreeCannotReachDocker(t *testing.T) {
	_, launcher, engine, state, _ := launchFixture(t)
	if _, err := launcher.Launch(context.Background(), "v", state.Fence, "unrecorded-publication"); err == nil {
		t.Fatal("launch accepted files without a durable completed manifest")
	}
	engine.mu.Lock()
	defer engine.mu.Unlock()
	if len(engine.calls) != 0 {
		t.Fatalf("unrecorded publication reached Docker: %v", engine.calls)
	}
}

// Allocation and inference authorization cannot stand in for a publish grant.
func TestInitialPublishRequiresIndependentManagementAuthorization(t *testing.T) {
	addr, _, _, state, _ := fencedGate(t)
	reply := gate2Control(t, addr, gate2Request{Op: "publish-initial", VMID: "v", Fence: state.Fence, CommandID: "unauthorized-publication"})
	if reply.OK || reply.Error != ErrManagementDenied.Error() {
		t.Fatalf("publish without an independent action authorizer: %+v", reply)
	}
}
