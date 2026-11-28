//! Codex soft quota gates + temp_unschedulable parking in admission (Refs #1874).

use compact_str::CompactString;
use dashmap::DashMap;
use scheduler_core::admission::filter_members;
use scheduler_core::node_state::NodeRuntimeState;
use scheduler_core::snapshot::IndexedSnapshot;
use scheduler_proto::AcquireRequest;
use scheduler_proto::{
    ApiKeyScope, BackendNodeConfig, CodexQuotaPolicy, ConfigSnapshot, MemberRole, ModelFamily,
    NodeCapacityConfig, NodeKey, NodeTelemetryUpdate, NodeType, PoolConfig, PoolMemberConfig,
    Provider,
};
use std::sync::Arc;

fn codex_node(id: &str, until_ms: Option<u64>, reason: Option<&str>) -> BackendNodeConfig {
    BackendNodeConfig {
        node_key: NodeKey::from(format!("codex_vm:{id}")),
        node_type: NodeType::CodexVm,
        node_id: CompactString::from(id),
        provider: Provider::Openai,
        protocol: Some(CompactString::const_new("openai")),
        owner_id: None,
        plan_tier: None,
        weight_tier_mode: Default::default(),
        weight_tier: 5,
        auto_weight_tier: None,
        sub_weight: 10,
        supported_models: vec![],
        capacity: NodeCapacityConfig::default(),
        enabled: true,
        temp_unschedulable_until_ms: until_ms,
        temp_unschedulable_reason: reason.map(str::to_string),
    }
}

fn claude_node(id: &str) -> BackendNodeConfig {
    BackendNodeConfig {
        node_key: NodeKey::from(format!("claude_vm:{id}")),
        node_type: NodeType::ClaudeVm,
        node_id: CompactString::from(id),
        provider: Provider::Anthropic,
        protocol: None,
        owner_id: None,
        plan_tier: None,
        weight_tier_mode: Default::default(),
        weight_tier: 5,
        auto_weight_tier: None,
        sub_weight: 10,
        supported_models: vec![],
        capacity: NodeCapacityConfig::default(),
        enabled: true,
        temp_unschedulable_until_ms: None,
        temp_unschedulable_reason: None,
    }
}

fn pool_with(node: BackendNodeConfig) -> PoolConfig {
    PoolConfig {
        id: CompactString::const_new("pool_codex"),
        members: vec![PoolMemberConfig {
            node_key: node.node_key.clone(),
            node_type: node.node_type,
            node_id: node.node_id.clone(),
            enabled: true,
            member_role: MemberRole::Active,
            weight_tier_override: None,
            sub_weight_override: None,
            member_order: 0,
        }],
        ..Default::default()
    }
}

fn make_req(model: &str, family: ModelFamily) -> AcquireRequest {
    AcquireRequest {
        request_id: CompactString::const_new("r-test"),
        attempt_no: 1,
        controller_epoch: CompactString::const_new("ep1"),
        min_config_version: 0,
        origin_pool_id: CompactString::const_new("pool_codex"),
        jev_downgrade_pool_id: None,
        api_key_scope: ApiKeyScope::default(),
        model: CompactString::from(model),
        model_family: family,
        protocol: CompactString::const_new(""),
        machine_id: None,
        session_id: CompactString::const_new("s1"),
        session_id_source: None,
        parent_session_id: None,
        is_ephemeral_probe: false,
        no_queue: false,
        is_admin_diagnostic: false,
        pin_node_key: None,
        exclude_nodes: vec![],
    }
}

fn seed_node(
    nodes: &DashMap<NodeKey, Arc<NodeRuntimeState>>,
    node_key: &NodeKey,
    telemetry: NodeTelemetryUpdate,
) {
    let rt = Arc::new(NodeRuntimeState::new());
    {
        let mut st = rt.inner.lock();
        st.apply_telemetry(&telemetry);
    }
    nodes.insert(node_key.clone(), rt);
}

