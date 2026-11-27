use compact_str::CompactString;
use scheduler_core::delta::DirtyDeltaRing;
use scheduler_core::events::{EVENT_RING_CAPACITY, EventRingBuffer};
use scheduler_core::{EngineOptions, SchedulerEngine};
use scheduler_proto::*;

fn sample_sticky(id: &str, node: &str, generation: u64) -> StickyBindingDto {
    let now = scheduler_core::now_ms();
    StickyBindingDto {
        scope_kind: StickyScopeKind::Machine,
        pool_id: CompactString::const_new("pool_1"),
        model_family: ModelFamily::Claude,
        identity_id: CompactString::from(id),
        node_key: CompactString::from(format!("claude_vm:{node}")),
        node_type: NodeType::ClaudeVm,
        node_id: CompactString::from(node),
        machine_id: Some(CompactString::from(id)),
        stood_in: false,
        bound_at_ms: now,
        last_seen_ms: now,
        expires_at_ms: now + 604_800_000,
        hits: generation,
        generation,
    }
}

#[test]
fn dirty_delta_ring_deduplicates_updates_to_same_key() {
    let ring = DirtyDeltaRing::new();
    ring.record_sticky_upsert(sample_sticky("m1", "vm1", 1));
    ring.record_sticky_upsert(sample_sticky("m1", "vm2", 2));
    ring.record_sticky_upsert(sample_sticky("m1", "vm3", 3));

    assert_eq!(ring.pending_count(), 1);
    let d = ring.drain(100, None, false);
    assert_eq!(d.sticky_upserts.len(), 1);
    assert_eq!(d.sticky_upserts[0].node_key, "claude_vm:vm3");
    assert_eq!(d.sticky_upserts[0].generation, 3);
}

#[test]
fn dirty_delta_ring_retains_unacked_batch_on_db_write_failure() {
    let ring = DirtyDeltaRing::new();
    ring.record_sticky_upsert(sample_sticky("m1", "vm1", 1));

    let d1 = ring.drain(100, None, false);
    assert!(d1.batch_id.is_some());
    assert_eq!(d1.sticky_upserts.len(), 1);

    // Simulate DB write failure: next drain does NOT send ack_batch_id!
    let d2 = ring.drain(100, None, false);
    assert_eq!(d2.sticky_upserts.len(), 1);
    assert_eq!(d2.sticky_upserts[0].identity_id, "m1");

    // Now ACK d2 -> pending becomes 0!
    let d3 = ring.drain(100, d2.batch_id, true);
    assert_eq!(d3.remaining, 0);
    assert_eq!(ring.pending_count(), 0);
}

#[test]
fn dirty_delta_ring_ack_preserves_newer_mutation_made_during_inflight_drain() {
    let ring = DirtyDeltaRing::new();
    ring.record_sticky_upsert(sample_sticky("m1", "vm1", 1));
    ring.record_sticky_upsert(sample_sticky("m2", "vm1", 1));

    let d1 = ring.drain(100, None, false);
    assert_eq!(d1.sticky_upserts.len(), 2);

    // While Node is persisting d1, m1 is updated again to vm2!
    ring.record_sticky_upsert(sample_sticky("m1", "vm2", 2));

    // ACK d1: m2 is removed, but m1 MUST remain with its newer vm2 value!
    let d2 = ring.drain(100, d1.batch_id, false);
    assert_eq!(d2.sticky_upserts.len(), 1);
    assert_eq!(d2.sticky_upserts[0].identity_id, "m1");
    assert_eq!(d2.sticky_upserts[0].node_key, "claude_vm:vm2");
}

#[test]
fn standby_role_strictly_forbids_persistence_drain() {
    let eng = SchedulerEngine::new(EngineOptions::default());
    eng.bootstrap(BootstrapRequest {
        controller_epoch: CompactString::const_new("ep_sb"),
        role: Role::Standby,
        config_version: Some(1),
        config_snapshot: ConfigSnapshot::default(),
        active_sticky_bindings: vec![],
        active_penalties: vec![],
        initial_telemetry: vec![],
    });

    let err = eng
        .drain_persistence(DrainRequest::default())
        .err()
        .unwrap();
    assert_eq!(err.code(), ErrorCode::StandbyDrainForbidden);
    assert_eq!(err.http_status_code(), 403);
}

#[test]
fn bootstrap_hydrates_live_sticky_without_dirtying_and_skips_expired() {
    let eng = SchedulerEngine::new(EngineOptions::default());
    let now = scheduler_core::now_ms();
    let mut expired = sample_sticky("m_old", "vm1", 1);
    expired.expires_at_ms = now.saturating_sub(1_000);
    let live = sample_sticky("m_live", "vm1", 1);

    let resp = eng.bootstrap(BootstrapRequest {
        controller_epoch: CompactString::const_new("ep1"),
        role: Role::Leader,
        config_version: Some(1),
        config_snapshot: ConfigSnapshot::default(),
        active_sticky_bindings: vec![expired, live],
        active_penalties: vec![],
        initial_telemetry: vec![],
    });
    assert_eq!(resp.sticky_loaded, 1);
    assert_eq!(
        eng.health().dirty_deltas,
        0,
        "hydration must not mark dirty"
    );

    let list = eng.query_sticky(&StickyQuery::default());
    assert_eq!(list.total, 1);
    assert_eq!(list.bindings[0].identity_id, "m_live");
}

