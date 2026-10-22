package slotgate

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net"
	"path/filepath"
	"regexp"
	"time"

	"github.com/jackc/pgx/v5"
)

// This credential is installed by trusted node provisioning, not by RPC.
// The role can read only its node's authorization view and cannot issue grants.
type PGManagementConfig struct {
	ConnectionString string `json:"connection_string"`
	AuthoritySchema  string `json:"authority_schema"`
	NodeID           string `json:"node_id"`
}

type pgAllocationAuthorizer struct {
	config *pgx.ConnConfig
	schema string
	nodeID string
}

type managementBinding struct {
	ProtocolVersion int    `json:"protocol_version"`
	NodeID          string `json:"node_id"`
	AuthoritySchema string `json:"authority_schema"`
}

func (a *Authority) bindManagement(config *PGManagementConfig) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if err := a.available(); err != nil {
		return err
	}
	if config == nil {
		if a.journal.Management != nil {
			return ErrManagementDenied
		}
		for _, state := range a.journal.Slots {
			if state.Allocation != nil {
				return ErrManagementDenied
			}
		}
		return nil
	}
	binding := managementBinding{ProtocolVersion: 1, NodeID: config.NodeID, AuthoritySchema: config.AuthoritySchema}
	if !vmIDRe.MatchString(binding.NodeID) || !authoritySchemaRE.MatchString(binding.AuthoritySchema) {
		return ErrManagementDenied
	}
	if a.journal.Management != nil {
		if *a.journal.Management != binding {
			return ErrManagementDenied
		}
		return nil
	}
	next := a.journal
	next.Management = &binding
	if err := a.persist(next); err != nil {
		return err
	}
	a.journal = next
	return nil
}

var authoritySchemaRE = regexp.MustCompile(`^vm2api_node_[a-f0-9]{32}$`)

func newPGAllocationAuthorizer(input PGManagementConfig) (*pgAllocationAuthorizer, error) {
	if !authoritySchemaRE.MatchString(input.AuthoritySchema) || !vmIDRe.MatchString(input.NodeID) || input.ConnectionString == "" {
		return nil, ErrManagementDenied
	}
	config, err := pgx.ParseConfig(input.ConnectionString)
	if err != nil {
		return nil, ErrManagementUnavailable
	}
	// Plaintext is limited to a node-local Unix socket/loopback test database.
	local := filepath.IsAbs(config.Host)
	if ip := net.ParseIP(config.Host); ip != nil {
		local = local || ip.IsLoopback()
	}
	if !local && (config.TLSConfig == nil || config.TLSConfig.InsecureSkipVerify || len(config.Fallbacks) != 0) {
		return nil, ErrManagementDenied
	}
	config.ConnectTimeout = 3 * time.Second
	config.DefaultQueryExecMode = pgx.QueryExecModeExec
	return &pgAllocationAuthorizer{config: config, schema: input.AuthoritySchema, nodeID: input.NodeID}, nil
}

