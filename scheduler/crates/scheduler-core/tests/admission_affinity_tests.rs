use compact_str::CompactString;
use scheduler_core::{EngineOptions, SchedulerEngine};
use scheduler_proto::*;
use std::sync::Arc;
use std::time::Duration;

fn node_cfg(
    key: &str,
    nt: NodeType,
    id: &str,
    provider: Provider,
    tier: u16,
    max_conc: u32,
    max_sess: u32,
) -> BackendNodeConfig {
    BackendNodeConfig {
        node_key: CompactString::from(key),
        node_type: nt,
        node_id: CompactString::from(id),
        provider,
        protocol: None,
        owner_id: None,
        plan_tier: None,
        weight_tier_mode: WeightTierMode::Manual,
        weight_tier: tier,
        auto_weight_tier: None,
        sub_weight: 10,
        supported_models: vec![],
        capacity: NodeCapacityConfig {
            max_concurrency: max_conc,
            max_sessions: max_sess,
            ..Default::default()
        },
        enabled: true,
    }
}

fn member_cfg(key: &str, nt: NodeType, id: &str, order: i32) -> PoolMemberConfig {
    PoolMemberConfig {
        node_key: CompactString::from(key),
        node_type: nt,
        node_id: CompactString::from(id),
        enabled: true,
        member_role: MemberRole::Active,
        weight_tier_override: None,
        sub_weight_override: None,
        member_order: order,
    }
}

fn base_req(
    req_id: &str,
    pool_id: &str,
    model: &str,
    family: ModelFamily,
    sid: &str,
    mid: Option<&str>,
) -> AcquireRequest {
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
        model_family: family,
        protocol: CompactString::const_new("anthropic"),
        machine_id: mid.map(CompactString::from),
        session_id: CompactString::from(sid),
        session_id_source: Some(CompactString::const_new("caller")),
        parent_session_id: None,
        is_ephemeral_probe: false,
        no_queue: false,
        is_admin_diagnostic: false,
        pin_node_key: None,
        exclude_nodes: vec![],
    }
}

fn release_ok(engine: &SchedulerEngine, lease_id: &str) {
    engine.release(ReleaseRequest {
        lease_id: CompactString::from(lease_id),
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

#[tokio::test]
async fn not_bootstrapped_returns_503() {
    let eng = SchedulerEngine::new(EngineOptions::default());
    let err = eng
        .acquire(base_req(
            "r1",
            "pool_1",
            "claude-sonnet-4",
            ModelFamily::Claude,
            "s1",
            None,
        ))
        .await
        .err()
        .unwrap();
    assert_eq!(err.code(), ErrorCode::SchedulerNotBootstrapped);
    assert_eq!(err.http_status_code(), 503);
}

#[tokio::test]
async fn min_config_version_barrier_waits_for_sync_then_succeeds() {
    let eng = Arc::new(SchedulerEngine::new(EngineOptions {
        config_barrier_timeout_ms: 1_500,
        ..Default::default()
    }));
    let snap = ConfigSnapshot {
        config_version: 1,
        pools: vec![PoolConfig {
            id: CompactString::const_new("pool_1"),
            members: vec![member_cfg("claude_vm:vm1", NodeType::ClaudeVm, "vm1", 1)],
            ..Default::default()
        }],
        nodes: vec![node_cfg(
            "claude_vm:vm1",
            NodeType::ClaudeVm,
            "vm1",
            Provider::Anthropic,
            8,
            4,
            4,
        )],
        ..Default::default()
    };
    eng.bootstrap(BootstrapRequest {
        controller_epoch: CompactString::const_new("ep1"),
        role: Role::Leader,
        config_version: Some(1),
        config_snapshot: snap.clone(),
        active_sticky_bindings: vec![],
        active_penalties: vec![],
        initial_telemetry: vec![],
    });

    let eng_sync = Arc::clone(&eng);
    let snap2 = snap.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(30)).await;
        eng_sync.sync_config(ConfigSyncRequest {
            config_version: 2,
            config_snapshot: snap2,
        });
    });

    let mut req = base_req(
        "r1",
        "pool_1",
        "claude-sonnet-4",
        ModelFamily::Claude,
        "s1",
        None,
    );
    req.min_config_version = 2;
    let resp = eng.acquire(req).await.unwrap();
    assert_eq!(resp.explain.config_version, 2);
}

#[tokio::test]
async fn min_config_version_barrier_times_out_when_stale() {
    let eng = SchedulerEngine::new(EngineOptions {
        config_barrier_timeout_ms: 40,
        ..Default::default()
    });
    eng.bootstrap(BootstrapRequest {
        controller_epoch: CompactString::const_new("ep1"),
        role: Role::Leader,
        config_version: Some(1),
        config_snapshot: ConfigSnapshot {
            config_version: 1,
            pools: vec![PoolConfig {
                id: CompactString::const_new("pool_1"),
                members: vec![member_cfg("claude_vm:vm1", NodeType::ClaudeVm, "vm1", 1)],
                ..Default::default()
            }],
            nodes: vec![node_cfg(
                "claude_vm:vm1",
                NodeType::ClaudeVm,
                "vm1",
                Provider::Anthropic,
                8,
                4,
                4,
            )],
            ..Default::default()
        },
        active_sticky_bindings: vec![],
        active_penalties: vec![],
        initial_telemetry: vec![],
    });
    let mut req = base_req(
        "r1",
        "pool_1",
        "claude-sonnet-4",
        ModelFamily::Claude,
        "s1",
        None,
    );
    req.min_config_version = 99;
    let err = eng.acquire(req).await.err().unwrap();
    assert_eq!(err.code(), ErrorCode::ConfigVersionTimeout);
    assert_eq!(err.http_status_code(), 503);
}

#[tokio::test]
async fn fail_closed_pool_auth_missing_disabled_empty_and_unauthorized() {
    let eng = SchedulerEngine::new(EngineOptions::default());
    eng.bootstrap(BootstrapRequest {
        controller_epoch: CompactString::const_new("ep1"),
        role: Role::Leader,
        config_version: Some(1),
        config_snapshot: ConfigSnapshot {
            config_version: 1,
            pools: vec![
                PoolConfig {
                    id: CompactString::const_new("pool_ok"),
                    members: vec![member_cfg("claude_vm:vm1", NodeType::ClaudeVm, "vm1", 1)],
                    ..Default::default()
                },
                PoolConfig {
                    id: CompactString::const_new("pool_disabled"),
                    enabled: false,
                    members: vec![member_cfg("claude_vm:vm1", NodeType::ClaudeVm, "vm1", 1)],
                    ..Default::default()
                },
                PoolConfig {
                    id: CompactString::const_new("pool_empty"),
                    members: vec![],
                    ..Default::default()
                },
            ],
            nodes: vec![node_cfg(
                "claude_vm:vm1",
                NodeType::ClaudeVm,
                "vm1",
                Provider::Anthropic,
                8,
                4,
                4,
            )],
            ..Default::default()
        },
        active_sticky_bindings: vec![],
        active_penalties: vec![],
        initial_telemetry: vec![],
    });

    // Missing pool
    assert_eq!(
        eng.acquire(base_req(
            "r1",
            "pool_nope",
            "m",
            ModelFamily::Claude,
            "s1",
            None
        ))
        .await
        .err()
        .unwrap()
        .code(),
        ErrorCode::PoolUnavailable
    );

    // Disabled pool
    assert_eq!(
        eng.acquire(base_req(
            "r2",
            "pool_disabled",
            "m",
            ModelFamily::Claude,
            "s1",
            None
        ))
        .await
        .err()
        .unwrap()
        .code(),
        ErrorCode::PoolUnavailable
    );

    // Empty pool
    assert_eq!(
        eng.acquire(base_req(
            "r3",
            "pool_empty",
            "m",
            ModelFamily::Claude,
            "s1",
            None
        ))
        .await
        .err()
        .unwrap()
        .code(),
        ErrorCode::PoolUnavailable
    );

    // Unauthorized strict pool
    let mut unauth = base_req("r4", "pool_ok", "m", ModelFamily::Claude, "s1", None);
    unauth.api_key_scope.default_pool_id = None;
    unauth.api_key_scope.allowed_pool_ids = vec![CompactString::const_new("other_pool")];
    let err = eng.acquire(unauth).await.err().unwrap();
    assert_eq!(err.code(), ErrorCode::PoolForbidden);
    assert_eq!(err.http_status_code(), 403);
}