#[test]
fn delete_sticky_filters_accurately_and_emits_delete_deltas() {
    let eng = SchedulerEngine::new(EngineOptions::default());
    let mut s2 = sample_sticky("m2", "vm2", 1);
    s2.pool_id = CompactString::const_new("pool_2");

    eng.bootstrap(BootstrapRequest {
        controller_epoch: CompactString::const_new("ep1"),
        role: Role::Leader,
        config_version: Some(1),
        config_snapshot: ConfigSnapshot::default(),
        active_sticky_bindings: vec![sample_sticky("m1", "vm1", 1), s2],
        active_penalties: vec![],
        initial_telemetry: vec![],
    });

    let del = eng.delete_sticky(&StickyQuery {
        pool_id: Some(CompactString::const_new("pool_1")),
        scope_kind: Some(StickyScopeKind::Machine),
        ..Default::default()
    });
    assert_eq!(del.deleted, 1);
    assert_eq!(eng.query_sticky(&StickyQuery::default()).total, 1);

    let drained = eng.drain_persistence(DrainRequest::default()).unwrap();
    assert_eq!(drained.sticky_deletes.len(), 1);
    assert_eq!(drained.sticky_deletes[0].identity_id, "m1");
}

#[test]
fn sync_config_is_monotonic_and_idempotent() {
    let eng = SchedulerEngine::new(EngineOptions::default());
    eng.bootstrap(BootstrapRequest {
        controller_epoch: CompactString::const_new("ep1"),
        role: Role::Leader,
        config_version: Some(5),
        config_snapshot: ConfigSnapshot {
            config_version: 5,
            ..Default::default()
        },
        active_sticky_bindings: vec![],
        active_penalties: vec![],
        initial_telemetry: vec![],
    });

    let stale = eng.sync_config(ConfigSyncRequest {
        config_version: 4,
        config_snapshot: ConfigSnapshot::default(),
    });
    assert!(!stale.applied);
    assert_eq!(stale.config_version, 5);

    let same = eng.sync_config(ConfigSyncRequest {
        config_version: 5,
        config_snapshot: ConfigSnapshot::default(),
    });
    assert!(!same.applied);
    assert_eq!(same.config_version, 5);

    let newer = eng.sync_config(ConfigSyncRequest {
        config_version: 6,
        config_snapshot: ConfigSnapshot::default(),
    });
    assert!(newer.applied);
    assert_eq!(newer.config_version, 6);
}

#[test]
fn event_ring_replays_within_512_window() {
    let ring = EventRingBuffer::new("ep1");
    for i in 1..=10 {
        ring.emit(
            SchedulerEventKind::LeaseAcquired,
            None,
            None,
            Some(CompactString::from(format!("req_{i}"))),
            None,
        );
    }

    let (replay, _rx) = ring.subscribe(Some("ep1:7")).unwrap();
    assert_eq!(replay.len(), 3);
    assert_eq!(replay[0].seq, 8);
    assert_eq!(replay[2].seq, 10);

    let (caught_up, _) = ring.subscribe(Some("ep1:10")).unwrap();
    assert!(caught_up.is_empty());
}

#[test]
fn event_ring_returns_409_snapshot_required_when_evicted() {
    let ring = EventRingBuffer::new("ep1");
    for _ in 0..(EVENT_RING_CAPACITY + 20) {
        ring.emit(SchedulerEventKind::LeaseAcquired, None, None, None, None);
    }

    // seq 5 has been evicted (oldest is 21) -> must return 409 SnapshotRequired!
    let err = ring.subscribe(Some("ep1:5")).err().unwrap();
    assert_eq!(err.code(), ErrorCode::SnapshotRequired);
    assert_eq!(err.http_status_code(), 409);

    // seq 20 is right before oldest=21, so zero events missed -> valid!
    let (replay, _) = ring.subscribe(Some("ep1:20")).unwrap();
    assert_eq!(replay.len(), EVENT_RING_CAPACITY);
}

#[test]
fn event_ring_returns_409_on_epoch_mismatch_or_bad_cursor() {
    let ring = EventRingBuffer::new("ep2");
    ring.emit(SchedulerEventKind::Bootstrap, None, None, None, None);

    assert_eq!(
        ring.subscribe(Some("ep1:1")).err().unwrap().code(),
        ErrorCode::SnapshotRequired
    );
    assert_eq!(
        ring.subscribe(Some("malformed")).err().unwrap().code(),
        ErrorCode::SnapshotRequired
    );
    assert_eq!(
        ring.subscribe(Some("ep2:999")).err().unwrap().code(),
        ErrorCode::SnapshotRequired
    );
}