func (a *pgAllocationAuthorizer) Authorize(ctx context.Context, intent AllocationIntent, dispatch func(string) error) error {
	if intent.NodeID != a.nodeID || !validAllocation(intent, "1") {
		return ErrManagementDenied
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	connection, err := pgx.ConnectConfig(ctx, a.config.Copy())
	if err != nil {
		return ErrManagementUnavailable
	}
	defer func() {
		closed, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		connection.Close(closed)
	}()
	var directRole bool
	if err = connection.QueryRow(ctx, "SELECT current_user=session_user").Scan(&directRole); err != nil || !directRole {
		return ErrManagementDenied
	}
	q := pgx.Identifier{a.schema}.Sanitize()
	var nodeID, applicationSchema string
	var version int
	if err = connection.QueryRow(ctx, "SELECT node_id,application_schema,protocol_version FROM "+q+".reader_identity()").Scan(&nodeID, &applicationSchema, &version); err != nil {
		return ErrManagementUnavailable
	}
	expectedSchema := sha256.Sum256([]byte(applicationSchema))
	if version != 1 || nodeID != a.nodeID || a.schema != "vm2api_node_"+hex.EncodeToString(expectedSchema[:16]) {
		return ErrManagementDenied
	}
	tx, err := connection.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return ErrManagementUnavailable
	}
	defer func() {
		rollback, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		tx.Rollback(rollback)
	}()
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock_shared(hashtext($1),hashtext($2))",
		"vm2api:node-management:"+a.schema, "node:"+a.nodeID+":vm:"+intent.VMID); err != nil {
		return ErrManagementUnavailable
	}
	var epoch, digest string
	err = tx.QueryRow(ctx, "SELECT epoch::text,intent_digest FROM "+q+".authorized_allocations WHERE allocation_id=$1 AND node_id=$2 AND vm_id=$3 AND operation_id=$4 AND owner_id=$5 AND action='allocate'",
		intent.AllocationID, intent.NodeID, intent.VMID, intent.OperationID, intent.OwnerID).Scan(&epoch, &digest)
	if err == pgx.ErrNoRows {
		return ErrManagementDenied
	}
	if err != nil {
		return ErrManagementUnavailable
	}
	if !validAllocation(intent, epoch) || digest != intent.digest() {
		return ErrManagementDenied
	}
	if ctx.Err() != nil {
		return ErrManagementUnavailable
	}
	// Only bounded local journal I/O belongs in dispatch. Never Docker or an
	// outbound RPC. A failed COMMIT cannot acknowledge a local receipt.
	if err = dispatch(epoch); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return ErrManagementUnavailable
	}
	return nil
}

// Missing command protocol/view/role privilege always denies; allocation authorization is never a fallback.
func (a *pgAllocationAuthorizer) AuthorizeCommand(ctx context.Context, intent ManagementIntent, dispatch func() error) error {
	if intent.NodeID != a.nodeID || !validManagementIntent(intent) {
		return ErrManagementDenied
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	connection, err := pgx.ConnectConfig(ctx, a.config.Copy())
	if err != nil {
		return ErrManagementUnavailable
	}
	defer func() {
		closed, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		connection.Close(closed)
	}()
	var directRole bool
	if err = connection.QueryRow(ctx, "SELECT current_user=session_user").Scan(&directRole); err != nil || !directRole {
		return ErrManagementDenied
	}
	q := pgx.Identifier{a.schema}.Sanitize()
	var nodeID, applicationSchema string
	var version int
	if err = connection.QueryRow(ctx, "SELECT node_id,application_schema,protocol_version FROM "+q+".reader_identity()").Scan(&nodeID, &applicationSchema, &version); err != nil {
		return ErrManagementUnavailable
	}
	expectedSchema := sha256.Sum256([]byte(applicationSchema))
	if version != 1 || nodeID != a.nodeID || a.schema != "vm2api_node_"+hex.EncodeToString(expectedSchema[:16]) {
		return ErrManagementDenied
	}
	tx, err := connection.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return ErrManagementUnavailable
	}
	defer func() {
		rollback, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		tx.Rollback(rollback)
	}()
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock_shared(hashtext($1),hashtext($2))",
		"vm2api:node-management:"+a.schema, "node:"+a.nodeID+":vm:"+intent.VMID); err != nil {
		return ErrManagementUnavailable
	}
	var epoch, digest string
	err = tx.QueryRow(ctx, "SELECT epoch::text,intent_digest FROM "+q+".authorized_commands WHERE allocation_id=$1 AND node_id=$2 AND vm_id=$3 AND operation_id=$4 AND owner_id=$5 AND command_id=$6 AND action=$7",
		intent.AllocationID, intent.NodeID, intent.VMID, intent.OperationID, intent.OwnerID, intent.CommandID, intent.Action).Scan(&epoch, &digest)
	if err == pgx.ErrNoRows {
		return ErrManagementDenied
	}
	if err != nil {
		return ErrManagementUnavailable
	}
	if epoch != intent.Epoch || digest != intent.digest() {
		return ErrManagementDenied
	}
	if ctx.Err() != nil {
		return ErrManagementUnavailable
	}
	// Only bounded local journal I/O belongs in dispatch. Never Docker or an
	// outbound RPC. A failed COMMIT cannot acknowledge a local receipt.
	if err = dispatch(); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return ErrManagementUnavailable
	}
	return nil
}
