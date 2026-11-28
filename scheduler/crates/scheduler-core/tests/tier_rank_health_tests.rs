use compact_str::CompactString;
use scheduler_core::{EngineOptions, SchedulerEngine};
use scheduler_proto::*;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

fn node_cfg(
    key: &str,
    id: &str,
    tier: u16,
    sub_weight: u32,
    max_conc: u32,
    max_sess: u32,
) -> BackendNodeConfig {
    BackendNodeConfig {
        node_key: CompactString::from(key),
        node_type: NodeType::ClaudeVm,
        node_id: CompactString::from(id),
        provider: Provider::Anthropic,
        protocol: None,
        owner_id: None,
        plan_tier: None,
        weight_tier_mode: WeightTierMode::Manual,
        weight_tier: tier,
        auto_weight_tier: None,
        sub_weight,
        supported_models: vec![],
        capacity: NodeCapacityConfig {
            max_concurrency: max_conc,
            max_sessions: max_sess,
            ..Default::default()
        },
        enabled: true,
        temp_unschedulable_until_ms: None,
        temp_unschedulable_reason: None,
    }
}

fn member(key: &str, id: &str, role: MemberRole, order: i32) -> PoolMemberConfig {
    PoolMemberConfig {
        node_key: CompactString::from(key),
        node_type: NodeType::ClaudeVm,
        node_id: CompactString::from(id),
        enabled: true,
        member_role: role,
        weight_tier_override: None,
        sub_weight_override: None,
        member_order: order,
    }
}

fn req(req_id: &str, pool_id: &str, model: &str, sid: &str) -> AcquireRequest {
    AcquireRequest {
        request_id: CompactString::from(req_id),
        attempt_no: 1,
        controller_epoch: CompactString::const_new("ep1"),
        min_config_version: 1,
        origin_pool_id: CompactString::from(pool_id),
        jev_downgrade_pool_id: None,
        api_key_scope: ApiKeyScope {
            api_key_id: CompactString::const_new("k1"),
            pool_binding_mode: PoolBindingMode::StrictPool,
            default_pool_id: Some(CompactString::from(pool_id)),
            allowed_pool_ids: vec![CompactString::from(pool_id)],
            ..Default::default()
        },
        model: CompactString::from(model),
        model_family: ModelFamily::Claude,
        protocol: CompactString::const_new("anthropic"),
        machine_id: None,
        session_id: CompactString::from(sid),
        session_id_source: None,
        parent_session_id: None,
        is_ephemeral_probe: false,
        no_queue: false,
        is_admin_diagnostic: false,
        pin_node_key: None,
        exclude_nodes: vec![],
    }
}

fn release_ok(eng: &SchedulerEngine, lid: &str) {
    eng.release(ReleaseRequest {
        lease_id: CompactString::from(lid),
        outcome: ReleaseOutcome::Ok,
        http_status: None,
        error_class: None,
        error_signature: None,
        error_message: None,
        retry_after_sec: None,
        ttft_ms: None,
        tokens_used: None,
        quota_headers: None,
    });
}

fn boot_pool(
    opts: EngineOptions,
    pool: PoolConfig,
    nodes: Vec<BackendNodeConfig>,
    telemetry: Vec<NodeTelemetryUpdate>,
) -> Arc<SchedulerEngine> {
    let eng = Arc::new(SchedulerEngine::new(opts));
    eng.bootstrap(BootstrapRequest {
        controller_epoch: CompactString::const_new("ep1"),
        role: Role::Leader,
        config_version: Some(1),
        config_snapshot: ConfigSnapshot {
            config_version: 1,
            pools: vec![pool],
            nodes,
            ..Default::default()
        },
        active_sticky_bindings: vec![],
        active_penalties: vec![],
        initial_telemetry: telemetry,
    });
    eng
}

#[tokio::test]
async fn active_strictly_beats_standby_even_with_lower_tier() {
    let pool = PoolConfig {
        id: CompactString::const_new("p1"),
        members: vec![
            member("claude_vm:sb", "sb", MemberRole::Standby, 1),
            member("claude_vm:act", "act", MemberRole::Active, 2),
        ],
        ..Default::default()
    };
    let eng = boot_pool(
        EngineOptions::default(),
        pool,
        vec![
            node_cfg("claude_vm:sb", "sb", 10, 100, 4, 4),
            node_cfg("claude_vm:act", "act", 1, 1, 1, 1),
        ],
        vec![],
    );

    let r1 = eng.acquire(req("r1", "p1", "m", "s1")).await.unwrap();
    assert_eq!(r1.selected_node.node_key, "claude_vm:act");

    // Once active is full, standby takes overflow
    let r2 = eng.acquire(req("r2", "p1", "m", "s2")).await.unwrap();
    assert_eq!(r2.selected_node.node_key, "claude_vm:sb");

    release_ok(&eng, &r1.lease_id);
    release_ok(&eng, &r2.lease_id);
}

#[tokio::test]
async fn strict_effective_weight_tier_descending_order() {
    let pool = PoolConfig {
        id: CompactString::const_new("p1"),
        members: vec![
            member("claude_vm:t3", "t3", MemberRole::Active, 1),
            member("claude_vm:t9", "t9", MemberRole::Active, 2),
            member("claude_vm:t6", "t6", MemberRole::Active, 3),
        ],
        ..Default::default()
    };
    let eng = boot_pool(
        EngineOptions::default(),
        pool,
        vec![
            node_cfg("claude_vm:t3", "t3", 3, 100, 1, 1),
            node_cfg("claude_vm:t9", "t9", 9, 1, 1, 1),
            node_cfg("claude_vm:t6", "t6", 6, 10, 1, 1),
        ],
        vec![],
    );

    let r1 = eng.acquire(req("r1", "p1", "m", "s1")).await.unwrap();
    let r2 = eng.acquire(req("r2", "p1", "m", "s2")).await.unwrap();
    let r3 = eng.acquire(req("r3", "p1", "m", "s3")).await.unwrap();
    assert_eq!(r1.selected_node.node_key, "claude_vm:t9");
    assert_eq!(r2.selected_node.node_key, "claude_vm:t6");
    assert_eq!(r3.selected_node.node_key, "claude_vm:t3");

    release_ok(&eng, &r1.lease_id);
    release_ok(&eng, &r2.lease_id);
    release_ok(&eng, &r3.lease_id);
}

#[tokio::test]
async fn member_weight_override_and_auto_7d_reset_tier() {
    let mut m1 = member("claude_vm:v1", "v1", MemberRole::Active, 1);
    m1.weight_tier_override = Some(9);
    let m2 = member("claude_vm:v2", "v2", MemberRole::Active, 2);

    let mut n2 = node_cfg("claude_vm:v2", "v2", 2, 10, 4, 4);
    n2.weight_tier_mode = WeightTierMode::Auto7dReset;
    n2.auto_weight_tier = Some(7);

    let pool = PoolConfig {
        id: CompactString::const_new("p1"),
        members: vec![m1, m2],
        ..Default::default()
    };
    let eng = boot_pool(
        EngineOptions::default(),
        pool,
        vec![node_cfg("claude_vm:v1", "v1", 2, 10, 4, 4), n2],
        vec![],
    );

    let exp = eng.explain(req("e1", "p1", "m", "s1")).await.unwrap();
    assert_eq!(exp.explain.order[0].node, "claude_vm:v1");
    assert_eq!(exp.explain.order[0].tier, 9);
    assert_eq!(exp.explain.order[1].node, "claude_vm:v2");
    assert_eq!(exp.explain.order[1].tier, 7);
}

