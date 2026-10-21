package slotgate

import (
	"context"
	"errors"
	"path/filepath"
	"sync"
	"strings"
	"testing"
)

func allocationIntent(id string) AllocationIntent {
	return AllocationIntent{NodeID: "synthetic-node", VMID: "v", AllocationID: id, OperationID: "synthetic-operation", OwnerID: "synthetic-controller"}
}

func TestAllocationReceiptCreatesOnlyOneInitialGenerationAndSurvivesReopen(t *testing.T) {
	root := filepath.Join(shortRoot(t), "authority")
	a, err := OpenAuthority(root, nil)
	if err != nil {
		t.Fatal(err)
	}
	intent := allocationIntent("allocation-one")
	var wg sync.WaitGroup
	receipts := make(chan AllocationReceipt, 2)
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			receipt, err := a.Allocate(intent, "1")
			if err != nil {
				t.Error(err)
				return
			}
			receipts <- receipt
		}()
	}
	wg.Wait()
	close(receipts)
	var first AllocationReceipt
	for receipt := range receipts {
		if receipt.Fence.Generation != 1 || receipt.Fence.Executor != (ExecutorIdentity{}) {
			t.Fatalf("not a vacant initial generation: %+v", receipt)
		}
		if first.AllocationID != "" && first != receipt {
			t.Fatalf("duplicate allocation changed receipt")
		}
		first = receipt
	}
	if first.AllocationID == "" {
		t.Fatal("no receipt")
	}
	if _, err = a.Allocate(allocationIntent("other-allocation"), "1"); !errors.Is(err, ErrAllocationConflict) {
		t.Fatalf("replace intent: %v", err)
	}
	if err = a.Close(); err != nil {
		t.Fatal(err)
	}
	a, err = OpenAuthority(root, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { a.Close() })
	replayed, err := a.Allocate(intent, "1")
	if err != nil || replayed != first {
		t.Fatalf("lost-response replay: %+v %v", replayed, err)
	}
}

func TestAllocationDeniedByAuthorizerMakesNoLocalSlot(t *testing.T) {
	a := authorityForTest(t, filepath.Join(shortRoot(t), "authority"), nil)
	manager := allocationManager{authority: a, nodeID: "synthetic-node", authorize: func(context.Context, AllocationIntent, func(string) error) error { return ErrManagementDenied }}
	if _, err := manager.Allocate(context.Background(), allocationIntent("denied")); !errors.Is(err, ErrManagementDenied) {
		t.Fatal(err)
	}
	if _, err := a.State("v"); !errors.Is(err, ErrInvalidAuthority) {
		t.Fatalf("denied allocation left state: %v", err)
	}
}

func TestKSG2ForwardTokenAloneCannotAuthorizeManagement(t *testing.T) {
	addr, _, server, state, _ := fencedGate(t)
	server.authorizeManagement = nil
	for _, op := range []string{"allocate", "launch", "revoke", "advance"} {
		reply := gate2Control(t, addr, gate2Request{Op: op, VMID: "v", Fence: state.Fence, CommandID: "unauthorized"})
		if reply.OK || reply.Error != ErrManagementDenied.Error() {
			t.Fatalf("%s: %+v", op, reply)
		}
	}
}

func TestInitializedManagementBindingCannotBeRemovedOrRelabeled(t *testing.T) {
	root := shortRoot(t)
	management := &PGManagementConfig{ConnectionString:"postgres://synthetic@127.0.0.1:1/synthetic_test?sslmode=disable",AuthoritySchema:"vm2api_node_"+strings.Repeat("a",32),NodeID:"synthetic-node"}
	config := Config{Listen:"127.0.0.1:0",Root:root,Token:testToken,TLSDir:filepath.Join(root,"tls"),Fenced:true,AuthorityDir:filepath.Join(root,"authority"),Management:management}
	server,err := New(config)
	if err != nil { t.Fatal(err) }
	server.authority.Close()
	config.Management = nil
	if reopened,err := New(config); err == nil { reopened.authority.Close();t.Fatal("initialized node accepted missing authorizer") }
	copy := *management
	copy.NodeID = "different-node"
	config.Management = &copy
	if reopened,err := New(config); err == nil { reopened.authority.Close();t.Fatal("initialized node accepted a different identity") }
}
