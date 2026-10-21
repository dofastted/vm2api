package slotgate

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"github.com/jackc/pgx/v5"
	"time"
)

// Refresh authorization is independently installed; no allocation/launch grant is accepted.
func (a *pgAllocationAuthorizer) AuthorizeRefresh(ctx context.Context, intent RefreshIntent, dispatch func() error) error {
	if intent.NodeID != a.nodeID || !validRefreshIntent(intent) {
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
	err = tx.QueryRow(ctx, "SELECT epoch::text,intent_digest FROM "+q+".authorized_refreshes WHERE allocation_id=$1 AND node_id=$2 AND vm_id=$3 AND operation_id=$4 AND owner_id=$5 AND command_id=$6 AND account_id=$7 AND bg_task_key=$8 AND bg_execution_id=$9 AND bg_owner_id=$10 AND expected_generation=$11",
		intent.AllocationID, intent.NodeID, intent.VMID, intent.OperationID, intent.OwnerID, intent.CommandID, intent.AccountID, intent.BGTaskKey, intent.BGExecutionID, intent.BGOwnerID, intent.ExpectedGeneration).Scan(&epoch, &digest)
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