#[tokio::test]
async fn health_sub_buckets_order_healthy_before_soft_quota_before_sunk() {
    let pool = PoolConfig {
        id: CompactString::const_new("p1"),
        members: vec![
            member("claude_vm:sunk", "sunk", MemberRole::Active, 1),
            member("claude_vm:soft", "soft", MemberRole::Active, 2),
            member("claude_vm:ok", "ok", MemberRole::Active, 3),
        ],
        ..Default::default()
    };
    let eng = boot_pool(
        EngineOptions::default(),
        pool,
        vec![
            node_cfg("claude_vm:sunk", "sunk", 8, 100, 4, 4),
            node_cfg("claude_vm:soft", "soft", 8, 100, 4, 4),
            node_cfg("claude_vm:ok", "ok", 8, 1, 4, 4),
        ],
        vec![NodeTelemetryUpdate {
            node_key: CompactString::const_new("claude_vm:soft"),
            quota_util_5h_pct: Some(88.0),
            ..Default::default()
        }],
    );

    // Trigger 429 Sink on `sunk` via acquire + release(429)
    let mut r_pin = req("r_pin", "p1", "m", "s_pin");
    r_pin.is_admin_diagnostic = true;
    r_pin.pin_node_key = Some(CompactString::const_new("claude_vm:sunk"));
    let p_lease = eng.acquire(r_pin).await.unwrap();
    eng.release(ReleaseRequest {
        lease_id: p_lease.lease_id,
        outcome: ReleaseOutcome::Error,
        http_status: Some(429),
        error_class: Some(ErrorClass::RateLimit429),
        error_signature: None,
        error_message: Some("rate limited".to_owned()),
        retry_after_sec: Some(1),
        ttft_ms: None,
        tokens_used: None,
        quota_headers: None,
    });

    // Even across 10 consecutive acquires, SWRR MUST NEVER rotate soft(1) or sunk(2) ahead of ok(0)!
    for i in 0..10 {
        let r = eng
            .acquire(req(&format!("r_{i}"), "p1", "m", &format!("s_{i}")))
            .await
            .unwrap();
        assert_eq!(r.selected_node.node_key, "claude_vm:ok");
        assert_eq!(r.explain.order[0].sub_bucket, 0);
        assert_eq!(r.explain.order[1].sub_bucket, 1);
        assert_eq!(r.explain.order[2].sub_bucket, 2);
        assert!(r.explain.order[2].sunk);
        release_ok(&eng, &r.lease_id);
    }
}

#[tokio::test]
async fn swrr_distributes_proportionally_by_sub_weight() {
    let pool = PoolConfig {
        id: CompactString::const_new("p1"),
        members: vec![
            member("claude_vm:a", "a", MemberRole::Active, 1),
            member("claude_vm:b", "b", MemberRole::Active, 2),
        ],
        ..Default::default()
    };
    let eng = boot_pool(
        EngineOptions::default(),
        pool,
        vec![
            node_cfg("claude_vm:a", "a", 8, 30, 8, 8),
            node_cfg("claude_vm:b", "b", 8, 10, 8, 8),
        ],
        vec![],
    );

    let mut counts: HashMap<String, usize> = HashMap::new();
    for i in 0..40 {
        let r = eng
            .acquire(req(&format!("r_{i}"), "p1", "m", &format!("s_{i}")))
            .await
            .unwrap();
        *counts
            .entry(r.selected_node.node_key.to_string())
            .or_insert(0) += 1;
        release_ok(&eng, &r.lease_id);
    }
    assert_eq!(counts["claude_vm:a"], 30);
    assert_eq!(counts["claude_vm:b"], 10);
}

#[tokio::test]
async fn explain_dry_run_never_mutates_swrr_or_inflight() {
    let pool = PoolConfig {
        id: CompactString::const_new("p1"),
        members: vec![
            member("claude_vm:a", "a", MemberRole::Active, 1),
            member("claude_vm:b", "b", MemberRole::Active, 2),
        ],
        ..Default::default()
    };
    let eng = boot_pool(
        EngineOptions::default(),
        pool,
        vec![
            node_cfg("claude_vm:a", "a", 8, 10, 4, 4),
            node_cfg("claude_vm:b", "b", 8, 10, 4, 4),
        ],
        vec![],
    );

    let first = eng
        .explain(req("e0", "p1", "m", "s0"))
        .await
        .unwrap()
        .selected_node
        .unwrap()
        .node_key;

    for i in 1..10 {
        let again = eng
            .explain(req(&format!("e{i}"), "p1", "m", &format!("s{i}")))
            .await
            .unwrap()
            .selected_node
            .unwrap()
            .node_key;
        assert_eq!(again, first, "dry-run explain must not advance SWRR cursor");
    }
    assert_eq!(eng.node_inflight("claude_vm:a"), 0);
    assert_eq!(eng.node_inflight("claude_vm:b"), 0);
    assert_eq!(eng.health().active_leases, 0);
}

#[tokio::test]
async fn move_round_compensates_swrr_for_sticky_hits_and_clamps_overflow() {
    let pool = PoolConfig {
        id: CompactString::const_new("p1"),
        members: vec![
            member("claude_vm:a", "a", MemberRole::Active, 1),
            member("claude_vm:b", "b", MemberRole::Active, 2),
        ],
        ..Default::default()
    };
    let eng = boot_pool(
        EngineOptions::default(),
        pool,
        vec![
            node_cfg("claude_vm:a", "a", 8, 10, 8, 8),
            node_cfg("claude_vm:b", "b", 8, 10, 8, 8),
        ],
        vec![],
    );

    // Bind session s_sticky to node `a`
    let r0 = eng.acquire(req("r0", "p1", "m", "s_sticky")).await.unwrap();
    assert_eq!(r0.selected_node.node_key, "claude_vm:a");
    eng.commit(CommitRequest {
        lease_id: r0.lease_id.clone(),
    });
    release_ok(&eng, &r0.lease_id);

    // Hammer sticky hits on `a` 5 times -> MoveRound shifts SWRR credit to `b`!
    for i in 1..=5 {
        let r = eng
            .acquire(req(&format!("st_{i}"), "p1", "m", "s_sticky"))
            .await
            .unwrap();
        assert_eq!(r.selected_node.node_key, "claude_vm:a");
        assert_eq!(r.explain.affinity.why, Some(AffinityWhy::SessionHit));
        release_ok(&eng, &r.lease_id);
    }

    // Next fresh sessions MUST pick `b` multiple times to rebalance credit!
    let mut b_picks = 0;
    for i in 0..4 {
        let r = eng
            .acquire(req(&format!("new_{i}"), "p1", "m", &format!("s_new_{i}")))
            .await
            .unwrap();
        if r.selected_node.node_key == "claude_vm:b" {
            b_picks += 1;
        }
        release_ok(&eng, &r.lease_id);
    }
    assert!(
        b_picks >= 3,
        "MoveRound should bias new sessions to node b (got {b_picks}/4)"
    );
}

