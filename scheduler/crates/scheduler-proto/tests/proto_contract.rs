use compact_str::CompactString;
use scheduler_proto::*;
use std::collections::HashSet;

#[test]
fn pool_config_defaults_match_locked_v4_decisions() {
    let p: PoolConfig = serde_json::from_str(r#"{"id":"pool_a1b2c3d4"}"#).unwrap();
    assert!(p.enabled);
    assert!(!p.exclusive_members, "D1 default must be false");
    assert_eq!(
        p.session_overflow_policy,
        SessionOverflowPolicy::SpillImmediately,
        "D2 default must be spill_immediately"
    );
    assert_eq!(p.session_busy_wait_ms, 0, "D2 default must be 0ms");
    assert_eq!(p.machine_ttl_seconds, 604_800, "default 1 week TTL");
    assert_eq!(p.session_ttl_seconds, 86_400, "default 24h TTL");
    assert_eq!(p.session_queue_max, 16);
    assert_eq!(p.session_queue_timeout_ms, 60_000);
    assert_eq!(p.queue_wait_ms, 15_000);
    assert_eq!(p.queue_max, 50);
    assert_eq!(p.intra_tier_strategy, IntraTierStrategy::LeastInflightSwrr);
    assert_eq!(p.system_prompt_mode, SystemPromptMode::InheritGlobal);
    assert!(!p.allow_cross_prompt_fallback);

    let g_default = GlobalPromptPolicy::default();
    assert_eq!(g_default.mode, SystemPromptMode::Official);
    assert_eq!(g_default.preset, "official_full");

    let g_deser: GlobalPromptPolicy = serde_json::from_str("{}").unwrap();
    assert_eq!(g_deser.mode, SystemPromptMode::Official);
    assert_eq!(g_deser.preset, "official_full");
}

#[test]
fn provider_scope_accepts_gemini_alias_as_google() {
    let scope: ProviderScope = serde_json::from_str(r#""gemini""#).unwrap();
    assert_eq!(scope, ProviderScope::Google);
    assert_eq!(serde_json::to_string(&scope).unwrap(), r#""google""#);
}

#[test]
fn provider_accepts_gemini_alias_as_google() {
    let p: Provider = serde_json::from_str(r#""gemini""#).unwrap();
    assert_eq!(p, Provider::Google);
    assert_eq!(serde_json::to_string(&p).unwrap(), r#""google""#);
}

#[test]
fn backend_node_weight_tier_clamping_and_auto_mode() {
    let mut n = BackendNodeConfig {
        node_key: CompactString::const_new("claude_vm:vm1"),
        node_type: NodeType::ClaudeVm,
        node_id: CompactString::const_new("vm1"),
        provider: Provider::Anthropic,
        protocol: None,
        owner_id: None,
        plan_tier: None,
        weight_tier_mode: WeightTierMode::Manual,
        weight_tier: 0,
        auto_weight_tier: Some(7),
        sub_weight: 10,
        supported_models: vec![],
        capacity: NodeCapacityConfig::default(),
        enabled: true,
    };
    assert_eq!(n.effective_base_weight_tier(), 1);
    n.weight_tier = 99;
    assert_eq!(n.effective_base_weight_tier(), 10);
    n.weight_tier_mode = WeightTierMode::Auto7dReset;
    assert_eq!(n.effective_base_weight_tier(), 7);
    n.auto_weight_tier = None;
    assert_eq!(n.effective_base_weight_tier(), 10);
}

#[test]
fn backend_node_anthropic_prompt_eligibility() {
    let make = |nt, prov, proto: Option<&str>| BackendNodeConfig {
        node_key: CompactString::const_new("k"),
        node_type: nt,
        node_id: CompactString::const_new("1"),
        provider: prov,
        protocol: proto.map(CompactString::from),
        owner_id: None,
        plan_tier: None,
        weight_tier_mode: WeightTierMode::Manual,
        weight_tier: 5,
        auto_weight_tier: None,
        sub_weight: 10,
        supported_models: vec![],
        capacity: NodeCapacityConfig::default(),
        enabled: true,
    };
    assert!(make(NodeType::ClaudeVm, Provider::Anthropic, None).is_anthropic_prompt_eligible());
    assert!(!make(NodeType::CodexVm, Provider::Openai, None).is_anthropic_prompt_eligible());
    assert!(!make(NodeType::GeminiEnv, Provider::Google, None).is_anthropic_prompt_eligible());
    assert!(
        make(
            NodeType::ApiEndpoint,
            Provider::ApiCustom,
            Some("anthropic")
        )
        .is_anthropic_prompt_eligible()
    );
    assert!(
        !make(NodeType::ApiEndpoint, Provider::ApiCustom, Some("openai"))
            .is_anthropic_prompt_eligible()
    );
    assert!(
        !make(NodeType::ApiEndpoint, Provider::ApiCustom, Some("google"))
            .is_anthropic_prompt_eligible()
    );
}

#[test]
fn scoped_session_and_machine_keys_isolate_pool_and_model_family() {
    let mut set = HashSet::new();
    set.insert(ScopedSessionKey::new("p1", ModelFamily::Claude, "s1"));
    set.insert(ScopedSessionKey::new("p2", ModelFamily::Claude, "s1"));
    set.insert(ScopedSessionKey::new("p1", ModelFamily::Gemini, "s1"));
    set.insert(ScopedSessionKey::new("p1", ModelFamily::Openai, "s1"));
    assert_eq!(set.len(), 4);

    let mut mset = HashSet::new();
    mset.insert(ScopedMachineKey::new("p1", ModelFamily::Claude, "m1"));
    mset.insert(ScopedMachineKey::new("p2", ModelFamily::Claude, "m1"));
    mset.insert(ScopedMachineKey::new("p1", ModelFamily::Gemini, "m1"));
    assert_eq!(mset.len(), 3);
}

#[test]
fn error_code_http_status_mappings_are_exact() {
    assert_eq!(ErrorCode::Unauthorized.http_status_code(), 401);
    assert_eq!(ErrorCode::BadRequest.http_status_code(), 400);
    assert_eq!(ErrorCode::PoolUnavailable.http_status_code(), 403);
    assert_eq!(ErrorCode::PoolForbidden.http_status_code(), 403);
    assert_eq!(ErrorCode::Forbidden.http_status_code(), 403);
    assert_eq!(ErrorCode::StandbyDrainForbidden.http_status_code(), 403);
    assert_eq!(ErrorCode::NodeNotFound.http_status_code(), 404);
    assert_eq!(ErrorCode::LeaseNotFound.http_status_code(), 404);
    assert_eq!(ErrorCode::SnapshotRequired.http_status_code(), 409);
    assert_eq!(ErrorCode::PoisonAbort.http_status_code(), 422);
    assert_eq!(ErrorCode::SessionInFlight.http_status_code(), 429);
    assert_eq!(ErrorCode::SessionQueueFull.http_status_code(), 429);
    assert_eq!(ErrorCode::SessionQueueTimeout.http_status_code(), 429);
    assert_eq!(ErrorCode::SessionNodeBusy.http_status_code(), 429);
    assert_eq!(ErrorCode::PoolQueueFull.http_status_code(), 429);
    assert_eq!(ErrorCode::SchedulerNotBootstrapped.http_status_code(), 503);
    assert_eq!(ErrorCode::ConfigVersionTimeout.http_status_code(), 503);
    assert_eq!(ErrorCode::NodeBusy.http_status_code(), 503);
    assert_eq!(ErrorCode::PoolExhausted.http_status_code(), 503);
    assert_eq!(ErrorCode::InternalError.http_status_code(), 500);
}

#[test]
fn schedule_error_envelope_carries_retry_after_and_cursor_metadata() {
    let e1 = ScheduleError::SessionNodeBusy {
        retry_after_sec: 2,
        explain: Box::new(DecisionExplain::default()),
    };
    let env1 = e1.to_envelope();
    assert_eq!(env1.error.code, ErrorCode::SessionNodeBusy);
    assert_eq!(env1.error.retry_after_sec, Some(2));
    assert!(env1.error.explain.is_some());

    let e2 = ScheduleError::SnapshotRequired {
        message: "evicted".to_owned(),
        current_epoch: "ep-9".to_owned(),
        oldest_seq: 100,
        latest_seq: 611,
    };
    let env2 = e2.to_envelope();
    assert_eq!(env2.error.code, ErrorCode::SnapshotRequired);
    assert_eq!(env2.error.current_epoch.as_deref(), Some("ep-9"));
    assert_eq!(env2.error.oldest_seq, Some(100));
    assert_eq!(env2.error.latest_seq, Some(611));
}

#[test]
fn acquire_response_has_no_fallback_candidates_field() {
    let resp = AcquireResponse {
        lease_id: CompactString::const_new("ls_1"),
        lease_ttl_ms: 120_000,
        selected_node: SelectedNodeInfo {
            node_key: CompactString::const_new("claude_vm:vm-01"),
            node_type: NodeType::ClaudeVm,
            node_id: CompactString::const_new("vm-01"),
            provider: Provider::Anthropic,
            effective_weight_tier: 9,
            sub_weight: 10,
        },
        resolved_pool_id: CompactString::const_new("pool_1"),
        prompt_policy: ResolvedPromptPolicy::default(),
        stood_in: false,
        preserve_machine_home: false,
        session_gate_wait_ms: 0,
        explain: DecisionExplain::default(),
    };
    let val = serde_json::to_value(&resp).unwrap();
    assert!(val.get("fallback_candidates").is_none());
    assert_eq!(val["selected_node"]["node_key"], "claude_vm:vm-01");
}

#[test]
fn telemetry_batch_accepts_nodes_and_updates_alias() {
    let a: TelemetryBatchRequest =
        serde_json::from_str(r#"{"nodes":[{"node_key":"claude_vm:vm1","schedulable":false}]}"#)
            .unwrap();
    let b: TelemetryBatchRequest =
        serde_json::from_str(r#"{"updates":[{"node_key":"claude_vm:vm1","schedulable":false}]}"#)
            .unwrap();
    assert_eq!(a.nodes.len(), 1);
    assert_eq!(b.nodes.len(), 1);
    assert_eq!(a.nodes[0].schedulable, Some(false));
}

#[test]
fn switch_heartbeat_commit_release_roundtrip() {
    let sw = SwitchRequest {
        release_lease_id: CompactString::const_new("ls_1"),
        failure: FailureReport {
            http_status: 529,
            error_class: ErrorClass::Overloaded529,
            error_signature: None,
            error_message: Some("overloaded".to_owned()),
            retry_after_sec: Some(15),
            quota_headers: None,
        },
        next_attempt: AcquireRequest {
            request_id: CompactString::const_new("req_1"),
            attempt_no: 2,
            controller_epoch: CompactString::const_new("ep1"),
            min_config_version: 1,
            origin_pool_id: CompactString::const_new("pool_1"),
            jev_downgrade_pool_id: None,
            api_key_scope: ApiKeyScope::default(),
            model: CompactString::const_new("claude-sonnet-4"),
            model_family: ModelFamily::Claude,
            protocol: CompactString::const_new("anthropic"),
            machine_id: None,
            session_id: CompactString::const_new("550e8400-e29b-41d4-a716-446655440000"),
            session_id_source: None,
            parent_session_id: None,
            is_ephemeral_probe: false,
            no_queue: false,
            is_admin_diagnostic: false,
            pin_node_key: None,
            exclude_nodes: vec![CompactString::const_new("claude_vm:vm1")],
        },
    };
    let encoded = serde_json::to_string(&sw).unwrap();
    let decoded: SwitchRequest = serde_json::from_str(&encoded).unwrap();
    assert_eq!(decoded.next_attempt.attempt_no, 2);
    assert_eq!(decoded.failure.http_status, 529);
}

#[test]
fn drain_request_defaults_and_response_roundtrip() {
    let dr: DrainRequest = serde_json::from_str("{}").unwrap();
    assert_eq!(dr.max_items, 500);
    assert_eq!(dr.ack_batch_id, None);
    assert!(!dr.ack_only);
}

#[test]
fn decision_explain_serializes_expected_fields() {
    let mut exp = DecisionExplain::new(
        "req_01",
        42,
        "pool_a1b2c3d4",
        "pool_a1b2c3d4",
        "claude-sonnet-4",
        false,
        true,
        Some(CompactString::const_new("generated_uuidv4")),
    );
    exp.set_gate_peek(true, 3);
    exp.set_affinity(
        AffinityWhy::MachineHomeCapacitySpill,
        &CompactString::const_new("claude_vm:vm-02"),
    );
    let val = serde_json::to_value(&exp).unwrap();
    assert_eq!(val["config_version"], 42);
    assert_eq!(val["session_gate"]["busy_at_peek"], true);
    assert_eq!(val["session_gate"]["queue_depth_at_peek"], 3);
    assert_eq!(val["affinity"]["why"], "machine_home_capacity_spill");
    assert_eq!(val["affinity"]["session_id_source"], "generated_uuidv4");
}

#[test]
fn resolved_prompt_policy_omits_none_fields() {
    let pol = ResolvedPromptPolicy {
        mode: SystemPromptMode::ZeroInject,
        preset: None,
        text: None,
        client_system_policy: None,
        source: PromptPolicySource::Pool,
    };
    let val = serde_json::to_value(&pol).unwrap();
    assert_eq!(val["mode"], "zero_inject");
    assert_eq!(val["source"], "pool");
    assert!(val.get("preset").is_none());
    assert!(val.get("text").is_none());
    assert!(val.get("client_system_policy").is_none());
}