#[test]
fn codex_soft_quota_uses_snapshot_fraction_not_hardcoded_95() {
    let node = codex_node("c1", None, None);
    let snap = IndexedSnapshot::from_config(ConfigSnapshot {
        config_version: 1,
        codex_quota: CodexQuotaPolicy {
            limit_5h: 0.8,
            limit_7d: 1.0,
        },
        pools: vec![pool_with(node.clone())],
        nodes: vec![node.clone()],
        ..Default::default()
    });
    let req = make_req("gpt-5.1-codex", ModelFamily::Openai);
    let pool = &snap.raw.pools[0];
    let nodes: DashMap<NodeKey, Arc<NodeRuntimeState>> = DashMap::new();
    seed_node(
        &nodes,
        &node.node_key,
        NodeTelemetryUpdate {
            node_key: node.node_key.clone(),
            quota_util_5h_pct: Some(79.0),
            quota_util_7d_pct: Some(10.0),
            ..Default::default()
        },
    );
    let (admitted, excluded) = filter_members(&snap, pool, &req, &nodes, 1_000);
    assert_eq!(admitted.len(), 1, "79% < 80% threshold should admit");
    assert!(excluded.is_empty());

    seed_node(
        &nodes,
        &node.node_key,
        NodeTelemetryUpdate {
            node_key: node.node_key.clone(),
            quota_util_5h_pct: Some(81.0),
            ..Default::default()
        },
    );
    let (_, excluded2) = filter_members(&snap, pool, &req, &nodes, 2_000);
    assert_eq!(excluded2.len(), 1);
    assert_eq!(
        excluded2[0].reason,
        scheduler_proto::ExcludeReason::QuotaExhausted
    );
}

#[test]
fn missing_codex_quota_object_defaults_to_legacy_95_percent() {
    assert!((CodexQuotaPolicy::default().limit_5h_percent() - 95.0).abs() < 0.01);
    let node = codex_node("c2", None, None);
    let snap = IndexedSnapshot::from_config(ConfigSnapshot {
        config_version: 1,
        pools: vec![pool_with(node.clone())],
        nodes: vec![node.clone()],
        ..Default::default()
    });
    let req = make_req("gpt-5.1-codex", ModelFamily::Openai);
    let nodes: DashMap<NodeKey, Arc<NodeRuntimeState>> = DashMap::new();
    seed_node(
        &nodes,
        &node.node_key,
        NodeTelemetryUpdate {
            node_key: node.node_key.clone(),
            quota_util_5h_pct: Some(94.0),
            ..Default::default()
        },
    );
    let (admitted, _) = filter_members(&snap, &snap.raw.pools[0], &req, &nodes, 3_000);
    assert_eq!(admitted.len(), 1);

    seed_node(
        &nodes,
        &node.node_key,
        NodeTelemetryUpdate {
            node_key: node.node_key.clone(),
            quota_util_5h_pct: Some(95.5),
            ..Default::default()
        },
    );
    let (_, excluded) = filter_members(&snap, &snap.raw.pools[0], &req, &nodes, 4_000);
    assert_eq!(excluded.len(), 1);
}

#[test]
fn invalid_quota_fraction_falls_back_to_legacy_95() {
    let policy = CodexQuotaPolicy {
        limit_5h: f64::NAN,
        limit_7d: 1.0,
    };
    assert!((policy.limit_5h_percent() - 95.0).abs() < 0.01);
}

#[test]
fn claude_nodes_keep_legacy_95_gate() {
    let node = claude_node("v1");
    let snap = IndexedSnapshot::from_config(ConfigSnapshot {
        config_version: 1,
        codex_quota: CodexQuotaPolicy {
            limit_5h: 1.0,
            limit_7d: 1.0,
        },
        pools: vec![pool_with(node.clone())],
        nodes: vec![node.clone()],
        ..Default::default()
    });
    let req = make_req("claude-sonnet-4", ModelFamily::Claude);
    let nodes: DashMap<NodeKey, Arc<NodeRuntimeState>> = DashMap::new();
    seed_node(
        &nodes,
        &node.node_key,
        NodeTelemetryUpdate {
            node_key: node.node_key.clone(),
            quota_util_7d_pct: Some(96.0),
            ..Default::default()
        },
    );
    let (_, excluded) = filter_members(&snap, &snap.raw.pools[0], &req, &nodes, 5_000);
    assert_eq!(excluded.len(), 1);
}