#[tokio::test]
async fn fill_ordered_and_balanced_intra_tier_strategies() {
    // 1. Fill: prefers loaded node that still has free capacity
    let pool_fill = PoolConfig {
        id: CompactString::const_new("p_fill"),
        intra_tier_strategy: IntraTierStrategy::Fill,
        members: vec![
            member("claude_vm:a", "a", MemberRole::Active, 1),
            member("claude_vm:b", "b", MemberRole::Active, 2),
        ],
        ..Default::default()
    };
    let eng_fill = boot_pool(
        EngineOptions::default(),
        pool_fill,
        vec![
            node_cfg("claude_vm:a", "a", 8, 10, 4, 4),
            node_cfg("claude_vm:b", "b", 8, 10, 4, 4),
        ],
        vec![],
    );
    let rf1 = eng_fill
        .acquire(req("f1", "p_fill", "m", "s1"))
        .await
        .unwrap();
    let rf2 = eng_fill
        .acquire(req("f2", "p_fill", "m", "s2"))
        .await
        .unwrap();
    assert_eq!(rf1.selected_node.node_key, "claude_vm:a");
    assert_eq!(
        rf2.selected_node.node_key, "claude_vm:a",
        "Fill should pack node a first"
    );
    release_ok(&eng_fill, &rf1.lease_id);
    release_ok(&eng_fill, &rf2.lease_id);

    // 2. Ordered: strictly respects member_order ascending
    let pool_ord = PoolConfig {
        id: CompactString::const_new("p_ord"),
        intra_tier_strategy: IntraTierStrategy::Ordered,
        members: vec![
            member("claude_vm:second", "second", MemberRole::Active, 20),
            member("claude_vm:first", "first", MemberRole::Active, 5),
        ],
        ..Default::default()
    };
    let eng_ord = boot_pool(
        EngineOptions::default(),
        pool_ord,
        vec![
            node_cfg("claude_vm:second", "second", 8, 10, 4, 4),
            node_cfg("claude_vm:first", "first", 8, 10, 4, 4),
        ],
        vec![],
    );
    let ro1 = eng_ord
        .acquire(req("o1", "p_ord", "m", "s1"))
        .await
        .unwrap();
    assert_eq!(ro1.selected_node.node_key, "claude_vm:first");
    release_ok(&eng_ord, &ro1.lease_id);

    // 3. Balanced: picks lowest load ratio
    let pool_bal = PoolConfig {
        id: CompactString::const_new("p_bal"),
        intra_tier_strategy: IntraTierStrategy::Balanced,
        members: vec![
            member("claude_vm:a", "a", MemberRole::Active, 1),
            member("claude_vm:b", "b", MemberRole::Active, 2),
        ],
        ..Default::default()
    };
    let eng_bal = boot_pool(
        EngineOptions::default(),
        pool_bal,
        vec![
            node_cfg("claude_vm:a", "a", 8, 10, 4, 4),
            node_cfg("claude_vm:b", "b", 8, 10, 4, 4),
        ],
        vec![],
    );
    let rb1 = eng_bal
        .acquire(req("b1", "p_bal", "m", "s1"))
        .await
        .unwrap();
    let rb2 = eng_bal
        .acquire(req("b2", "p_bal", "m", "s2"))
        .await
        .unwrap();
    assert_ne!(rb1.selected_node.node_key, rb2.selected_node.node_key);
    release_ok(&eng_bal, &rb1.lease_id);
    release_ok(&eng_bal, &rb2.lease_id);
}

#[tokio::test]
async fn full_pool_bounded_queue_reincludes_spill_exclude_and_enforces_queue_max() {
    // Single-node pool with cap 1 and queue_max = 1:
    // Also exercises spill_exclude re-inclusion when machine home is the only node!
    let pool = PoolConfig {
        id: CompactString::const_new("p1"),
        queue_wait_ms: 1_500,
        queue_max: 1,
        members: vec![member("claude_vm:only", "only", MemberRole::Active, 1)],
        ..Default::default()
    };
    let eng = boot_pool(
        EngineOptions::default(),
        pool,
        vec![node_cfg("claude_vm:only", "only", 8, 10, 1, 1)],
        vec![],
    );

    let mut r1_req = req("r1", "p1", "m", "s1");
    r1_req.machine_id = Some(CompactString::const_new("m1"));
    let r1 = eng.acquire(r1_req).await.unwrap();
    eng.commit(CommitRequest {
        lease_id: r1.lease_id.clone(),
    });

    // S2 on same machine m1 hits MachineHomeCapacitySpill -> spill_exclude=[only] -> enters
    // full-pool queue which RE-INCLUDES `only`!
    let eng2 = Arc::clone(&eng);
    let h2 = tokio::spawn(async move {
        let mut r2_req = req("r2", "p1", "m", "s2");
        r2_req.machine_id = Some(CompactString::const_new("m1"));
        eng2.acquire(r2_req).await
    });

    tokio::time::sleep(Duration::from_millis(25)).await;

    // S3 exceeds queue_max=1 -> immediately 429 PoolQueueFull!
    let err3 = eng.acquire(req("r3", "p1", "m", "s3")).await.err().unwrap();
    assert_eq!(err3.code(), ErrorCode::PoolQueueFull);
    assert_eq!(err3.http_status_code(), 429);

    // Release S1 -> S2 steals slot immediately via Notify!
    release_ok(&eng, &r1.lease_id);
    let r2 = tokio::time::timeout(Duration::from_secs(1), h2)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(r2.selected_node.node_key, "claude_vm:only");
    assert_eq!(
        r2.explain.affinity.why,
        Some(AffinityWhy::PoolFullQueueWake)
    );
    release_ok(&eng, &r2.lease_id);
}

#[tokio::test]
async fn max_rpm_enforced_within_60s_window() {
    let mut n1 = node_cfg("claude_vm:n1", "n1", 9, 10, 8, 8);
    n1.capacity.max_rpm = Some(2);
    let n2 = node_cfg("claude_vm:n2", "n2", 5, 10, 8, 8);

    let pool = PoolConfig {
        id: CompactString::const_new("p1"),
        members: vec![
            member("claude_vm:n1", "n1", MemberRole::Active, 1),
            member("claude_vm:n2", "n2", MemberRole::Active, 2),
        ],
        ..Default::default()
    };
    let eng = boot_pool(EngineOptions::default(), pool, vec![n1, n2], vec![]);

    for i in 0..2 {
        let r = eng
            .acquire(req(&format!("r{i}"), "p1", "m", &format!("s{i}")))
            .await
            .unwrap();
        assert_eq!(r.selected_node.node_key, "claude_vm:n1");
        release_ok(&eng, &r.lease_id);
    }

    // 3rd request hits n1 max_rpm=2 -> routes to n2!
    let r3 = eng.acquire(req("r3", "p1", "m", "s3")).await.unwrap();
    assert_eq!(r3.selected_node.node_key, "claude_vm:n2");
    release_ok(&eng, &r3.lease_id);
}

#[tokio::test]
async fn telemetry_updates_in_place_without_bumping_config_version_and_honors_external_inflight() {
    let pool = PoolConfig {
        id: CompactString::const_new("p1"),
        members: vec![
            member("claude_vm:n1", "n1", MemberRole::Active, 1),
            member("claude_vm:n2", "n2", MemberRole::Active, 2),
        ],
        ..Default::default()
    };
    let eng = boot_pool(
        EngineOptions::default(),
        pool,
        vec![
            node_cfg("claude_vm:n1", "n1", 9, 10, 2, 4),
            node_cfg("claude_vm:n2", "n2", 5, 10, 4, 4),
        ],
        vec![],
    );

    let ver_before = eng.health().config_version;
    // Simulate blue/green handover-load.json filling n1 externally (2/2)
    eng.update_telemetry(TelemetryBatchRequest {
        nodes: vec![NodeTelemetryUpdate {
            node_key: CompactString::const_new("claude_vm:n1"),
            external_in_flight: Some(2),
            ..Default::default()
        }],
    });
    assert_eq!(
        eng.health().config_version,
        ver_before,
        "telemetry must NOT bump config_version"
    );

    let r = eng.acquire(req("r1", "p1", "m", "s1")).await.unwrap();
    assert_eq!(r.selected_node.node_key, "claude_vm:n2");
    release_ok(&eng, &r.lease_id);
}