#[tokio::test]
async fn jev_downgrade_pool_exempts_strict_pool_whitelist_and_never_pollutes_origin_sticky() {
    let eng = SchedulerEngine::new(EngineOptions::default());
    eng.bootstrap(BootstrapRequest {
        controller_epoch: CompactString::const_new("ep1"),
        role: Role::Leader,
        config_version: Some(1),
        config_snapshot: ConfigSnapshot {
            config_version: 1,
            pools: vec![
                PoolConfig {
                    id: CompactString::const_new("pool_main"),
                    members: vec![member_cfg(
                        "claude_vm:vm_main",
                        NodeType::ClaudeVm,
                        "vm_main",
                        1,
                    )],
                    ..Default::default()
                },
                PoolConfig {
                    id: CompactString::const_new("pool_jev_down"),
                    pool_role: PoolRole::Downgrade,
                    members: vec![member_cfg(
                        "claude_vm:vm_down",
                        NodeType::ClaudeVm,
                        "vm_down",
                        1,
                    )],
                    ..Default::default()
                },
                PoolConfig {
                    id: CompactString::const_new("pool_untrusted"),
                    pool_role: PoolRole::Standard,
                    members: vec![member_cfg(
                        "claude_vm:vm_down",
                        NodeType::ClaudeVm,
                        "vm_down",
                        1,
                    )],
                    ..Default::default()
                },
            ],
            nodes: vec![
                node_cfg(
                    "claude_vm:vm_main",
                    NodeType::ClaudeVm,
                    "vm_main",
                    Provider::Anthropic,
                    9,
                    4,
                    4,
                ),
                node_cfg(
                    "claude_vm:vm_down",
                    NodeType::ClaudeVm,
                    "vm_down",
                    Provider::Anthropic,
                    3,
                    4,
                    4,
                ),
            ],
            ..Default::default()
        },
        active_sticky_bindings: vec![],
        active_penalties: vec![],
        initial_telemetry: vec![],
    });

    // Strict key only authorized for `pool_main`, NOT `pool_jev_down`!
    let mut req = base_req(
        "r_jev",
        "pool_main",
        "claude-sonnet-4",
        ModelFamily::Claude,
        "sess_jev",
        Some("mach_1"),
    );
    req.jev_downgrade_pool_id = Some(CompactString::const_new("pool_jev_down"));
    let resp = eng
        .acquire(req)
        .await
        .expect("trusted downgrade must not 403");
    assert_eq!(resp.resolved_pool_id, "pool_jev_down");
    assert_eq!(resp.selected_node.node_key, "claude_vm:vm_down");
    assert!(resp.preserve_machine_home);
    assert!(resp.explain.is_downgraded);

    eng.commit(CommitRequest {
        lease_id: resp.lease_id.clone(),
    });
    release_ok(&eng, &resp.lease_id);

    // Verify zero machine stick written in EITHER pool_main OR pool_jev_down!
    let m_sticks = eng.query_sticky(&StickyQuery {
        scope_kind: Some(StickyScopeKind::Machine),
        machine_id: Some(CompactString::const_new("mach_1")),
        ..Default::default()
    });
    assert_eq!(
        m_sticks.total, 0,
        "JEV downgrade must NEVER pollute machine_sticks"
    );

    // Verify untrusted downgrade pool is strictly rejected with 403 PoolForbidden!
    let mut bad = base_req(
        "r_bad_jev",
        "pool_main",
        "claude-sonnet-4",
        ModelFamily::Claude,
        "sess_jev2",
        Some("mach_1"),
    );
    bad.jev_downgrade_pool_id = Some(CompactString::const_new("pool_untrusted"));
    assert_eq!(
        eng.acquire(bad).await.err().unwrap().code(),
        ErrorCode::PoolForbidden
    );
}

#[tokio::test]
async fn jev_downgrade_still_enforces_tenant_and_model_boundaries() {
    let eng = SchedulerEngine::new(EngineOptions::default());
    let mut down_node = node_cfg(
        "claude_vm:vm_down",
        NodeType::ClaudeVm,
        "vm_down",
        Provider::Anthropic,
        5,
        4,
        4,
    );
    down_node.owner_id = Some(CompactString::const_new("tenant_b"));
    eng.bootstrap(BootstrapRequest {
        controller_epoch: CompactString::const_new("ep1"),
        role: Role::Leader,
        config_version: Some(1),
        config_snapshot: ConfigSnapshot {
            config_version: 1,
            pools: vec![
                PoolConfig {
                    id: CompactString::const_new("pool_main"),
                    members: vec![member_cfg(
                        "claude_vm:vm_main",
                        NodeType::ClaudeVm,
                        "vm_main",
                        1,
                    )],
                    ..Default::default()
                },
                PoolConfig {
                    id: CompactString::const_new("pool_down"),
                    pool_role: PoolRole::Downgrade,
                    members: vec![member_cfg(
                        "claude_vm:vm_down",
                        NodeType::ClaudeVm,
                        "vm_down",
                        1,
                    )],
                    ..Default::default()
                },
            ],
            nodes: vec![
                node_cfg(
                    "claude_vm:vm_main",
                    NodeType::ClaudeVm,
                    "vm_main",
                    Provider::Anthropic,
                    9,
                    4,
                    4,
                ),
                down_node,
            ],
            ..Default::default()
        },
        active_sticky_bindings: vec![],
        active_penalties: vec![],
        initial_telemetry: vec![],
    });

    let mut req = base_req(
        "r_t",
        "pool_main",
        "claude-sonnet-4",
        ModelFamily::Claude,
        "s1",
        None,
    );
    req.jev_downgrade_pool_id = Some(CompactString::const_new("pool_down"));
    req.api_key_scope.owner_id = Some(CompactString::const_new("tenant_a"));
    let err = eng.acquire(req).await.err().unwrap();
    assert_eq!(err.code(), ErrorCode::PoolExhausted);
    let env = err.to_envelope();
    assert_eq!(
        env.error.explain.unwrap().excluded[0].reason,
        ExcludeReason::TenantMismatch
    );
}

#[tokio::test]
async fn pin_node_key_requires_admin_diagnostic_and_routes_directly() {
    let eng = SchedulerEngine::new(EngineOptions::default());
    eng.bootstrap(BootstrapRequest {
        controller_epoch: CompactString::const_new("ep1"),
        role: Role::Leader,
        config_version: Some(1),
        config_snapshot: ConfigSnapshot {
            config_version: 1,
            pools: vec![PoolConfig {
                id: CompactString::const_new("pool_1"),
                members: vec![
                    member_cfg("claude_vm:vm_hi", NodeType::ClaudeVm, "vm_hi", 1),
                    member_cfg("claude_vm:vm_lo", NodeType::ClaudeVm, "vm_lo", 2),
                ],
                ..Default::default()
            }],
            nodes: vec![
                node_cfg(
                    "claude_vm:vm_hi",
                    NodeType::ClaudeVm,
                    "vm_hi",
                    Provider::Anthropic,
                    10,
                    4,
                    4,
                ),
                node_cfg(
                    "claude_vm:vm_lo",
                    NodeType::ClaudeVm,
                    "vm_lo",
                    Provider::Anthropic,
                    1,
                    1,
                    1,
                ),
            ],
            ..Default::default()
        },
        active_sticky_bindings: vec![],
        active_penalties: vec![],
        initial_telemetry: vec![],
    });

    // Normal key rejected
    let mut non_admin = base_req("r1", "pool_1", "m", ModelFamily::Claude, "s1", None);
    non_admin.pin_node_key = Some(CompactString::const_new("claude_vm:vm_lo"));
    assert_eq!(
        eng.acquire(non_admin).await.err().unwrap().code(),
        ErrorCode::Forbidden
    );

    // Admin diagnostic succeeds directly on vm_lo
    let mut admin = base_req("r2", "pool_1", "m", ModelFamily::Claude, "s2", None);
    admin.is_admin_diagnostic = true;
    admin.pin_node_key = Some(CompactString::const_new("claude_vm:vm_lo"));
    let resp = eng.acquire(admin).await.unwrap();
    assert_eq!(resp.selected_node.node_key, "claude_vm:vm_lo");
    assert_eq!(
        resp.explain.affinity.why,
        Some(AffinityWhy::PinnedDiagnostic)
    );

    // Second admin diagnostic on full vm_lo returns NodeBusy (503)
    let mut admin2 = base_req("r3", "pool_1", "m", ModelFamily::Claude, "s3", None);
    admin2.is_admin_diagnostic = true;
    admin2.pin_node_key = Some(CompactString::const_new("claude_vm:vm_lo"));
    assert_eq!(
        eng.acquire(admin2).await.err().unwrap().code(),
        ErrorCode::NodeBusy
    );

    release_ok(&eng, &resp.lease_id);
}