#[test]
fn temp_unschedulable_parks_slot_from_snapshot_baseline() {
    let until = 9_000_000u64;
    let node = codex_node("p1", Some(until), Some("quota_5h_local"));
    let snap = IndexedSnapshot::from_config(ConfigSnapshot {
        config_version: 1,
        pools: vec![pool_with(node.clone())],
        nodes: vec![node.clone()],
        ..Default::default()
    });
    let req = make_req("gpt-5.1-codex", ModelFamily::Openai);
    let nodes: DashMap<NodeKey, Arc<NodeRuntimeState>> = DashMap::new();
    let (_, excluded) = filter_members(&snap, &snap.raw.pools[0], &req, &nodes, until - 1);
    assert_eq!(excluded.len(), 1);
    assert_eq!(
        excluded[0].reason,
        scheduler_proto::ExcludeReason::NotSchedulable
    );
    assert!(excluded[0].detail.contains("quota_5h_local"));

    let (admitted_later, _) = filter_members(&snap, &snap.raw.pools[0], &req, &nodes, until + 1);
    assert_eq!(admitted_later.len(), 1);
}

#[test]
fn temp_unschedulable_early_clear_via_telemetry_null_re_admits_despite_stale_snapshot() {
    let until = 9_000_000u64;
    let node = codex_node("clr", Some(until), Some("quota_5h_local"));
    let snap = IndexedSnapshot::from_config(ConfigSnapshot {
        config_version: 1,
        pools: vec![pool_with(node.clone())],
        nodes: vec![node.clone()],
        ..Default::default()
    });
    let req = make_req("gpt-5.1-codex", ModelFamily::Openai);
    let nodes: DashMap<NodeKey, Arc<NodeRuntimeState>> = DashMap::new();

    seed_node(
        &nodes,
        &node.node_key,
        NodeTelemetryUpdate {
            node_key: node.node_key.clone(),
            schedulable: Some(false),
            temp_unschedulable_until_ms: Some(Some(until)),
            temp_unschedulable_reason: Some(Some(CompactString::const_new("quota_5h_local"))),
            ..Default::default()
        },
    );
    let (_, excluded) = filter_members(&snap, &snap.raw.pools[0], &req, &nodes, until - 1);
    assert_eq!(excluded.len(), 1);

    let rt = nodes.get(&node.node_key).unwrap();
    let clear = NodeTelemetryUpdate {
        node_key: node.node_key.clone(),
        schedulable: Some(true),
        temp_unschedulable_until_ms: Some(None),
        temp_unschedulable_reason: Some(None),
        ..Default::default()
    };
    {
        let mut st = rt.inner.lock();
        st.apply_telemetry(&clear);
    }
    assert_eq!(rt.inner.lock().temp_unschedulable_until_ms, None);

    let (admitted, excluded_after) =
        filter_members(&snap, &snap.raw.pools[0], &req, &nodes, until - 1);
    assert_eq!(
        excluded_after.len(),
        0,
        "cleared telemetry must override stale snapshot until"
    );
    assert_eq!(admitted.len(), 1);
    assert!(rt.inner.lock().temp_park_live_authoritative);
}

#[test]
fn temp_unschedulable_early_clear_via_zero_re_admits_despite_stale_snapshot() {
    let until = 9_000_000u64;
    let node = codex_node("z0", Some(until), Some("quota_5h_local"));
    let snap = IndexedSnapshot::from_config(ConfigSnapshot {
        config_version: 1,
        pools: vec![pool_with(node.clone())],
        nodes: vec![node.clone()],
        ..Default::default()
    });
    let req = make_req("gpt-5.1-codex", ModelFamily::Openai);
    let nodes: DashMap<NodeKey, Arc<NodeRuntimeState>> = DashMap::new();
    seed_node(
        &nodes,
        &node.node_key,
        NodeTelemetryUpdate {
            node_key: node.node_key.clone(),
            schedulable: Some(false),
            temp_unschedulable_until_ms: Some(Some(until)),
            temp_unschedulable_reason: Some(Some(CompactString::const_new("quota_5h_local"))),
            ..Default::default()
        },
    );
    let rt = nodes.get(&node.node_key).unwrap();
    {
        let mut st = rt.inner.lock();
        st.apply_telemetry(&NodeTelemetryUpdate {
            node_key: node.node_key.clone(),
            schedulable: Some(true),
            temp_unschedulable_until_ms: Some(Some(0)),
            temp_unschedulable_reason: Some(None),
            ..Default::default()
        });
    }
    let (admitted, excluded) = filter_members(&snap, &snap.raw.pools[0], &req, &nodes, until - 1);
    assert_eq!(excluded.len(), 0);
    assert_eq!(admitted.len(), 1);
}