#[tokio::test]
async fn request_faults_never_cool_or_sink_node() {
    let pool = PoolConfig {
        id: CompactString::const_new("p1"),
        members: vec![member("claude_vm:n1", "n1", MemberRole::Active, 1)],
        ..Default::default()
    };
    let eng = boot_pool(
        EngineOptions::default(),
        pool,
        vec![node_cfg("claude_vm:n1", "n1", 8, 10, 4, 4)],
        vec![],
    );

    for (idx, cls) in [
        ErrorClass::JevBlocked,
        ErrorClass::Refusal,
        ErrorClass::ContextTooLong,
        ErrorClass::Client4xx,
    ]
    .iter()
    .enumerate()
    {
        let r = eng
            .acquire(req(&format!("r{idx}"), "p1", "m", &format!("s{idx}")))
            .await
            .unwrap();
        eng.release(ReleaseRequest {
            lease_id: r.lease_id,
            outcome: ReleaseOutcome::Error,
            http_status: Some(400),
            error_class: Some(*cls),
            error_signature: None,
            error_message: Some("bad prompt".to_owned()),
            retry_after_sec: None,
            ttft_ms: None,
            tokens_used: None,
            quota_headers: None,
        });
    }

    let (cd, sink, perm, fails) = eng.node_health_snapshot("claude_vm:n1");
    assert_eq!((cd, sink, perm, fails), (0, 0, false, 0));
}

#[tokio::test]
async fn model_level_cooldown_only_blocks_failed_model_not_other_models() {
    let pool = PoolConfig {
        id: CompactString::const_new("p1"),
        members: vec![
            member("claude_vm:n1", "n1", MemberRole::Active, 1),
            member("claude_vm:n2", "n2", MemberRole::Active, 2),
        ],
        ..Default::default()
    };
    let eng = boot_pool(
        EngineOptions::default(),
        pool,
        vec![
            node_cfg("claude_vm:n1", "n1", 9, 10, 4, 4),
            node_cfg("claude_vm:n2", "n2", 5, 10, 4, 4),
        ],
        vec![],
    );

    let r1 = eng
        .acquire(req("r1", "p1", "claude-opus-4", "s1"))
        .await
        .unwrap();
    assert_eq!(r1.selected_node.node_key, "claude_vm:n1");

    // 529 cools ONLY (n1, claude-opus-4)
    eng.release(ReleaseRequest {
        lease_id: r1.lease_id,
        outcome: ReleaseOutcome::Error,
        http_status: Some(529),
        error_class: Some(ErrorClass::Overloaded529),
        error_signature: None,
        error_message: Some("overloaded".to_owned()),
        retry_after_sec: Some(30),
        ttft_ms: None,
        tokens_used: None,
        quota_headers: None,
    });

    // opus routes to n2
    let r_opus = eng
        .acquire(req("r2", "p1", "claude-opus-4", "s2"))
        .await
        .unwrap();
    assert_eq!(r_opus.selected_node.node_key, "claude_vm:n2");

    // sonnet STILL routes to high-tier n1!
    let r_sonnet = eng
        .acquire(req("r3", "p1", "claude-sonnet-4", "s3"))
        .await
        .unwrap();
    assert_eq!(r_sonnet.selected_node.node_key, "claude_vm:n1");

    release_ok(&eng, &r_opus.lease_id);
    release_ok(&eng, &r_sonnet.lease_id);
}

#[tokio::test]
async fn long_node_cooldown_and_permanent_ban_persist_to_delta_ring() {
    let pool = PoolConfig {
        id: CompactString::const_new("p1"),
        members: vec![
            member("claude_vm:n1", "n1", MemberRole::Active, 1),
            member("claude_vm:n2", "n2", MemberRole::Active, 2),
        ],
        ..Default::default()
    };
    let eng = boot_pool(
        EngineOptions::default(),
        pool,
        vec![
            node_cfg("claude_vm:n1", "n1", 9, 10, 4, 4),
            node_cfg("claude_vm:n2", "n2", 5, 10, 4, 4),
        ],
        vec![],
    );

    let r1 = eng.acquire(req("r1", "p1", "m", "s1")).await.unwrap();
    eng.release(ReleaseRequest {
        lease_id: r1.lease_id,
        outcome: ReleaseOutcome::Error,
        http_status: Some(401),
        error_class: Some(ErrorClass::QuotaExhausted),
        error_signature: None,
        error_message: None,
        retry_after_sec: Some(120), // > 60s -> persisted
        ttft_ms: None,
        tokens_used: None,
        quota_headers: None,
    });

    let drained = eng.drain_persistence(DrainRequest::default()).unwrap();
    assert_eq!(drained.penalty_upserts.len(), 1);
    assert_eq!(drained.penalty_upserts[0].node_key, "claude_vm:n1");
    assert_eq!(drained.penalty_upserts[0].model_scope, "*");

    // PermanentBan on n2
    let r2 = eng.acquire(req("r2", "p1", "m", "s2")).await.unwrap();
    assert_eq!(r2.selected_node.node_key, "claude_vm:n2");
    eng.release(ReleaseRequest {
        lease_id: r2.lease_id,
        outcome: ReleaseOutcome::Error,
        http_status: Some(403),
        error_class: Some(ErrorClass::PermanentBan),
        error_signature: None,
        error_message: Some("account suspended".to_owned()),
        retry_after_sec: None,
        ttft_ms: None,
        tokens_used: None,
        quota_headers: None,
    });
    assert!(eng.node_health_snapshot("claude_vm:n2").2);
}

#[tokio::test]
async fn poison_request_rollback_across_two_healthy_nodes_and_releases_session_gate() {
    let pool = PoolConfig {
        id: CompactString::const_new("p1"),
        members: vec![
            member("claude_vm:n1", "n1", MemberRole::Active, 1),
            member("claude_vm:n2", "n2", MemberRole::Active, 2),
            member("claude_vm:n3", "n3", MemberRole::Active, 3),
        ],
        ..Default::default()
    };
    let eng = boot_pool(
        EngineOptions::default(),
        pool,
        vec![
            node_cfg("claude_vm:n1", "n1", 9, 10, 4, 4),
            node_cfg("claude_vm:n2", "n2", 8, 10, 4, 4),
            node_cfg("claude_vm:n3", "n3", 7, 10, 4, 4),
        ],
        vec![],
    );

    let sid = "550e8400-e29b-41d4-a716-446655440099";
    // Attempt 1 on n1
    let r1 = eng
        .acquire(req("req_poison", "p1", "m", sid))
        .await
        .unwrap();
    assert_eq!(r1.selected_node.node_key, "claude_vm:n1");

    // Enqueue R2 on same session to verify PoisonAbort wakes R2!
    let eng_r2 = Arc::clone(&eng);
    let h_r2 = tokio::spawn(async move { eng_r2.acquire(req("req_follow", "p1", "m", sid)).await });
    let gk = ScopedSessionKey::new("p1", ModelFamily::Claude, sid);
    while eng.session_gates.peek(&gk).1 < 1 {
        tokio::task::yield_now().await;
    }

    // Switch #1: n1 fails with 500 + volatile UUID/timestamp/email -> cools n1, moves to n2!
    let mut a2 = req("req_poison", "p1", "m", sid);
    a2.attempt_no = 2;
    let r2 = eng
        .switch(SwitchRequest {
            release_lease_id: r1.lease_id,
            failure: FailureReport {
                http_status: 500,
                error_class: ErrorClass::Server5xx,
                error_signature: None,
                error_message: Some(
                    "Internal error req_abc12345 user alice@a.com uuid 550e8400-e29b-41d4-a716-446655440001 at 2026-11-27T08:00:01Z".to_owned()
                ),
                retry_after_sec: Some(90),
                quota_headers: None,
            },
            next_attempt: a2,
        })
        .await
        .unwrap();
    assert_eq!(r2.selected_node.node_key, "claude_vm:n2");
    assert!(
        eng.node_health_snapshot("claude_vm:n1").0 > 0,
        "n1 cooled after 1st hit"
    );

    // Switch #2: n2 fails with SAME normalized 500 signature (different UUID/req_id/email/timestamp)!
    let mut a3 = req("req_poison", "p1", "m", sid);
    a3.attempt_no = 3;
    let err = eng
        .switch(SwitchRequest {
            release_lease_id: r2.lease_id,
            failure: FailureReport {
                http_status: 500,
                error_class: ErrorClass::Server5xx,
                error_signature: None,
                error_message: Some(
                    "Internal error req_xyz98765 user bob@b.org uuid 11111111-2222-3333-4444-555555555555 at 2026-11-27T08:00:02Z".to_owned()
                ),
                retry_after_sec: Some(90),
                quota_headers: None,
            },
            next_attempt: a3,
        })
        .await
        .err()
        .unwrap();

    assert_eq!(err.code(), ErrorCode::PoisonAbort);
    assert_eq!(err.http_status_code(), 422);

    // BOTH n1 and n2 MUST have their cooldowns & failure counts rolled back to 0!
    assert_eq!(eng.node_health_snapshot("claude_vm:n1").0, 0);
    assert_eq!(eng.node_health_snapshot("claude_vm:n1").3, 0);
    assert_eq!(eng.node_health_snapshot("claude_vm:n2").0, 0);
    assert_eq!(eng.node_health_snapshot("claude_vm:n2").3, 0);

    // And queued R2 MUST wake immediately because PoisonAbort dropped GateHoldGuard!
    let r_follow = tokio::time::timeout(Duration::from_secs(1), h_r2)
        .await
        .expect("R2 must wake on PoisonAbort")
        .unwrap()
        .unwrap();
    assert_eq!(
        r_follow.selected_node.node_key, "claude_vm:n1",
        "n1 is healthy again after rollback"
    );
    release_ok(&eng, &r_follow.lease_id);
}