#[tokio::test]
async fn admission_records_all_exclusion_reasons() {
    let eng = SchedulerEngine::new(EngineOptions::default());
    let mut n_disabled = node_cfg(
        "claude_vm:n_dis",
        NodeType::ClaudeVm,
        "n_dis",
        Provider::Anthropic,
        5,
        4,
        4,
    );
    n_disabled.enabled = false;
    let mut n_model = node_cfg(
        "claude_vm:n_mod",
        NodeType::ClaudeVm,
        "n_mod",
        Provider::Anthropic,
        5,
        4,
        4,
    );
    n_model.supported_models = vec![CompactString::const_new("claude-haiku-3")];

    eng.bootstrap(BootstrapRequest {
        controller_epoch: CompactString::const_new("ep1"),
        role: Role::Leader,
        config_version: Some(1),
        config_snapshot: ConfigSnapshot {
            config_version: 1,
            pools: vec![PoolConfig {
                id: CompactString::const_new("pool_1"),
                members: vec![
                    PoolMemberConfig {
                        enabled: false,
                        ..member_cfg("claude_vm:m_dis", NodeType::ClaudeVm, "m_dis", 1)
                    },
                    member_cfg("claude_vm:n_dis", NodeType::ClaudeVm, "n_dis", 2),
                    member_cfg("claude_vm:n_mod", NodeType::ClaudeVm, "n_mod", 3),
                    member_cfg("claude_vm:n_unsched", NodeType::ClaudeVm, "n_unsched", 4),
                    member_cfg("claude_vm:n_hours", NodeType::ClaudeVm, "n_hours", 5),
                    member_cfg("claude_vm:n_quota", NodeType::ClaudeVm, "n_quota", 6),
                    member_cfg("claude_vm:n_mem", NodeType::ClaudeVm, "n_mem", 7),
                    member_cfg("claude_vm:n_proxy", NodeType::ClaudeVm, "n_proxy", 8),
                    member_cfg("claude_vm:n_lic", NodeType::ClaudeVm, "n_lic", 9),
                    member_cfg("claude_vm:n_ok", NodeType::ClaudeVm, "n_ok", 10),
                ],
                ..Default::default()
            }],
            nodes: vec![
                node_cfg(
                    "claude_vm:m_dis",
                    NodeType::ClaudeVm,
                    "m_dis",
                    Provider::Anthropic,
                    5,
                    4,
                    4,
                ),
                n_disabled,
                n_model,
                node_cfg(
                    "claude_vm:n_unsched",
                    NodeType::ClaudeVm,
                    "n_unsched",
                    Provider::Anthropic,
                    5,
                    4,
                    4,
                ),
                node_cfg(
                    "claude_vm:n_hours",
                    NodeType::ClaudeVm,
                    "n_hours",
                    Provider::Anthropic,
                    5,
                    4,
                    4,
                ),
                node_cfg(
                    "claude_vm:n_quota",
                    NodeType::ClaudeVm,
                    "n_quota",
                    Provider::Anthropic,
                    5,
                    4,
                    4,
                ),
                node_cfg(
                    "claude_vm:n_mem",
                    NodeType::ClaudeVm,
                    "n_mem",
                    Provider::Anthropic,
                    5,
                    4,
                    4,
                ),
                node_cfg(
                    "claude_vm:n_proxy",
                    NodeType::ClaudeVm,
                    "n_proxy",
                    Provider::Anthropic,
                    5,
                    4,
                    4,
                ),
                node_cfg(
                    "claude_vm:n_lic",
                    NodeType::ClaudeVm,
                    "n_lic",
                    Provider::Anthropic,
                    5,
                    4,
                    4,
                ),
                node_cfg(
                    "claude_vm:n_ok",
                    NodeType::ClaudeVm,
                    "n_ok",
                    Provider::Anthropic,
                    5,
                    4,
                    4,
                ),
            ],
            ..Default::default()
        },
        active_sticky_bindings: vec![],
        active_penalties: vec![],
        initial_telemetry: vec![
            NodeTelemetryUpdate {
                node_key: CompactString::const_new("claude_vm:n_unsched"),
                schedulable: Some(false),
                ..Default::default()
            },
            NodeTelemetryUpdate {
                node_key: CompactString::const_new("claude_vm:n_hours"),
                active_hours_ok: Some(false),
                ..Default::default()
            },
            NodeTelemetryUpdate {
                node_key: CompactString::const_new("claude_vm:n_quota"),
                quota_util_5h_pct: Some(96.0),
                ..Default::default()
            },
            NodeTelemetryUpdate {
                node_key: CompactString::const_new("claude_vm:n_mem"),
                host_memory_pressure: Some(true),
                ..Default::default()
            },
            NodeTelemetryUpdate {
                node_key: CompactString::const_new("claude_vm:n_proxy"),
                proxy_ready: Some(false),
                ..Default::default()
            },
            NodeTelemetryUpdate {
                node_key: CompactString::const_new("claude_vm:n_lic"),
                crag_license_ok: Some(false),
                ..Default::default()
            },
        ],
    });

    let resp = eng
        .acquire(base_req(
            "r1",
            "pool_1",
            "claude-sonnet-4",
            ModelFamily::Claude,
            "s1",
            None,
        ))
        .await
        .unwrap();
    assert_eq!(resp.selected_node.node_key, "claude_vm:n_ok");
    let reasons: Vec<ExcludeReason> = resp.explain.excluded.iter().map(|e| e.reason).collect();
    assert!(reasons.contains(&ExcludeReason::MemberDisabled));
    assert!(reasons.contains(&ExcludeReason::NodeDisabled));
    assert!(reasons.contains(&ExcludeReason::ModelUnsupported));
    assert!(reasons.contains(&ExcludeReason::NotSchedulable));
    assert!(reasons.contains(&ExcludeReason::InactiveHours));
    assert!(reasons.contains(&ExcludeReason::QuotaExhausted));
    assert!(reasons.contains(&ExcludeReason::MemoryPressure));
    assert!(reasons.contains(&ExcludeReason::ProxyNotReady));
    assert!(reasons.contains(&ExcludeReason::LicenseInvalid));
    release_ok(&eng, &resp.lease_id);
}

#[tokio::test]
async fn scenario_b_machine_home_full_spills_immediately_and_preserves_home_binding() {
    let eng = SchedulerEngine::new(EngineOptions::default());
    eng.bootstrap(BootstrapRequest {
        controller_epoch: CompactString::const_new("ep1"),
        role: Role::Leader,
        config_version: Some(1),
        config_snapshot: ConfigSnapshot {
            config_version: 1,
            pools: vec![PoolConfig {
                id: CompactString::const_new("pool_1"),
                members: vec![
                    member_cfg("claude_vm:vm1", NodeType::ClaudeVm, "vm1", 1),
                    member_cfg("claude_vm:vm2", NodeType::ClaudeVm, "vm2", 2),
                ],
                ..Default::default()
            }],
            nodes: vec![
                node_cfg(
                    "claude_vm:vm1",
                    NodeType::ClaudeVm,
                    "vm1",
                    Provider::Anthropic,
                    9,
                    1,
                    1,
                ),
                node_cfg(
                    "claude_vm:vm2",
                    NodeType::ClaudeVm,
                    "vm2",
                    Provider::Anthropic,
                    7,
                    4,
                    4,
                ),
            ],
            ..Default::default()
        },
        active_sticky_bindings: vec![],
        active_penalties: vec![],
        initial_telemetry: vec![],
    });

    // S1 binds machine m1 -> vm1 (highest tier)
    let r1 = eng
        .acquire(base_req(
            "r1",
            "pool_1",
            "claude-sonnet-4",
            ModelFamily::Claude,
            "s1",
            Some("m1"),
        ))
        .await
        .unwrap();
    assert_eq!(r1.selected_node.node_key, "claude_vm:vm1");
    assert!(!r1.stood_in);
    assert!(!r1.preserve_machine_home);
    eng.commit(CommitRequest {
        lease_id: r1.lease_id.clone(),
    });

    // While S1 occupies vm1 (cap 1/1), S2 on SAME machine m1 arrives -> MUST spill immediately to vm2!
    let t0 = std::time::Instant::now();
    let r2 = eng
        .acquire(base_req(
            "r2",
            "pool_1",
            "claude-sonnet-4",
            ModelFamily::Claude,
            "s2",
            Some("m1"),
        ))
        .await
        .unwrap();
    assert!(
        t0.elapsed() < Duration::from_millis(50),
        "Scenario B must spill with zero wait"
    );
    assert_eq!(r2.selected_node.node_key, "claude_vm:vm2");
    assert!(r2.stood_in);
    assert!(r2.preserve_machine_home);
    assert_eq!(
        r2.explain.affinity.why,
        Some(AffinityWhy::MachineHomeCapacitySpill)
    );

    // Commit S2 -> must NOT overwrite m1's home binding (vm1)!
    eng.commit(CommitRequest {
        lease_id: r2.lease_id.clone(),
    });
    release_ok(&eng, &r1.lease_id);
    release_ok(&eng, &r2.lease_id);

    // Check machine_sticks still points to vm1!
    let ms = eng.query_sticky(&StickyQuery {
        scope_kind: Some(StickyScopeKind::Machine),
        machine_id: Some(CompactString::const_new("m1")),
        ..Default::default()
    });
    assert_eq!(ms.total, 1);
    assert_eq!(ms.bindings[0].node_key, "claude_vm:vm1");

    // S3 on m1 now returns to vm1 automatically!
    let r3 = eng
        .acquire(base_req(
            "r3",
            "pool_1",
            "claude-sonnet-4",
            ModelFamily::Claude,
            "s3",
            Some("m1"),
        ))
        .await
        .unwrap();
    assert_eq!(r3.selected_node.node_key, "claude_vm:vm1");
    assert_eq!(r3.explain.affinity.why, Some(AffinityWhy::MachineHomeHit));
    release_ok(&eng, &r3.lease_id);
}

