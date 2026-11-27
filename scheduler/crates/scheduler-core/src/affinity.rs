//! Pool + model_family isolated L1 session stickiness and L2 machine stickiness.

use crate::snapshot::IndexedSnapshot;
use compact_str::CompactString;
use dashmap::DashMap;
use scheduler_proto::{
    AcquireRequest, NodeKey, NodeType, PoolConfig, PoolId, ScopedMachineKey, ScopedSessionKey,
    StickyBindingDto, StickyScopeKind,
};
use smallvec::SmallVec;

#[derive(Clone, Debug)]
pub struct SessionStick {
    pub pinned_node: NodeKey,
    pub node_type: NodeType,
    pub node_id: CompactString,
    pub machine_id: Option<CompactString>,
    pub stood_in: bool,
    pub bound_at_ms: u64,
    pub last_seen_ms: u64,
    pub expires_at_ms: u64,
    pub hits: u64,
    pub generation: u64,
}

impl SessionStick {
    pub fn to_dto(&self, key: &ScopedSessionKey) -> StickyBindingDto {
        StickyBindingDto {
            scope_kind: StickyScopeKind::Session,
            pool_id: key.pool_id.clone(),
            model_family: key.model_family,
            identity_id: key.session_id.clone(),
            node_key: self.pinned_node.clone(),
            node_type: self.node_type,
            node_id: self.node_id.clone(),
            machine_id: self.machine_id.clone(),
            stood_in: self.stood_in,
            bound_at_ms: self.bound_at_ms,
            last_seen_ms: self.last_seen_ms,
            expires_at_ms: self.expires_at_ms,
            hits: self.hits,
            generation: self.generation,
        }
    }

    pub fn from_dto(dto: &StickyBindingDto) -> Self {
        Self {
            pinned_node: dto.node_key.clone(),
            node_type: dto.node_type,
            node_id: dto.node_id.clone(),
            machine_id: dto.machine_id.clone(),
            stood_in: dto.stood_in,
            bound_at_ms: dto.bound_at_ms,
            last_seen_ms: dto.last_seen_ms,
            expires_at_ms: dto.expires_at_ms,
            hits: dto.hits,
            generation: dto.generation.max(1),
        }
    }
}

#[derive(Clone, Debug)]
pub struct MachineStick {
    pub home_node: NodeKey,
    pub node_type: NodeType,
    pub node_id: CompactString,
    pub bound_at_ms: u64,
    pub last_seen_ms: u64,
    pub expires_at_ms: u64,
    pub hits: u64,
    pub generation: u64,
}

impl MachineStick {
    pub fn to_dto(&self, key: &ScopedMachineKey) -> StickyBindingDto {
        StickyBindingDto {
            scope_kind: StickyScopeKind::Machine,
            pool_id: key.pool_id.clone(),
            model_family: key.model_family,
            identity_id: key.machine_id.clone(),
            node_key: self.home_node.clone(),
            node_type: self.node_type,
            node_id: self.node_id.clone(),
            machine_id: Some(key.machine_id.clone()),
            stood_in: false,
            bound_at_ms: self.bound_at_ms,
            last_seen_ms: self.last_seen_ms,
            expires_at_ms: self.expires_at_ms,
            hits: self.hits,
            generation: self.generation,
        }
    }

    pub fn from_dto(dto: &StickyBindingDto) -> Self {
        Self {
            home_node: dto.node_key.clone(),
            node_type: dto.node_type,
            node_id: dto.node_id.clone(),
            bound_at_ms: dto.bound_at_ms,
            last_seen_ms: dto.last_seen_ms,
            expires_at_ms: dto.expires_at_ms,
            hits: dto.hits,
            generation: dto.generation.max(1),
        }
    }
}

pub fn get_live_session_stick(
    sticks: &DashMap<ScopedSessionKey, SessionStick>,
    key: &ScopedSessionKey,
    now_ms: u64,
) -> Option<SessionStick> {
    if let Some(entry) = sticks.get(key) {
        if now_ms <= entry.expires_at_ms {
            return Some(entry.clone());
        }
    }
    None
}

pub fn get_live_machine_stick(
    sticks: &DashMap<ScopedMachineKey, MachineStick>,
    key: &ScopedMachineKey,
    now_ms: u64,
) -> Option<MachineStick> {
    if let Some(entry) = sticks.get(key) {
        if now_ms <= entry.expires_at_ms {
            return Some(entry.clone());
        }
    }
    None
}

/// If a session previously landed on an authorized fallback pool (depth <= 3), locate that
/// fallback pool so follow-up turns preserve conversation continuity.
pub fn locate_existing_session_pool<'a>(
    snap: &'a IndexedSnapshot,
    start_pool: &'a PoolConfig,
    req: &AcquireRequest,
    session_sticks: &DashMap<ScopedSessionKey, SessionStick>,
    now_ms: u64,
) -> &'a PoolConfig {
    if start_pool.session_sticky_enabled {
        let start_key = ScopedSessionKey::new(&start_pool.id, req.model_family, &req.session_id);
        if get_live_session_stick(session_sticks, &start_key, now_ms).is_some() {
            return start_pool;
        }
    }

    let mut visited = SmallVec::<[PoolId; 4]>::new();
    visited.push(start_pool.id.clone());
    let mut cur = start_pool;

    while visited.len() < 3 {
        let Some(next_id) = cur.fallback_pool_id.as_ref() else {
            break;
        };
        if visited.contains(next_id) {
            break;
        }
        let Ok(next_pool) = snap.resolve_authorized_pool(next_id, &req.api_key_scope) else {
            break;
        };
        if !snap.fallback_prompt_allowed(cur, next_pool) {
            break;
        }
        visited.push(next_pool.id.clone());
        if next_pool.session_sticky_enabled {
            let key = ScopedSessionKey::new(&next_pool.id, req.model_family, &req.session_id);
            if get_live_session_stick(session_sticks, &key, now_ms).is_some() {
                return next_pool;
            }
        }
        cur = next_pool;
    }

    start_pool
}