#[tokio::test]
async fn all_cooled_probe_one_allows_single_soonest_probe_and_recovers_on_success() {
    let pool = PoolConfig {
        id: CompactString::const_new("p1"),
        queue_wait_ms: 0,
        members: vec![
            member("claude_vm:slow", "slow", MemberRole::Active, 1),
            member("claude_vm:soon", "soon", MemberRole::Active, 2),
        ],
        ..Default::default()
    };
    let now = scheduler_core::now_ms();
    let eng = Arc::new(SchedulerEngine::new(EngineOptions::default()));
    eng.bootstrap(BootstrapRequest {
        controller_epoch: CompactString::const_new("ep1"),
        role: Role::Leader,
        config_version: Some(1),
        config_snapshot: ConfigSnapshot {
            config_version: 1,
            pools: vec![pool],
            nodes: vec![
                node_cfg("claude_vm:slow", "slow", 10, 10, 4, 4),
                node_cfg("claude_vm:soon", "soon", 5, 10, 4, 4),
            ],
            ..Default::default()
        },
        active_sticky_bindings: vec![],
        active_penalties: vec![
            NodePenaltyDto {
                node_key: CompactString::const_new("claude_vm:slow"),
                node_type: NodeType::ClaudeVm,
                node_id: CompactString::const_new("slow"),
                model_scope: CompactString::const_new("*"),
                reason: CompactString::const_new("5xx"),
                cooldown_until_ms: now + 300_000,
                ladder_step: 2,
                permanent: false,
                updated_at_ms: now,
            },
            NodePenaltyDto {
                node_key: CompactString::const_new("claude_vm:soon"),
                node_type: NodeType::ClaudeVm,
                node_id: CompactString::const_new("soon"),
                model_scope: CompactString::const_new("*"),
                reason: CompactString::const_new("5xx"),
                cooldown_until_ms: now + 10_000,
                ladder_step: 1,
                permanent: false,
                updated_at_ms: now,
            },
        ],
        initial_telemetry: vec![],
    });

    // 1st request gets single probe on `soon`
    let p1 = eng.acquire(req("p1", "p1", "m", "s1")).await.unwrap();
    assert_eq!(p1.selected_node.node_key, "claude_vm:soon");
    assert_eq!(p1.explain.affinity.why, Some(AffinityWhy::ProbeOne));

    // Concurrent 2nd request MUST be rejected while probe is in flight (no thundering herd!)
    let err2 = eng.acquire(req("p2", "p1", "m", "s2")).await.err().unwrap();
    assert_eq!(err2.code(), ErrorCode::PoolExhausted);

    // Probe succeeds -> clears cooldown on `soon`!
    eng.commit(CommitRequest {
        lease_id: p1.lease_id.clone(),
    });
    release_ok(&eng, &p1.lease_id);
    assert_eq!(eng.node_health_snapshot("claude_vm:soon").0, 0);
}

#[tokio::test]
async fn admin_unrest_clears_cooldown_sink_permanent_and_wakes_waiters() {
    let pool = PoolConfig {
        id: CompactString::const_new("p1"),
        queue_wait_ms: 0,
        members: vec![member("claude_vm:n1", "n1", MemberRole::Active, 1)],
        ..Default::default()
    };
    let eng = boot_pool(
        EngineOptions::default(),
        pool,
        vec![node_cfg("claude_vm:n1", "n1", 8, 10, 4, 4)],
        vec![],
    );

    let r1 = eng.acquire(req("r1", "p1", "m", "s1")).await.unwrap();
    eng.release(ReleaseRequest {
        lease_id: r1.lease_id,
        outcome: ReleaseOutcome::Error,
        http_status: Some(403),
        error_class: Some(ErrorClass::PermanentBan),
        error_signature: None,
        error_message: Some("banned".to_owned()),
        retry_after_sec: None,
        ttft_ms: None,
        tokens_used: None,
        quota_headers: None,
    });
    assert_eq!(
        eng.acquire(req("r2", "p1", "m", "s2"))
            .await
            .err()
            .unwrap()
            .code(),
        ErrorCode::PoolExhausted
    );

    let u = eng.unrest(UnrestRequest {
        node_key: CompactString::const_new("claude_vm:n1"),
        model_scope: None,
    });
    assert!(u.ok);
    assert!(u.cleared_cooldowns >= 1);

    let r3 = eng.acquire(req("r3", "p1", "m", "s3")).await.unwrap();
    assert_eq!(r3.selected_node.node_key, "claude_vm:n1");
    release_ok(&eng, &r3.lease_id);
}

#[tokio::test]
async fn idempotency_cache_returns_same_lease_for_same_request_and_attempt() {
    let pool = PoolConfig {
        id: CompactString::const_new("p1"),
        members: vec![member("claude_vm:n1", "n1", MemberRole::Active, 1)],
        ..Default::default()
    };
    let eng = boot_pool(
        EngineOptions::default(),
        pool,
        vec![node_cfg("claude_vm:n1", "n1", 8, 10, 4, 4)],
        vec![],
    );

    let r1 = eng.acquire(req("req_dup", "p1", "m", "s1")).await.unwrap();
    let r2 = eng.acquire(req("req_dup", "p1", "m", "s1")).await.unwrap();
    assert_eq!(r1.lease_id, r2.lease_id);
    assert_eq!(
        eng.node_inflight("claude_vm:n1"),
        1,
        "must not double-reserve slot"
    );
    release_ok(&eng, &r1.lease_id);
}