#[tokio::test]
async fn scenario_c_default_d2_spill_immediately_skips_machine_stage_and_preserves_home() {
    let eng = SchedulerEngine::new(EngineOptions::default());
    eng.bootstrap(BootstrapRequest {
        controller_epoch: CompactString::const_new("ep1"),
        role: Role::Leader,
        config_version: Some(1),
        config_snapshot: ConfigSnapshot {
            config_version: 1,
            pools: vec![PoolConfig {
                id: CompactString::const_new("pool_1"),
                // D2 default: SpillImmediately + session_busy_wait_ms = 0
                members: vec![
                    member_cfg("claude_vm:vm1", NodeType::ClaudeVm, "vm1", 1),
                    member_cfg("claude_vm:vm2", NodeType::ClaudeVm, "vm2", 2),
                    member_cfg("claude_vm:vm3", NodeType::ClaudeVm, "vm3", 3),
                ],
                ..Default::default()
            }],
            nodes: vec![
                node_cfg(
                    "claude_vm:vm1",
                    NodeType::ClaudeVm,
                    "vm1",
                    Provider::Anthropic,
                    9,
                    1,
                    1,
                ),
                node_cfg(
                    "claude_vm:vm2",
                    NodeType::ClaudeVm,
                    "vm2",
                    Provider::Anthropic,
                    8,
                    4,
                    4,
                ),
                node_cfg(
                    "claude_vm:vm3",
                    NodeType::ClaudeVm,
                    "vm3",
                    Provider::Anthropic,
                    5,
                    4,
                    4,
                ),
            ],
            ..Default::default()
        },
        active_sticky_bindings: vec![],
        active_penalties: vec![],
        initial_telemetry: vec![],
    });

    // Establish S1 pinned to vm1 and machine m1 homed on vm1
    let r1 = eng
        .acquire(base_req(
            "r1",
            "pool_1",
            "claude-sonnet-4",
            ModelFamily::Claude,
            "s1",
            Some("m1"),
        ))
        .await
        .unwrap();
    assert_eq!(r1.selected_node.node_key, "claude_vm:vm1");
    eng.commit(CommitRequest {
        lease_id: r1.lease_id.clone(),
    });
    release_ok(&eng, &r1.lease_id);

    // Another session S_other fills vm1 (cap 1/1)
    let ro = eng
        .acquire(base_req(
            "ro",
            "pool_1",
            "claude-sonnet-4",
            ModelFamily::Claude,
            "s_other",
            None,
        ))
        .await
        .unwrap();
    assert_eq!(ro.selected_node.node_key, "claude_vm:vm1");

    // Existing session S1 arrives again -> vm1 busy by other session -> D2 zero-wait immediate spill to vm2!
    let t0 = std::time::Instant::now();
    let r1_turn2 = eng
        .acquire(base_req(
            "r1_t2",
            "pool_1",
            "claude-sonnet-4",
            ModelFamily::Claude,
            "s1",
            Some("m1"),
        ))
        .await
        .unwrap();
    assert!(t0.elapsed() < Duration::from_millis(50));
    assert_eq!(r1_turn2.selected_node.node_key, "claude_vm:vm2");
    assert!(r1_turn2.preserve_machine_home);
    assert!(r1_turn2.stood_in);

    eng.commit(CommitRequest {
        lease_id: r1_turn2.lease_id.clone(),
    });
    release_ok(&eng, &r1_turn2.lease_id);
    release_ok(&eng, &ro.lease_id);

    // Session stick updated to vm2 (generation=2), while machine home stays vm1!
    let ss = eng.query_sticky(&StickyQuery {
        scope_kind: Some(StickyScopeKind::Session),
        session_id: Some(CompactString::const_new("s1")),
        ..Default::default()
    });
    assert_eq!(ss.bindings[0].node_key, "claude_vm:vm2");
    assert_eq!(ss.bindings[0].generation, 2);

    let ms = eng.query_sticky(&StickyQuery {
        scope_kind: Some(StickyScopeKind::Machine),
        machine_id: Some(CompactString::const_new("m1")),
        ..Default::default()
    });
    assert_eq!(ms.bindings[0].node_key, "claude_vm:vm1");
}

#[tokio::test]
async fn scenario_c_wait_then_spill_and_strict_policies() {
    let eng = Arc::new(SchedulerEngine::new(EngineOptions::default()));
    eng.bootstrap(BootstrapRequest {
        controller_epoch: CompactString::const_new("ep1"),
        role: Role::Leader,
        config_version: Some(1),
        config_snapshot: ConfigSnapshot {
            config_version: 1,
            pools: vec![
                PoolConfig {
                    id: CompactString::const_new("pool_wait"),
                    session_overflow_policy: SessionOverflowPolicy::WaitThenSpill,
                    session_busy_wait_ms: 250,
                    members: vec![
                        member_cfg("claude_vm:vm1", NodeType::ClaudeVm, "vm1", 1),
                        member_cfg("claude_vm:vm2", NodeType::ClaudeVm, "vm2", 2),
                    ],
                    ..Default::default()
                },
                PoolConfig {
                    id: CompactString::const_new("pool_strict"),
                    session_overflow_policy: SessionOverflowPolicy::Strict,
                    session_busy_wait_ms: 40,
                    members: vec![
                        member_cfg("claude_vm:vm3", NodeType::ClaudeVm, "vm3", 1),
                        member_cfg("claude_vm:vm4", NodeType::ClaudeVm, "vm4", 2),
                    ],
                    ..Default::default()
                },
            ],
            nodes: vec![
                node_cfg(
                    "claude_vm:vm1",
                    NodeType::ClaudeVm,
                    "vm1",
                    Provider::Anthropic,
                    9,
                    1,
                    1,
                ),
                node_cfg(
                    "claude_vm:vm2",
                    NodeType::ClaudeVm,
                    "vm2",
                    Provider::Anthropic,
                    8,
                    4,
                    4,
                ),
                node_cfg(
                    "claude_vm:vm3",
                    NodeType::ClaudeVm,
                    "vm3",
                    Provider::Anthropic,
                    9,
                    1,
                    1,
                ),
                node_cfg(
                    "claude_vm:vm4",
                    NodeType::ClaudeVm,
                    "vm4",
                    Provider::Anthropic,
                    8,
                    4,
                    4,
                ),
            ],
            ..Default::default()
        },
        active_sticky_bindings: vec![],
        active_penalties: vec![],
        initial_telemetry: vec![],
    });

    // 1. WaitThenSpill: release vm1 after 30ms -> S1 gets SessionHitAfterWait on vm1!
    let r1 = eng
        .acquire(base_req(
            "w1",
            "pool_wait",
            "m",
            ModelFamily::Claude,
            "sw",
            None,
        ))
        .await
        .unwrap();
    eng.commit(CommitRequest {
        lease_id: r1.lease_id.clone(),
    });
    release_ok(&eng, &r1.lease_id);

    let holder = eng
        .acquire(base_req(
            "wh",
            "pool_wait",
            "m",
            ModelFamily::Claude,
            "other",
            None,
        ))
        .await
        .unwrap();
    let eng_rel = Arc::clone(&eng);
    let h_lid = holder.lease_id.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(30)).await;
        release_ok(&eng_rel, &h_lid);
    });

    let r1_again = eng
        .acquire(base_req(
            "w2",
            "pool_wait",
            "m",
            ModelFamily::Claude,
            "sw",
            None,
        ))
        .await
        .unwrap();
    assert_eq!(r1_again.selected_node.node_key, "claude_vm:vm1");
    assert_eq!(
        r1_again.explain.affinity.why,
        Some(AffinityWhy::SessionHitAfterWait)
    );
    release_ok(&eng, &r1_again.lease_id);

    // 2. Strict: vm3 stays full -> returns 429 SessionNodeBusy!
    let rs1 = eng
        .acquire(base_req(
            "st1",
            "pool_strict",
            "m",
            ModelFamily::Claude,
            "ss",
            None,
        ))
        .await
        .unwrap();
    eng.commit(CommitRequest {
        lease_id: rs1.lease_id.clone(),
    });
    release_ok(&eng, &rs1.lease_id);

    let sholder = eng
        .acquire(base_req(
            "sh",
            "pool_strict",
            "m",
            ModelFamily::Claude,
            "other2",
            None,
        ))
        .await
        .unwrap();
    let err = eng
        .acquire(base_req(
            "st2",
            "pool_strict",
            "m",
            ModelFamily::Claude,
            "ss",
            None,
        ))
        .await
        .err()
        .unwrap();
    assert_eq!(err.code(), ErrorCode::SessionNodeBusy);
    assert_eq!(err.retry_after_sec(), Some(2));
    release_ok(&eng, &sholder.lease_id);
}