#[tokio::test]
async fn lease_ttl_expiration_releases_slot_and_session_gate_while_heartbeat_renews() {
    let pool = PoolConfig {
        id: CompactString::const_new("p1"),
        members: vec![member("claude_vm:n1", "n1", MemberRole::Active, 1)],
        ..Default::default()
    };
    let eng = boot_pool(
        EngineOptions {
            lease_ttl_ms: 80,
            ..Default::default()
        },
        pool,
        vec![node_cfg("claude_vm:n1", "n1", 8, 10, 1, 1)],
        vec![],
    );

    let r1 = eng.acquire(req("r1", "p1", "m", "s_exp")).await.unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    // Heartbeat extends TTL so reap does NOT kill it yet!
    let hb = eng.heartbeat(HeartbeatRequest {
        controller_epoch: CompactString::const_new("ep1"),
        lease_ids: vec![r1.lease_id.clone(), CompactString::const_new("missing_ls")],
    });
    assert_eq!(hb.renewed, 1);
    assert_eq!(hb.missing.len(), 1);
    assert_eq!(eng.reap_expired(), 0);

    // Queue R2 on same session
    let eng2 = Arc::clone(&eng);
    let h2 = tokio::spawn(async move { eng2.acquire(req("r2", "p1", "m", "s_exp")).await });
    let gk = ScopedSessionKey::new("p1", ModelFamily::Claude, "s_exp");
    while eng.session_gates.peek(&gk).1 < 1 {
        tokio::task::yield_now().await;
    }

    // Let lease expire without heartbeat -> reap releases BOTH slot & SessionGate, waking R2!
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(eng.reap_expired(), 1);

    let r2 = tokio::time::timeout(Duration::from_secs(1), h2)
        .await
        .expect("R2 must wake after lease reap")
        .unwrap()
        .unwrap();
    assert_eq!(r2.selected_node.node_key, "claude_vm:n1");
    release_ok(&eng, &r2.lease_id);
    assert_eq!(eng.health().active_leases, 0);
    assert_eq!(eng.health().active_session_gates, 0);
}

#[tokio::test]
async fn controller_epoch_bootstrap_reaps_orphan_leases_and_session_gates() {
    let pool = PoolConfig {
        id: CompactString::const_new("p1"),
        members: vec![member("claude_vm:n1", "n1", MemberRole::Active, 1)],
        ..Default::default()
    };
    let nodes = vec![node_cfg("claude_vm:n1", "n1", 8, 10, 1, 1)];
    let eng = boot_pool(
        EngineOptions::default(),
        pool.clone(),
        nodes.clone(),
        vec![],
    );

    let _orphan = eng
        .acquire(req("r_orph", "p1", "m", "s_orph"))
        .await
        .unwrap();
    assert_eq!(eng.health().active_leases, 1);
    assert_eq!(eng.health().active_session_gates, 1);
    assert_eq!(eng.node_inflight("claude_vm:n1"), 1);

    // Node restarts with new controller_epoch = "ep2"
    let boot2 = eng.bootstrap(BootstrapRequest {
        controller_epoch: CompactString::const_new("ep2"),
        role: Role::Leader,
        config_version: Some(2),
        config_snapshot: ConfigSnapshot {
            config_version: 2,
            pools: vec![pool],
            nodes,
            ..Default::default()
        },
        active_sticky_bindings: vec![],
        active_penalties: vec![],
        initial_telemetry: vec![],
    });

    assert_eq!(boot2.orphans_reaped, 1);
    assert_eq!(eng.health().active_leases, 0);
    assert_eq!(eng.health().active_session_gates, 0);
    assert_eq!(eng.node_inflight("claude_vm:n1"), 0);
}

#[tokio::test]
async fn overloaded_529_does_not_falsely_trigger_poison_abort() {
    let pool = PoolConfig {
        id: CompactString::const_new("p1"),
        members: vec![
            member("claude_vm:n1", "n1", MemberRole::Active, 1),
            member("claude_vm:n2", "n2", MemberRole::Active, 2),
            member("claude_vm:n3", "n3", MemberRole::Active, 3),
        ],
        ..Default::default()
    };
    let eng = boot_pool(
        EngineOptions::default(),
        pool,
        vec![
            node_cfg("claude_vm:n1", "n1", 9, 10, 4, 4),
            node_cfg("claude_vm:n2", "n2", 8, 10, 4, 4),
            node_cfg("claude_vm:n3", "n3", 7, 10, 4, 4),
        ],
        vec![],
    );

    let r1 = eng
        .acquire(req("req_529", "p1", "m", "s529"))
        .await
        .unwrap();
    let mut a2 = req("req_529", "p1", "m", "s529");
    a2.attempt_no = 2;
    let r2 = eng
        .switch(SwitchRequest {
            release_lease_id: r1.lease_id,
            failure: FailureReport {
                http_status: 529,
                error_class: ErrorClass::Overloaded529,
                error_message: Some("Overloaded".to_owned()),
                ..Default::default()
            },
            next_attempt: a2,
        })
        .await
        .unwrap();

    let mut a3 = req("req_529", "p1", "m", "s529");
    a3.attempt_no = 3;
    let r3 = eng
        .switch(SwitchRequest {
            release_lease_id: r2.lease_id,
            failure: FailureReport {
                http_status: 529,
                error_class: ErrorClass::Overloaded529,
                error_message: Some("Overloaded".to_owned()),
                ..Default::default()
            },
            next_attempt: a3,
        })
        .await
        .expect("529 overloaded should continue failover to n3, not PoisonAbort");
    assert_eq!(r3.selected_node.node_key, "claude_vm:n3");
    release_ok(&eng, &r3.lease_id);
}

#[tokio::test]
async fn commit_is_idempotent_and_handles_unknown_lease() {
    let pool = PoolConfig {
        id: CompactString::const_new("p1"),
        members: vec![member("claude_vm:n1", "n1", MemberRole::Active, 1)],
        ..Default::default()
    };
    let eng = boot_pool(
        EngineOptions::default(),
        pool,
        vec![node_cfg("claude_vm:n1", "n1", 8, 10, 4, 4)],
        vec![],
    );

    let r1 = eng.acquire(req("r1", "p1", "m", "s1")).await.unwrap();
    let c1 = eng.commit(CommitRequest {
        lease_id: r1.lease_id.clone(),
    });
    assert!(c1.committed && !c1.already_committed && c1.lease_found);
    let c2 = eng.commit(CommitRequest {
        lease_id: r1.lease_id.clone(),
    });
    assert!(c2.committed && c2.already_committed && c2.lease_found);

    let c3 = eng.commit(CommitRequest {
        lease_id: CompactString::const_new("no_such_lease"),
    });
    assert!(!c3.committed && !c3.lease_found);

    // Release is also idempotent
    let rel1 = eng.release(ReleaseRequest {
        lease_id: r1.lease_id.clone(),
        outcome: ReleaseOutcome::Ok,
        http_status: None,
        error_class: None,
        error_signature: None,
        error_message: None,
        retry_after_sec: None,
        ttft_ms: None,
        tokens_used: None,
        quota_headers: None,
    });
    assert!(rel1.released);
    let rel2 = eng.release(ReleaseRequest {
        lease_id: r1.lease_id,
        outcome: ReleaseOutcome::Ok,
        http_status: None,
        error_class: None,
        error_signature: None,
        error_message: None,
        retry_after_sec: None,
        ttft_ms: None,
        tokens_used: None,
        quota_headers: None,
    });
    assert!(!rel2.released);
}

#[tokio::test]
async fn hard_failure_before_commit_unbinds_stale_session_stick() {
    let pool = PoolConfig {
        id: CompactString::const_new("p1"),
        members: vec![
            member("claude_vm:n1", "n1", MemberRole::Active, 1),
            member("claude_vm:n2", "n2", MemberRole::Active, 2),
        ],
        ..Default::default()
    };
    let eng = boot_pool(
        EngineOptions::default(),
        pool,
        vec![
            node_cfg("claude_vm:n1", "n1", 9, 10, 4, 4),
            node_cfg("claude_vm:n2", "n2", 5, 10, 4, 4),
        ],
        vec![],
    );

    // Establish session s1 on n1
    let r1 = eng.acquire(req("r1", "p1", "m", "s1")).await.unwrap();
    eng.commit(CommitRequest {
        lease_id: r1.lease_id.clone(),
    });
    release_ok(&eng, &r1.lease_id);
    assert_eq!(eng.query_sticky(&StickyQuery::default()).total, 1);

    // Turn 2 hits n1 but fails BEFORE commit -> releases & unbinds stale session stick!
    let r2 = eng.acquire(req("r2", "p1", "m", "s1")).await.unwrap();
    assert_eq!(r2.selected_node.node_key, "claude_vm:n1");
    eng.release(ReleaseRequest {
        lease_id: r2.lease_id,
        outcome: ReleaseOutcome::Error,
        http_status: Some(500),
        error_class: Some(ErrorClass::Server5xx),
        error_signature: None,
        error_message: Some("boom".to_owned()),
        retry_after_sec: None,
        ttft_ms: None,
        tokens_used: None,
        quota_headers: None,
    });
    assert_eq!(eng.query_sticky(&StickyQuery::default()).total, 0);
}

#[tokio::test]
async fn probe_one_failure_does_not_amplify_backoff_ladder() {
    let pool = PoolConfig {
        id: CompactString::const_new("p1"),
        queue_wait_ms: 0,
        members: vec![member("claude_vm:n1", "n1", MemberRole::Active, 1)],
        ..Default::default()
    };
    let now = scheduler_core::now_ms();
    let eng = Arc::new(SchedulerEngine::new(EngineOptions::default()));
    eng.bootstrap(BootstrapRequest {
        controller_epoch: CompactString::const_new("ep1"),
        role: Role::Leader,
        config_version: Some(1),
        config_snapshot: ConfigSnapshot {
            config_version: 1,
            pools: vec![pool],
            nodes: vec![node_cfg("claude_vm:n1", "n1", 8, 10, 4, 4)],
            ..Default::default()
        },
        active_sticky_bindings: vec![],
        active_penalties: vec![NodePenaltyDto {
            node_key: CompactString::const_new("claude_vm:n1"),
            node_type: NodeType::ClaudeVm,
            node_id: CompactString::const_new("n1"),
            model_scope: CompactString::const_new("*"),
            reason: CompactString::const_new("5xx"),
            cooldown_until_ms: now + 30_000,
            ladder_step: 0,
            permanent: false,
            updated_at_ms: now,
        }],
        initial_telemetry: vec![],
    });

    // Probe fails with 500 -> ladder step stays 0 (30s, NOT escalated to 60s/120s)!
    let p = eng.acquire(req("p1", "p1", "m", "s1")).await.unwrap();
    assert_eq!(p.explain.affinity.why, Some(AffinityWhy::ProbeOne));
    eng.release(ReleaseRequest {
        lease_id: p.lease_id,
        outcome: ReleaseOutcome::Error,
        http_status: Some(500),
        error_class: Some(ErrorClass::Server5xx),
        error_signature: None,
        error_message: Some("still down".to_owned()),
        retry_after_sec: None,
        ttft_ms: None,
        tokens_used: None,
        quota_headers: None,
    });
    let cd_until = eng.node_health_snapshot("claude_vm:n1").0;
    let remaining = cd_until.saturating_sub(scheduler_core::now_ms());
    assert!(
        remaining <= 31_000,
        "probe failure must NOT amplify backoff ladder (remaining={remaining}ms)"
    );
}

#[test]
fn poison_normalize_strips_uuids_emails_reqids_timestamps_and_numbers() {
    let s1 = scheduler_core::health::normalize_error_signature(
        500,
        None,
        Some(
            "boom req_aaaa1111 user a@b.com id 550e8400-e29b-41d4-a716-446655440000 at 2026-11-27T01:02:03Z ts 1764201234567",
        ),
    );
    let s2 = scheduler_core::health::normalize_error_signature(
        500,
        None,
        Some(
            "boom req_zzzz9999 user x@y.io id 11111111-2222-3333-4444-555555555555 at 2026-12-01T11:22:33Z ts 9999999999999",
        ),
    );
    let s3 = scheduler_core::health::normalize_error_signature(
        403,
        None,
        Some(
            "boom req_zzzz9999 user x@y.io id 11111111-2222-3333-4444-555555555555 at 2026-12-01T11:22:33Z ts 9999999999999",
        ),
    );
    assert_eq!(s1, s2);
    assert_ne!(
        s1, s3,
        "different http_status must produce distinct signature"
    );
}

#[tokio::test]
async fn poison_different_error_signatures_do_not_trigger_abort() {
    let pool = PoolConfig {
        id: CompactString::const_new("p1"),
        members: vec![
            member("claude_vm:n1", "n1", MemberRole::Active, 1),
            member("claude_vm:n2", "n2", MemberRole::Active, 2),
            member("claude_vm:n3", "n3", MemberRole::Active, 3),
        ],
        ..Default::default()
    };
    let eng = boot_pool(
        EngineOptions::default(),
        pool,
        vec![
            node_cfg("claude_vm:n1", "n1", 9, 10, 4, 4),
            node_cfg("claude_vm:n2", "n2", 8, 10, 4, 4),
            node_cfg("claude_vm:n3", "n3", 7, 10, 4, 4),
        ],
        vec![],
    );

    let r1 = eng
        .acquire(req("req_diff", "p1", "m", "sdiff"))
        .await
        .unwrap();
    let mut a2 = req("req_diff", "p1", "m", "sdiff");
    a2.attempt_no = 2;
    let r2 = eng
        .switch(SwitchRequest {
            release_lease_id: r1.lease_id,
            failure: FailureReport {
                http_status: 500,
                error_class: ErrorClass::Server5xx,
                error_message: Some("upstream gateway timeout alpha".to_owned()),
                ..Default::default()
            },
            next_attempt: a2,
        })
        .await
        .unwrap();

    let mut a3 = req("req_diff", "p1", "m", "sdiff");
    a3.attempt_no = 3;
    let r3 = eng
        .switch(SwitchRequest {
            release_lease_id: r2.lease_id,
            failure: FailureReport {
                http_status: 502,
                error_class: ErrorClass::Server5xx,
                error_message: Some("bad gateway beta".to_owned()),
                ..Default::default()
            },
            next_attempt: a3,
        })
        .await
        .expect("distinct signatures must not trigger PoisonAbort");
    assert_eq!(r3.selected_node.node_key, "claude_vm:n3");
    assert!(eng.poison_tracker_len() >= 1);
    release_ok(&eng, &r3.lease_id);
}

#[tokio::test]
async fn sink_429_multiple_nodes_ordered_by_sink_seq_and_cleared_on_ok() {
    let pool = PoolConfig {
        id: CompactString::const_new("p1"),
        members: vec![
            member("claude_vm:a", "a", MemberRole::Active, 1),
            member("claude_vm:b", "b", MemberRole::Active, 2),
        ],
        ..Default::default()
    };
    let eng = boot_pool(
        EngineOptions::default(),
        pool,
        vec![
            node_cfg("claude_vm:a", "a", 8, 10, 4, 4),
            node_cfg("claude_vm:b", "b", 8, 10, 4, 4),
        ],
        vec![],
    );

    // Sink `b` first (seq=1), then sink `a` second (seq=2)
    let mut pb = req("pb", "p1", "m", "sb");
    pb.is_admin_diagnostic = true;
    pb.pin_node_key = Some(CompactString::const_new("claude_vm:b"));
    let lb = eng.acquire(pb).await.unwrap();
    eng.release(ReleaseRequest {
        lease_id: lb.lease_id,
        outcome: ReleaseOutcome::Error,
        http_status: Some(429),
        error_class: Some(ErrorClass::RateLimit429),
        error_signature: None,
        error_message: None,
        retry_after_sec: Some(1),
        ttft_ms: None,
        tokens_used: None,
        quota_headers: None,
    });

    let mut pa = req("pa", "p1", "m", "sa");
    pa.is_admin_diagnostic = true;
    pa.pin_node_key = Some(CompactString::const_new("claude_vm:a"));
    let la = eng.acquire(pa).await.unwrap();
    eng.release(ReleaseRequest {
        lease_id: la.lease_id,
        outcome: ReleaseOutcome::Error,
        http_status: Some(429),
        error_class: Some(ErrorClass::RateLimit429),
        error_signature: None,
        error_message: None,
        retry_after_sec: Some(1),
        ttft_ms: None,
        tokens_used: None,
        quota_headers: None,
    });

    // Older sink (`b`, seq=1) must be picked before newer sink (`a`, seq=2)!
    let r = eng.acquire(req("r1", "p1", "m", "s1")).await.unwrap();
    assert_eq!(r.selected_node.node_key, "claude_vm:b");
    eng.commit(CommitRequest {
        lease_id: r.lease_id.clone(),
    });
    release_ok(&eng, &r.lease_id);
    assert_eq!(
        eng.node_health_snapshot("claude_vm:b").1,
        0,
        "commit/ok clears sink_seq"
    );
}