#[tokio::test]
async fn subagent_follows_parent_vm_and_respects_max_subagents_limit() {
    let eng = SchedulerEngine::new(EngineOptions::default());
    let mut vm1 = node_cfg(
        "claude_vm:vm1",
        NodeType::ClaudeVm,
        "vm1",
        Provider::Anthropic,
        5,
        8,
        8,
    );
    vm1.capacity.max_subagents_per_session = Some(1);
    let vm2 = node_cfg(
        "claude_vm:vm2",
        NodeType::ClaudeVm,
        "vm2",
        Provider::Anthropic,
        9,
        8,
        8,
    );

    eng.bootstrap(BootstrapRequest {
        controller_epoch: CompactString::const_new("ep1"),
        role: Role::Leader,
        config_version: Some(1),
        config_snapshot: ConfigSnapshot {
            config_version: 1,
            pools: vec![PoolConfig {
                id: CompactString::const_new("pool_1"),
                members: vec![
                    member_cfg("claude_vm:vm1", NodeType::ClaudeVm, "vm1", 1),
                    member_cfg("claude_vm:vm2", NodeType::ClaudeVm, "vm2", 2),
                ],
                ..Default::default()
            }],
            nodes: vec![vm1, vm2],
            ..Default::default()
        },
        active_sticky_bindings: vec![StickyBindingDto {
            scope_kind: StickyScopeKind::Session,
            pool_id: CompactString::const_new("pool_1"),
            model_family: ModelFamily::Claude,
            identity_id: CompactString::const_new("parent-uuid"),
            node_key: CompactString::const_new("claude_vm:vm1"),
            node_type: NodeType::ClaudeVm,
            node_id: CompactString::const_new("vm1"),
            machine_id: None,
            stood_in: false,
            bound_at_ms: scheduler_core::now_ms(),
            last_seen_ms: scheduler_core::now_ms(),
            expires_at_ms: scheduler_core::now_ms() + 60_000,
            hits: 1,
            generation: 1,
        }],
        active_penalties: vec![],
        initial_telemetry: vec![],
    });

    // Subagent 1 follows parent on vm1 (even though vm2 has higher tier 9!)
    let mut sub1 = base_req(
        "sub1",
        "pool_1",
        "claude-sonnet-4",
        ModelFamily::Claude,
        "sub-uuid-1",
        None,
    );
    sub1.parent_session_id = Some(CompactString::const_new("parent-uuid"));
    let r1 = eng.acquire(sub1).await.unwrap();
    assert_eq!(r1.selected_node.node_key, "claude_vm:vm1");
    assert_eq!(
        r1.explain.affinity.why,
        Some(AffinityWhy::SubagentFollowParent)
    );

    // Subagent 2 exceeds vm1's max_subagents_per_session=1 -> spills to vm2!
    let mut sub2 = base_req(
        "sub2",
        "pool_1",
        "claude-sonnet-4",
        ModelFamily::Claude,
        "sub-uuid-2",
        None,
    );
    sub2.parent_session_id = Some(CompactString::const_new("parent-uuid"));
    let r2 = eng.acquire(sub2).await.unwrap();
    assert_eq!(r2.selected_node.node_key, "claude_vm:vm2");

    release_ok(&eng, &r1.lease_id);
    release_ok(&eng, &r2.lease_id);
}

#[tokio::test]
async fn fallback_chain_depth_3_cycle_safe_and_turn2_continues_on_fallback_pool() {
    let eng = SchedulerEngine::new(EngineOptions::default());
    eng.bootstrap(BootstrapRequest {
        controller_epoch: CompactString::const_new("ep1"),
        role: Role::Leader,
        config_version: Some(1),
        config_snapshot: ConfigSnapshot {
            config_version: 1,
            pools: vec![
                PoolConfig {
                    id: CompactString::const_new("p1"),
                    fallback_pool_id: Some(CompactString::const_new("p2")),
                    queue_wait_ms: 0,
                    members: vec![member_cfg("claude_vm:v1", NodeType::ClaudeVm, "v1", 1)],
                    ..Default::default()
                },
                PoolConfig {
                    id: CompactString::const_new("p2"),
                    fallback_pool_id: Some(CompactString::const_new("p1")), // cycle back!
                    queue_wait_ms: 0,
                    members: vec![member_cfg("claude_vm:v2", NodeType::ClaudeVm, "v2", 1)],
                    ..Default::default()
                },
            ],
            nodes: vec![
                node_cfg(
                    "claude_vm:v1",
                    NodeType::ClaudeVm,
                    "v1",
                    Provider::Anthropic,
                    9,
                    1,
                    1,
                ),
                node_cfg(
                    "claude_vm:v2",
                    NodeType::ClaudeVm,
                    "v2",
                    Provider::Anthropic,
                    8,
                    4,
                    4,
                ),
            ],
            ..Default::default()
        },
        active_sticky_bindings: vec![],
        active_penalties: vec![],
        initial_telemetry: vec![],
    });

    let scope = ApiKeyScope {
        api_key_id: CompactString::const_new("k1"),
        pool_binding_mode: PoolBindingMode::StrictPool,
        default_pool_id: Some(CompactString::const_new("p1")),
        allowed_pool_ids: vec![
            CompactString::const_new("p1"),
            CompactString::const_new("p2"),
        ],
        ..Default::default()
    };

    // Fill v1 in p1
    let mut fill = base_req("fill", "p1", "m", ModelFamily::Claude, "s_fill", None);
    fill.api_key_scope = scope.clone();
    let r_fill = eng.acquire(fill).await.unwrap();
    assert_eq!(r_fill.resolved_pool_id, "p1");

    // Turn 1 of s1 falls back to p2
    let mut t1 = base_req("t1", "p1", "m", ModelFamily::Claude, "s1", None);
    t1.api_key_scope = scope.clone();
    let r_t1 = eng.acquire(t1).await.unwrap();
    assert_eq!(r_t1.resolved_pool_id, "p2");
    assert_eq!(r_t1.selected_node.node_key, "claude_vm:v2");
    assert_eq!(
        r_t1.explain.fallback_chain,
        vec![CompactString::const_new("p2")]
    );
    eng.commit(CommitRequest {
        lease_id: r_t1.lease_id.clone(),
    });
    release_ok(&eng, &r_t1.lease_id);

    // Free v1 in p1! Turn 2 of s1 MUST stay on p2 (locate_existing_session_pool)!
    release_ok(&eng, &r_fill.lease_id);
    let mut t2 = base_req("t2", "p1", "m", ModelFamily::Claude, "s1", None);
    t2.api_key_scope = scope;
    let r_t2 = eng.acquire(t2).await.unwrap();
    assert_eq!(r_t2.resolved_pool_id, "p2");
    assert_eq!(r_t2.selected_node.node_key, "claude_vm:v2");
    assert_eq!(r_t2.explain.affinity.why, Some(AffinityWhy::SessionHit));
    release_ok(&eng, &r_t2.lease_id);
}

#[tokio::test]
async fn anthropic_cross_prompt_fallback_blocked_unless_explicitly_allowed() {
    let eng = SchedulerEngine::new(EngineOptions::default());
    let snap = |allow: bool| ConfigSnapshot {
        config_version: if allow { 2 } else { 1 },
        pools: vec![
            PoolConfig {
                id: CompactString::const_new("p_official"),
                provider_scope: ProviderScope::Anthropic,
                system_prompt_mode: SystemPromptMode::Official,
                fallback_pool_id: Some(CompactString::const_new("p_zero")),
                allow_cross_prompt_fallback: allow,
                queue_wait_ms: 0,
                members: vec![member_cfg("claude_vm:v1", NodeType::ClaudeVm, "v1", 1)],
                ..Default::default()
            },
            PoolConfig {
                id: CompactString::const_new("p_zero"),
                provider_scope: ProviderScope::Anthropic,
                system_prompt_mode: SystemPromptMode::ZeroInject,
                queue_wait_ms: 0,
                members: vec![member_cfg("claude_vm:v2", NodeType::ClaudeVm, "v2", 1)],
                ..Default::default()
            },
        ],
        nodes: vec![
            node_cfg(
                "claude_vm:v1",
                NodeType::ClaudeVm,
                "v1",
                Provider::Anthropic,
                9,
                1,
                1,
            ),
            node_cfg(
                "claude_vm:v2",
                NodeType::ClaudeVm,
                "v2",
                Provider::Anthropic,
                8,
                4,
                4,
            ),
        ],
        ..Default::default()
    };

    eng.bootstrap(BootstrapRequest {
        controller_epoch: CompactString::const_new("ep1"),
        role: Role::Leader,
        config_version: Some(1),
        config_snapshot: snap(false),
        active_sticky_bindings: vec![],
        active_penalties: vec![],
        initial_telemetry: vec![],
    });

    let scope = ApiKeyScope {
        api_key_id: CompactString::const_new("k1"),
        pool_binding_mode: PoolBindingMode::StrictPool,
        default_pool_id: Some(CompactString::const_new("p_official")),
        allowed_pool_ids: vec![
            CompactString::const_new("p_official"),
            CompactString::const_new("p_zero"),
        ],
        ..Default::default()
    };

    // Occupy v1
    let mut fill = base_req("f", "p_official", "m", ModelFamily::Claude, "s_f", None);
    fill.api_key_scope = scope.clone();
    let rf = eng.acquire(fill).await.unwrap();

    // Blocked when allow_cross_prompt_fallback=false
    let mut r1 = base_req("r1", "p_official", "m", ModelFamily::Claude, "s1", None);
    r1.api_key_scope = scope.clone();
    let err = eng.acquire(r1).await.err().unwrap();
    assert_eq!(err.code(), ErrorCode::PoolExhausted);

    // Allowed when allow_cross_prompt_fallback=true
    eng.sync_config(ConfigSyncRequest {
        config_version: 2,
        config_snapshot: snap(true),
    });
    let mut r2 = base_req("r2", "p_official", "m", ModelFamily::Claude, "s2", None);
    r2.api_key_scope = scope;
    let ok = eng.acquire(r2).await.unwrap();
    assert_eq!(ok.resolved_pool_id, "p_zero");
    assert_eq!(ok.prompt_policy.mode, SystemPromptMode::ZeroInject);

    release_ok(&eng, &rf.lease_id);
    release_ok(&eng, &ok.lease_id);
}