#[tokio::test]
async fn quota_headers_on_release_move_node_into_soft_quota_sub_bucket() {
    let pool = PoolConfig {
        id: CompactString::const_new("p1"),
        members: vec![
            member("claude_vm:a", "a", MemberRole::Active, 1),
            member("claude_vm:b", "b", MemberRole::Active, 2),
        ],
        ..Default::default()
    };
    let eng = boot_pool(
        EngineOptions::default(),
        pool,
        vec![
            node_cfg("claude_vm:a", "a", 8, 50, 4, 4),
            node_cfg("claude_vm:b", "b", 8, 10, 4, 4),
        ],
        vec![],
    );

    let r1 = eng.acquire(req("r1", "p1", "m", "s1")).await.unwrap();
    assert_eq!(r1.selected_node.node_key, "claude_vm:a");
    eng.release(ReleaseRequest {
        lease_id: r1.lease_id,
        outcome: ReleaseOutcome::Ok,
        http_status: None,
        error_class: None,
        error_signature: None,
        error_message: None,
        retry_after_sec: None,
        ttft_ms: None,
        tokens_used: None,
        quota_headers: Some(QuotaHeaders {
            quota_util_5h_pct: Some(89.5),
            quota_util_7d_pct: None,
            resets_at_ms: None,
        }),
    });

    // `a` is now in sub_bucket=1 (>=85%), so `b` (sub_bucket=0) wins despite lower sub_weight!
    let r2 = eng.acquire(req("r2", "p1", "m", "s2")).await.unwrap();
    assert_eq!(r2.selected_node.node_key, "claude_vm:b");
    assert_eq!(r2.explain.order[0].sub_bucket, 0);
    assert_eq!(r2.explain.order[1].sub_bucket, 1);
    release_ok(&eng, &r2.lease_id);
}

#[tokio::test]
async fn primary_session_cap_enforced_independently_of_subagents() {
    let mut n1 = node_cfg("claude_vm:n1", "n1", 9, 10, 8, 8);
    n1.capacity.max_primary_sessions = Some(1);
    let n2 = node_cfg("claude_vm:n2", "n2", 5, 10, 8, 8);

    let pool = PoolConfig {
        id: CompactString::const_new("p1"),
        members: vec![
            member("claude_vm:n1", "n1", MemberRole::Active, 1),
            member("claude_vm:n2", "n2", MemberRole::Active, 2),
        ],
        ..Default::default()
    };
    let eng = boot_pool(EngineOptions::default(), pool, vec![n1, n2], vec![]);

    let p1 = eng.acquire(req("p1", "p1", "m", "primary1")).await.unwrap();
    assert_eq!(p1.selected_node.node_key, "claude_vm:n1");
    eng.commit(CommitRequest {
        lease_id: p1.lease_id.clone(),
    });

    // Second primary session cannot fit on n1 (max_primary_sessions=1) -> spills to n2
    let p2 = eng.acquire(req("p2", "p1", "m", "primary2")).await.unwrap();
    assert_eq!(p2.selected_node.node_key, "claude_vm:n2");

    // Subagent of primary1 CAN still fit on n1!
    let mut sub = req("sub1", "p1", "m", "sub_of_p1");
    sub.parent_session_id = Some(CompactString::const_new("primary1"));
    let s1 = eng.acquire(sub).await.unwrap();
    assert_eq!(s1.selected_node.node_key, "claude_vm:n1");

    release_ok(&eng, &p1.lease_id);
    release_ok(&eng, &p2.lease_id);
    release_ok(&eng, &s1.lease_id);
}

#[tokio::test]
async fn release_400_without_error_class_never_cools_node() {
    let pool = PoolConfig {
        id: CompactString::const_new("p1"),
        members: vec![member("claude_vm:n1", "n1", MemberRole::Active, 1)],
        ..Default::default()
    };
    let eng = boot_pool(
        EngineOptions::default(),
        pool,
        vec![node_cfg("claude_vm:n1", "n1", 8, 10, 4, 4)],
        vec![],
    );

    for (i, status) in [400u16, 404, 413, 422].into_iter().enumerate() {
        let r = eng
            .acquire(req(&format!("r{i}"), "p1", "m", &format!("s{i}")))
            .await
            .unwrap();
        eng.release(ReleaseRequest {
            lease_id: r.lease_id,
            outcome: ReleaseOutcome::Error,
            http_status: Some(status),
            error_class: None,
            error_signature: None,
            error_message: Some("malformed request".to_owned()),
            retry_after_sec: None,
            ttft_ms: None,
            tokens_used: None,
            quota_headers: None,
        });
    }
    assert_eq!(
        eng.node_health_snapshot("claude_vm:n1"),
        (0, 0, false, 0),
        "request-side 4xx without error_class must not cool the node"
    );
}

#[tokio::test]
async fn aborted_timeout_and_request_fault_releases_keep_session_stick() {
    let pool = PoolConfig {
        id: CompactString::const_new("p1"),
        members: vec![
            member("claude_vm:n1", "n1", MemberRole::Active, 1),
            member("claude_vm:n2", "n2", MemberRole::Active, 2),
        ],
        ..Default::default()
    };
    let eng = boot_pool(
        EngineOptions::default(),
        pool,
        vec![
            node_cfg("claude_vm:n1", "n1", 9, 10, 4, 4),
            node_cfg("claude_vm:n2", "n2", 5, 10, 4, 4),
        ],
        vec![],
    );

    let r0 = eng.acquire(req("r0", "p1", "m", "s1")).await.unwrap();
    assert_eq!(r0.selected_node.node_key, "claude_vm:n1");
    eng.commit(CommitRequest {
        lease_id: r0.lease_id.clone(),
    });
    release_ok(&eng, &r0.lease_id);

    let cases = [
        (ReleaseOutcome::Aborted, None, None),
        (ReleaseOutcome::Timeout, None, None),
        (ReleaseOutcome::Error, Some(400u16), None),
        (
            ReleaseOutcome::Error,
            Some(400u16),
            Some(ErrorClass::ContextTooLong),
        ),
    ];
    for (i, (outcome, status, class)) in cases.into_iter().enumerate() {
        let r = eng
            .acquire(req(&format!("t{i}"), "p1", "m", "s1"))
            .await
            .unwrap();
        assert_eq!(r.selected_node.node_key, "claude_vm:n1");
        assert_eq!(r.explain.affinity.why, Some(AffinityWhy::SessionHit));
        eng.release(ReleaseRequest {
            lease_id: r.lease_id,
            outcome,
            http_status: status,
            error_class: class,
            error_signature: None,
            error_message: None,
            retry_after_sec: None,
            ttft_ms: None,
            tokens_used: None,
            quota_headers: None,
        });
        let sticks = eng.query_sticky(&StickyQuery {
            scope_kind: Some(StickyScopeKind::Session),
            session_id: Some(CompactString::const_new("s1")),
            ..Default::default()
        });
        assert_eq!(
            sticks.total, 1,
            "case {i} ({outcome:?}) must keep session stick"
        );
        assert_eq!(sticks.bindings[0].node_key, "claude_vm:n1");
    }
}