#[tokio::test]
async fn mixed_pool_isolates_stickiness_by_model_family_and_locks_prompt_policy_by_provider() {
    let eng = SchedulerEngine::new(EngineOptions::default());
    let mut claude_node = node_cfg(
        "claude_vm:c1",
        NodeType::ClaudeVm,
        "c1",
        Provider::Anthropic,
        9,
        4,
        4,
    );
    claude_node.supported_models = vec![CompactString::const_new("claude-sonnet-4")];
    let mut gemini_node = node_cfg(
        "gemini_env:g1",
        NodeType::GeminiEnv,
        "g1",
        Provider::Google,
        9,
        4,
        4,
    );
    gemini_node.supported_models = vec![CompactString::const_new("gemini-2.5-pro")];
    let mut codex_node = node_cfg(
        "codex_vm:o1",
        NodeType::CodexVm,
        "o1",
        Provider::Openai,
        9,
        4,
        4,
    );
    codex_node.supported_models = vec![CompactString::const_new("gpt-5")];

    eng.bootstrap(BootstrapRequest {
        controller_epoch: CompactString::const_new("ep1"),
        role: Role::Leader,
        config_version: Some(1),
        config_snapshot: ConfigSnapshot {
            config_version: 1,
            pools: vec![PoolConfig {
                id: CompactString::const_new("pool_mixed"),
                provider_scope: ProviderScope::Mixed,
                system_prompt_mode: SystemPromptMode::ZeroInject,
                members: vec![
                    member_cfg("claude_vm:c1", NodeType::ClaudeVm, "c1", 1),
                    member_cfg("gemini_env:g1", NodeType::GeminiEnv, "g1", 2),
                    member_cfg("codex_vm:o1", NodeType::CodexVm, "o1", 3),
                ],
                ..Default::default()
            }],
            nodes: vec![claude_node, gemini_node, codex_node],
            ..Default::default()
        },
        active_sticky_bindings: vec![],
        active_penalties: vec![],
        initial_telemetry: vec![],
    });

    // Same session_id + machine_id across Claude, Gemini, OpenAI in SAME mixed pool!
    let rc = eng
        .acquire(base_req(
            "rc",
            "pool_mixed",
            "claude-sonnet-4",
            ModelFamily::Claude,
            "sid-shared",
            Some("mid-shared"),
        ))
        .await
        .unwrap();
    assert_eq!(rc.selected_node.node_key, "claude_vm:c1");
    assert_eq!(rc.prompt_policy.mode, SystemPromptMode::ZeroInject);
    assert_eq!(rc.prompt_policy.source, PromptPolicySource::Pool);
    eng.commit(CommitRequest {
        lease_id: rc.lease_id.clone(),
    });

    let rg = eng
        .acquire(base_req(
            "rg",
            "pool_mixed",
            "gemini-2.5-pro",
            ModelFamily::Gemini,
            "sid-shared",
            Some("mid-shared"),
        ))
        .await
        .unwrap();
    assert_eq!(rg.selected_node.node_key, "gemini_env:g1");
    assert_eq!(rg.prompt_policy.mode, SystemPromptMode::Passthrough);
    assert_eq!(rg.prompt_policy.source, PromptPolicySource::ProviderExempt);
    eng.commit(CommitRequest {
        lease_id: rg.lease_id.clone(),
    });

    let ro = eng
        .acquire(base_req(
            "ro",
            "pool_mixed",
            "gpt-5",
            ModelFamily::Openai,
            "sid-shared",
            Some("mid-shared"),
        ))
        .await
        .unwrap();
    assert_eq!(ro.selected_node.node_key, "codex_vm:o1");
    assert_eq!(ro.prompt_policy.mode, SystemPromptMode::Passthrough);
    assert_eq!(ro.prompt_policy.source, PromptPolicySource::ProviderExempt);
    eng.commit(CommitRequest {
        lease_id: ro.lease_id.clone(),
    });

    // All 3 families have independent sticky entries!
    let all_sticks = eng.query_sticky(&StickyQuery {
        pool_id: Some(CompactString::const_new("pool_mixed")),
        ..Default::default()
    });
    assert_eq!(all_sticks.total, 6, "3 session sticks + 3 machine sticks");

    release_ok(&eng, &rc.lease_id);
    release_ok(&eng, &rg.lease_id);
    release_ok(&eng, &ro.lease_id);
}

#[tokio::test]
async fn anthropic_inherit_global_override_append_and_official_prompt_policies() {
    let eng = SchedulerEngine::new(EngineOptions::default());
    eng.bootstrap(BootstrapRequest {
        controller_epoch: CompactString::const_new("ep1"),
        role: Role::Leader,
        config_version: Some(1),
        config_snapshot: ConfigSnapshot {
            config_version: 1,
            global_prompt_policy: GlobalPromptPolicy {
                mode: SystemPromptMode::Official,
                preset: CompactString::const_new("official_303"),
                text: String::new(),
                client_system_policy: ClientSystemPolicy::PrependPool,
            },
            pools: vec![
                PoolConfig {
                    id: CompactString::const_new("p_inherit"),
                    provider_scope: ProviderScope::Anthropic,
                    system_prompt_mode: SystemPromptMode::InheritGlobal,
                    members: vec![member_cfg("claude_vm:v1", NodeType::ClaudeVm, "v1", 1)],
                    ..Default::default()
                },
                PoolConfig {
                    id: CompactString::const_new("p_override"),
                    provider_scope: ProviderScope::Anthropic,
                    system_prompt_mode: SystemPromptMode::Override,
                    system_prompt_text: "custom prompt".to_owned(),
                    client_system_policy: ClientSystemPolicy::AppendPool,
                    members: vec![member_cfg("claude_vm:v1", NodeType::ClaudeVm, "v1", 1)],
                    ..Default::default()
                },
                PoolConfig {
                    id: CompactString::const_new("p_append"),
                    provider_scope: ProviderScope::Anthropic,
                    system_prompt_mode: SystemPromptMode::Append,
                    system_prompt_text: "tail note".to_owned(),
                    members: vec![member_cfg("claude_vm:v1", NodeType::ClaudeVm, "v1", 1)],
                    ..Default::default()
                },
            ],
            nodes: vec![node_cfg(
                "claude_vm:v1",
                NodeType::ClaudeVm,
                "v1",
                Provider::Anthropic,
                5,
                8,
                8,
            )],
            ..Default::default()
        },
        active_sticky_bindings: vec![],
        active_penalties: vec![],
        initial_telemetry: vec![],
    });

    let r_inh = eng
        .acquire(base_req(
            "r1",
            "p_inherit",
            "m",
            ModelFamily::Claude,
            "s1",
            None,
        ))
        .await
        .unwrap();
    assert_eq!(r_inh.prompt_policy.mode, SystemPromptMode::Official);
    assert_eq!(r_inh.prompt_policy.preset.as_deref(), Some("official_303"));
    assert_eq!(r_inh.prompt_policy.source, PromptPolicySource::Global);

    let r_ovr = eng
        .acquire(base_req(
            "r2",
            "p_override",
            "m",
            ModelFamily::Claude,
            "s2",
            None,
        ))
        .await
        .unwrap();
    assert_eq!(r_ovr.prompt_policy.mode, SystemPromptMode::Override);
    assert_eq!(r_ovr.prompt_policy.text.as_deref(), Some("custom prompt"));
    assert_eq!(
        r_ovr.prompt_policy.client_system_policy,
        Some(ClientSystemPolicy::AppendPool)
    );

    let r_app = eng
        .acquire(base_req(
            "r3",
            "p_append",
            "m",
            ModelFamily::Claude,
            "s3",
            None,
        ))
        .await
        .unwrap();
    assert_eq!(r_app.prompt_policy.mode, SystemPromptMode::Append);
    assert_eq!(r_app.prompt_policy.text.as_deref(), Some("tail note"));
    assert_eq!(r_app.prompt_policy.client_system_policy, None);

    release_ok(&eng, &r_inh.lease_id);
    release_ok(&eng, &r_ovr.lease_id);
    release_ok(&eng, &r_app.lease_id);
}

#[tokio::test]
async fn ephemeral_probe_never_writes_sticky_or_active_sessions() {
    let eng = SchedulerEngine::new(EngineOptions::default());
    eng.bootstrap(BootstrapRequest {
        controller_epoch: CompactString::const_new("ep1"),
        role: Role::Leader,
        config_version: Some(1),
        config_snapshot: ConfigSnapshot {
            config_version: 1,
            pools: vec![PoolConfig {
                id: CompactString::const_new("p1"),
                members: vec![member_cfg("claude_vm:v1", NodeType::ClaudeVm, "v1", 1)],
                ..Default::default()
            }],
            nodes: vec![node_cfg(
                "claude_vm:v1",
                NodeType::ClaudeVm,
                "v1",
                Provider::Anthropic,
                5,
                4,
                1,
            )],
            ..Default::default()
        },
        active_sticky_bindings: vec![],
        active_penalties: vec![],
        initial_telemetry: vec![],
    });

    let mut req = base_req("rp", "p1", "m", ModelFamily::Claude, "sp", Some("mp"));
    req.is_ephemeral_probe = true;
    let r = eng.acquire(req).await.unwrap();
    assert_eq!(eng.node_inflight("claude_vm:v1"), 1);
    assert_eq!(eng.node_active_sessions("claude_vm:v1"), 0);

    eng.commit(CommitRequest {
        lease_id: r.lease_id.clone(),
    });
    release_ok(&eng, &r.lease_id);

    assert_eq!(eng.query_sticky(&StickyQuery::default()).total, 0);
}

#[tokio::test]
async fn legacy_scope_key_and_allowed_node_keys_filtering() {
    let eng = SchedulerEngine::new(EngineOptions::default());
    eng.bootstrap(BootstrapRequest {
        controller_epoch: CompactString::const_new("ep1"),
        role: Role::Leader,
        config_version: Some(1),
        config_snapshot: ConfigSnapshot {
            config_version: 1,
            pools: vec![PoolConfig {
                id: CompactString::const_new("pool_legacy"),
                members: vec![
                    member_cfg("claude_vm:v1", NodeType::ClaudeVm, "v1", 1),
                    member_cfg("claude_vm:v2", NodeType::ClaudeVm, "v2", 2),
                ],
                ..Default::default()
            }],
            nodes: vec![
                node_cfg(
                    "claude_vm:v1",
                    NodeType::ClaudeVm,
                    "v1",
                    Provider::Anthropic,
                    10,
                    4,
                    4,
                ),
                node_cfg(
                    "claude_vm:v2",
                    NodeType::ClaudeVm,
                    "v2",
                    Provider::Anthropic,
                    5,
                    4,
                    4,
                ),
            ],
            ..Default::default()
        },
        active_sticky_bindings: vec![],
        active_penalties: vec![],
        initial_telemetry: vec![],
    });

    let mut r = base_req(
        "r1",
        "pool_legacy",
        "claude-sonnet-4",
        ModelFamily::Claude,
        "s1",
        None,
    );
    r.api_key_scope = ApiKeyScope {
        api_key_id: CompactString::const_new("legacy_k"),
        pool_binding_mode: PoolBindingMode::LegacyScope,
        default_pool_id: None,
        allowed_pool_ids: vec![],
        allowed_node_keys: vec![CompactString::const_new("claude_vm:v2")],
        ..Default::default()
    };
    let resp = eng.acquire(r).await.unwrap();
    assert_eq!(resp.selected_node.node_key, "claude_vm:v2");
    assert_eq!(
        resp.explain.excluded[0].reason,
        ExcludeReason::KeyScopeFiltered
    );
    release_ok(&eng, &resp.lease_id);
}

#[tokio::test]
async fn openai_and_google_provider_scope_pools_always_lock_passthrough_prompt() {
    let eng = SchedulerEngine::new(EngineOptions::default());
    eng.bootstrap(BootstrapRequest {
        controller_epoch: CompactString::const_new("ep1"),
        role: Role::Leader,
        config_version: Some(1),
        config_snapshot: ConfigSnapshot {
            config_version: 1,
            pools: vec![
                PoolConfig {
                    id: CompactString::const_new("p_openai"),
                    provider_scope: ProviderScope::Openai,
                    // Even if misconfigured with Official, Rust engine enforces passthrough!
                    system_prompt_mode: SystemPromptMode::Official,
                    members: vec![member_cfg("codex_vm:o1", NodeType::CodexVm, "o1", 1)],
                    ..Default::default()
                },
                PoolConfig {
                    id: CompactString::const_new("p_google"),
                    provider_scope: ProviderScope::Google,
                    system_prompt_mode: SystemPromptMode::Override,
                    system_prompt_text: "should never apply".to_owned(),
                    members: vec![member_cfg("gemini_env:g1", NodeType::GeminiEnv, "g1", 1)],
                    ..Default::default()
                },
            ],
            nodes: vec![
                node_cfg(
                    "codex_vm:o1",
                    NodeType::CodexVm,
                    "o1",
                    Provider::Openai,
                    8,
                    4,
                    4,
                ),
                node_cfg(
                    "gemini_env:g1",
                    NodeType::GeminiEnv,
                    "g1",
                    Provider::Google,
                    8,
                    4,
                    4,
                ),
            ],
            ..Default::default()
        },
        active_sticky_bindings: vec![],
        active_penalties: vec![],
        initial_telemetry: vec![],
    });

    let ro = eng
        .acquire(base_req(
            "ro",
            "p_openai",
            "gpt-5",
            ModelFamily::Openai,
            "s1",
            None,
        ))
        .await
        .unwrap();
    assert_eq!(ro.prompt_policy.mode, SystemPromptMode::Passthrough);
    assert_eq!(ro.prompt_policy.source, PromptPolicySource::ProviderExempt);

    let rg = eng
        .acquire(base_req(
            "rg",
            "p_google",
            "gemini-2.5-pro",
            ModelFamily::Gemini,
            "s2",
            None,
        ))
        .await
        .unwrap();
    assert_eq!(rg.prompt_policy.mode, SystemPromptMode::Passthrough);
    assert_eq!(rg.prompt_policy.source, PromptPolicySource::ProviderExempt);

    release_ok(&eng, &ro.lease_id);
    release_ok(&eng, &rg.lease_id);
}

#[tokio::test]
async fn fallback_chain_stops_at_max_depth_three() {
    let eng = SchedulerEngine::new(EngineOptions::default());
    let mk_pool = |id: &str, fb: Option<&str>, v: &str| PoolConfig {
        id: CompactString::from(id),
        fallback_pool_id: fb.map(CompactString::from),
        queue_wait_ms: 0,
        members: vec![member_cfg(
            &format!("claude_vm:{v}"),
            NodeType::ClaudeVm,
            v,
            1,
        )],
        ..Default::default()
    };
    eng.bootstrap(BootstrapRequest {
        controller_epoch: CompactString::const_new("ep1"),
        role: Role::Leader,
        config_version: Some(1),
        config_snapshot: ConfigSnapshot {
            config_version: 1,
            pools: vec![
                mk_pool("p1", Some("p2"), "v1"),
                mk_pool("p2", Some("p3"), "v2"),
                mk_pool("p3", Some("p4"), "v3"),
                mk_pool("p4", None, "v4"),
            ],
            nodes: vec![
                node_cfg(
                    "claude_vm:v1",
                    NodeType::ClaudeVm,
                    "v1",
                    Provider::Anthropic,
                    9,
                    1,
                    1,
                ),
                node_cfg(
                    "claude_vm:v2",
                    NodeType::ClaudeVm,
                    "v2",
                    Provider::Anthropic,
                    9,
                    1,
                    1,
                ),
                node_cfg(
                    "claude_vm:v3",
                    NodeType::ClaudeVm,
                    "v3",
                    Provider::Anthropic,
                    9,
                    1,
                    1,
                ),
                node_cfg(
                    "claude_vm:v4",
                    NodeType::ClaudeVm,
                    "v4",
                    Provider::Anthropic,
                    9,
                    4,
                    4,
                ),
            ],
            ..Default::default()
        },
        active_sticky_bindings: vec![],
        active_penalties: vec![],
        initial_telemetry: vec![],
    });

    let scope = ApiKeyScope {
        api_key_id: CompactString::const_new("k"),
        pool_binding_mode: PoolBindingMode::StrictPool,
        default_pool_id: Some(CompactString::const_new("p1")),
        allowed_pool_ids: vec![
            CompactString::const_new("p1"),
            CompactString::const_new("p2"),
            CompactString::const_new("p3"),
            CompactString::const_new("p4"),
        ],
        ..Default::default()
    };

    // Occupy v1, v2, v3 (pools at depth 1, 2, 3)
    let mut leases = Vec::new();
    for i in 1..=3 {
        let mut r = base_req(
            &format!("f{i}"),
            "p1",
            "m",
            ModelFamily::Claude,
            &format!("sf{i}"),
            None,
        );
        r.api_key_scope = scope.clone();
        leases.push(eng.acquire(r).await.unwrap().lease_id);
    }

    // 4th request must NOT traverse to depth-4 pool p4!
    let mut r4 = base_req("f4", "p1", "m", ModelFamily::Claude, "sf4", None);
    r4.api_key_scope = scope;
    let err = eng.acquire(r4).await.err().unwrap();
    assert_eq!(err.code(), ErrorCode::PoolExhausted);
    assert_eq!(
        err.to_envelope()
            .error
            .explain
            .unwrap()
            .fallback_chain
            .len(),
        2
    );

    for l in leases {
        release_ok(&eng, &l);
    }
}

#[tokio::test]
async fn cross_pool_sticky_isolation_for_same_session_and_machine() {
    let eng = SchedulerEngine::new(EngineOptions::default());
    eng.bootstrap(BootstrapRequest {
        controller_epoch: CompactString::const_new("ep1"),
        role: Role::Leader,
        config_version: Some(1),
        config_snapshot: ConfigSnapshot {
            config_version: 1,
            pools: vec![
                PoolConfig {
                    id: CompactString::const_new("p_a"),
                    members: vec![member_cfg("claude_vm:va", NodeType::ClaudeVm, "va", 1)],
                    ..Default::default()
                },
                PoolConfig {
                    id: CompactString::const_new("p_b"),
                    members: vec![member_cfg("claude_vm:vb", NodeType::ClaudeVm, "vb", 1)],
                    ..Default::default()
                },
            ],
            nodes: vec![
                node_cfg(
                    "claude_vm:va",
                    NodeType::ClaudeVm,
                    "va",
                    Provider::Anthropic,
                    9,
                    4,
                    4,
                ),
                node_cfg(
                    "claude_vm:vb",
                    NodeType::ClaudeVm,
                    "vb",
                    Provider::Anthropic,
                    9,
                    4,
                    4,
                ),
            ],
            ..Default::default()
        },
        active_sticky_bindings: vec![],
        active_penalties: vec![],
        initial_telemetry: vec![],
    });

    let ra = eng
        .acquire(base_req(
            "ra",
            "p_a",
            "m",
            ModelFamily::Claude,
            "same-s",
            Some("same-m"),
        ))
        .await
        .unwrap();
    eng.commit(CommitRequest {
        lease_id: ra.lease_id.clone(),
    });

    let rb = eng
        .acquire(base_req(
            "rb",
            "p_b",
            "m",
            ModelFamily::Claude,
            "same-s",
            Some("same-m"),
        ))
        .await
        .unwrap();
    eng.commit(CommitRequest {
        lease_id: rb.lease_id.clone(),
    });

    assert_eq!(ra.selected_node.node_key, "claude_vm:va");
    assert_eq!(rb.selected_node.node_key, "claude_vm:vb");
    assert_eq!(eng.query_sticky(&StickyQuery::default()).total, 4);

    release_ok(&eng, &ra.lease_id);
    release_ok(&eng, &rb.lease_id);
}

#[tokio::test]
async fn strict_tenant_isolation_blocks_shared_unowned_nodes() {
    let eng = SchedulerEngine::new(EngineOptions::default());
    let mut owned = node_cfg(
        "claude_vm:owned",
        NodeType::ClaudeVm,
        "owned",
        Provider::Anthropic,
        5,
        4,
        4,
    );
    owned.owner_id = Some(CompactString::const_new("tenant_1"));
    let shared = node_cfg(
        "claude_vm:shared",
        NodeType::ClaudeVm,
        "shared",
        Provider::Anthropic,
        10,
        4,
        4,
    );

    eng.bootstrap(BootstrapRequest {
        controller_epoch: CompactString::const_new("ep1"),
        role: Role::Leader,
        config_version: Some(1),
        config_snapshot: ConfigSnapshot {
            config_version: 1,
            pools: vec![PoolConfig {
                id: CompactString::const_new("p1"),
                members: vec![
                    member_cfg("claude_vm:shared", NodeType::ClaudeVm, "shared", 1),
                    member_cfg("claude_vm:owned", NodeType::ClaudeVm, "owned", 2),
                ],
                ..Default::default()
            }],
            nodes: vec![shared, owned],
            ..Default::default()
        },
        active_sticky_bindings: vec![],
        active_penalties: vec![],
        initial_telemetry: vec![],
    });

    let mut r = base_req("r1", "p1", "m", ModelFamily::Claude, "s1", None);
    r.api_key_scope.owner_id = Some(CompactString::const_new("tenant_1"));
    r.api_key_scope.strict_tenant_only = true;
    let resp = eng.acquire(r).await.unwrap();
    assert_eq!(resp.selected_node.node_key, "claude_vm:owned");
    assert_eq!(
        resp.explain.excluded[0].reason,
        ExcludeReason::TenantMismatch
    );
    release_ok(&eng, &resp.lease_id);
}

#[tokio::test]
async fn required_runtime_capabilities_filters_and_recovers_via_telemetry() {
    use std::collections::BTreeMap;

    let eng = SchedulerEngine::new(EngineOptions::default());
    let missing = node_cfg(
        "claude_vm:missing",
        NodeType::ClaudeVm,
        "missing",
        Provider::Anthropic,
        10,
        4,
        4,
    );
    let partial = node_cfg(
        "claude_vm:partial",
        NodeType::ClaudeVm,
        "partial",
        Provider::Anthropic,
        9,
        4,
        4,
    );
    let ready = node_cfg(
        "claude_vm:ready",
        NodeType::ClaudeVm,
        "ready",
        Provider::Anthropic,
        5,
        4,
        4,
    );

    let mut partial_caps = BTreeMap::new();
    partial_caps.insert("os_kvm_native_smbios".to_owned(), true);
    partial_caps.insert("vsock_transport_v1".to_owned(), false);

    let mut ready_caps = BTreeMap::new();
    ready_caps.insert("os_kvm_native_smbios".to_owned(), true);
    ready_caps.insert("vsock_transport_v1".to_owned(), true);

    eng.bootstrap(BootstrapRequest {
        controller_epoch: CompactString::const_new("ep1"),
        role: Role::Leader,
        config_version: Some(1),
        config_snapshot: ConfigSnapshot {
            config_version: 1,
            pools: vec![
                PoolConfig {
                    id: CompactString::const_new("p_kvm"),
                    required_runtime_capabilities: vec![
                        "os_kvm_native_smbios".to_owned(),
                        "vsock_transport_v1".to_owned(),
                    ],
                    members: vec![
                        member_cfg("claude_vm:missing", NodeType::ClaudeVm, "missing", 1),
                        member_cfg("claude_vm:partial", NodeType::ClaudeVm, "partial", 2),
                        member_cfg("claude_vm:ready", NodeType::ClaudeVm, "ready", 3),
                    ],
                    ..Default::default()
                },
                PoolConfig {
                    id: CompactString::const_new("p_legacy"),
                    members: vec![
                        member_cfg("claude_vm:missing", NodeType::ClaudeVm, "missing", 1),
                        member_cfg("claude_vm:ready", NodeType::ClaudeVm, "ready", 2),
                    ],
                    ..Default::default()
                },
                PoolConfig {
                    id: CompactString::const_new("p_strict_single"),
                    required_runtime_capabilities: vec![
                        "os_kvm_native_smbios".to_owned(),
                        "vsock_transport_v1".to_owned(),
                    ],
                    members: vec![member_cfg(
                        "claude_vm:missing",
                        NodeType::ClaudeVm,
                        "missing",
                        1,
                    )],
                    ..Default::default()
                },
            ],
            nodes: vec![missing, partial, ready],
            ..Default::default()
        },
        active_sticky_bindings: vec![],
        active_penalties: vec![],
        initial_telemetry: vec![
            NodeTelemetryUpdate {
                node_key: CompactString::const_new("claude_vm:partial"),
                runtime_capabilities: Some(partial_caps),
                ..Default::default()
            },
            NodeTelemetryUpdate {
                node_key: CompactString::const_new("claude_vm:ready"),
                runtime_capabilities: Some(ready_caps.clone()),
                ..Default::default()
            },
        ],
    });

    // Strict KVM pool admits only the node with all required capabilities=true.
    let resp = eng
        .acquire(base_req(
            "r_kvm_1",
            "p_kvm",
            "claude-sonnet-4",
            ModelFamily::Claude,
            "s_kvm_1",
            None,
        ))
        .await
        .unwrap();
    assert_eq!(resp.selected_node.node_key, "claude_vm:ready");
    let cap_excluded: Vec<&str> = resp
        .explain
        .excluded
        .iter()
        .filter(|e| e.reason == ExcludeReason::CapabilityMismatch)
        .map(|e| e.node.as_str())
        .collect();
    assert_eq!(cap_excluded, vec!["claude_vm:missing", "claude_vm:partial"]);
    release_ok(&eng, &resp.lease_id);

    // Legacy pool without required_runtime_capabilities admits highest-tier node regardless of caps.
    let legacy_resp = eng
        .acquire(base_req(
            "r_leg_1",
            "p_legacy",
            "claude-sonnet-4",
            ModelFamily::Claude,
            "s_leg_1",
            None,
        ))
        .await
        .unwrap();
    assert_eq!(legacy_resp.selected_node.node_key, "claude_vm:missing");
    release_ok(&eng, &legacy_resp.lease_id);

    // Single-node strict pool fails closed until telemetry reports required capabilities=true.
    let err = eng
        .acquire(base_req(
            "r_strict_fail",
            "p_strict_single",
            "claude-sonnet-4",
            ModelFamily::Claude,
            "s_strict_1",
            None,
        ))
        .await
        .err()
        .unwrap();
    assert_eq!(err.code(), ErrorCode::PoolExhausted);

    let explain = eng
        .explain(base_req(
            "r_strict_explain",
            "p_strict_single",
            "claude-sonnet-4",
            ModelFamily::Claude,
            "s_strict_1",
            None,
        ))
        .await
        .unwrap();
    assert_eq!(explain.explain.excluded.len(), 1);
    assert_eq!(
        explain.explain.excluded[0].reason,
        ExcludeReason::CapabilityMismatch
    );

    // Telemetry upgrade enables admission without config_version bump.
    let upd = eng.update_telemetry(TelemetryBatchRequest {
        nodes: vec![NodeTelemetryUpdate {
            node_key: CompactString::const_new("claude_vm:missing"),
            runtime_capabilities: Some(ready_caps),
            ..Default::default()
        }],
    });
    assert_eq!(upd.updated, 1);

    let recovered = eng
        .acquire(base_req(
            "r_strict_ok",
            "p_strict_single",
            "claude-sonnet-4",
            ModelFamily::Claude,
            "s_strict_2",
            None,
        ))
        .await
        .unwrap();
    assert_eq!(recovered.selected_node.node_key, "claude_vm:missing");
    release_ok(&eng, &recovered.lease_id);
}
