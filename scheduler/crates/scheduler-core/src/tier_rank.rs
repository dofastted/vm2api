//! Stage 3: Strict `weight_tier` partitioning + 3 health sub-buckets + read-only prefix SWRR
//! preview + post-reservation SWRR commit + `MoveRound` sticky credit compensation.
//!
//! Lock hierarchy:
//! - Uses `AdmittedCandidate::metrics` captured in Stage 0, so `NodeMutable` and `SwrrRound`
//!   locks are NEVER nested.

use crate::admission::AdmittedCandidate;
use crate::node_state::NodeMetricsSnapshot;
use dashmap::DashMap;
use parking_lot::Mutex;
use scheduler_proto::{
    DecisionExplain, IntraTierStrategy, MemberRole, NodeKey, OrderEntry, PoolConfig, PoolId,
};
use std::cmp::{Ordering, Reverse};
use std::collections::{BTreeMap, HashMap};

pub const MAX_SWRR_CREDIT: i64 = 1_000_000;

#[derive(Clone, Debug, Eq, PartialEq, Hash)]
pub struct TierBucketKey {
    pub pool_id: PoolId,
    pub role_ord: u8,
    pub weight_tier: u16,
}

#[derive(Clone, Debug, Default)]
pub struct SwrrRound {
    pub currents: HashMap<NodeKey, i64>,
    pub last_picked: Option<NodeKey>,
    pub last_total_weight: i64,
}

#[inline]
pub fn role_ordinal(role: MemberRole) -> u8 {
    match role {
        MemberRole::Active => 0,
        MemberRole::Standby => 1,
    }
}

/// 3-segment health sub-bucket within the same weight tier:
/// - `0`: Healthy (`quota < 85% && sink_seq == 0`)
/// - `1`: Soft quota warning (`85% <= quota < 95% && sink_seq == 0`)
/// - `2`: Recently 429 Sunk (`sink_seq > 0`, ordered ascending by `sink_seq`)
#[inline]
pub fn health_sub_bucket(metrics: &NodeMetricsSnapshot) -> u8 {
    if metrics.sink_seq > 0 {
        2
    } else if metrics.max_quota_pct() >= 85.0 {
        1
    } else {
        0
    }
}

/// Pure, read-only ranking of eligible candidates (safe for `/explain` dry-run).
/// Never mutates `swrr_states` or node states.
pub fn rank_candidates<'a, 'b>(
    pool: &PoolConfig,
    eligible: &[&'a AdmittedCandidate<'b>],
    swrr_states: &DashMap<TierBucketKey, Mutex<SwrrRound>>,
    explain: &mut DecisionExplain,
) -> Vec<&'a AdmittedCandidate<'b>> {
    // 1. Strict partition: active (0) > standby (1); within role, effective_weight_tier DESC.
    let mut buckets: BTreeMap<(u8, Reverse<u16>), Vec<&'a AdmittedCandidate<'b>>> = BTreeMap::new();
    for &c in eligible {
        buckets
            .entry((
                role_ordinal(c.member_role),
                Reverse(c.effective_weight_tier),
            ))
            .or_default()
            .push(c);
    }

    let mut result = Vec::with_capacity(eligible.len());
    for ((role_ord, Reverse(tier)), mut group) in buckets {
        // 2. Sort within tier by health sub-bucket and pool intra-tier strategy.
        group.sort_by(|a, b| {
            let sa = &a.metrics;
            let sb = &b.metrics;
            let ba = health_sub_bucket(sa);
            let bb = health_sub_bucket(sb);
            ba.cmp(&bb)
                .then_with(|| {
                    if ba == 2 {
                        sa.sink_seq.cmp(&sb.sink_seq)
                    } else {
                        Ordering::Equal
                    }
                })
                .then_with(|| match pool.intra_tier_strategy {
                    IntraTierStrategy::LeastInflightSwrr => {
                        let avail_cmp = sb.has_free_slot().cmp(&sa.has_free_slot());
                        let load_band_a = sa.load_ratio_bps() / 1000;
                        let load_band_b = sb.load_ratio_bps() / 1000;
                        avail_cmp
                            .then_with(|| load_band_a.cmp(&load_band_b))
                            .then_with(|| sb.quota_headroom_bps().cmp(&sa.quota_headroom_bps()))
                            .then_with(|| a.member_order.cmp(&b.member_order))
                            .then_with(|| a.node_key.cmp(&b.node_key))
                    }
                    IntraTierStrategy::Fill => sb
                        .has_free_slot()
                        .cmp(&sa.has_free_slot())
                        .then_with(|| sb.load_ratio_bps().cmp(&sa.load_ratio_bps()))
                        .then_with(|| a.member_order.cmp(&b.member_order))
                        .then_with(|| a.node_key.cmp(&b.node_key)),
                    IntraTierStrategy::Ordered => a
                        .member_order
                        .cmp(&b.member_order)
                        .then_with(|| a.node_key.cmp(&b.node_key)),
                    IntraTierStrategy::Balanced => sb
                        .has_free_slot()
                        .cmp(&sa.has_free_slot())
                        .then_with(|| sa.load_ratio_bps().cmp(&sb.load_ratio_bps()))
                        .then_with(|| a.member_order.cmp(&b.member_order))
                        .then_with(|| a.node_key.cmp(&b.node_key)),
                })
        });

        // 3. Read-only SWRR preview ONLY on prefix slice where:
        //    `sub_bucket == 0 && has_free_slot && same lowest 10% load band`.
        //    Never rotates Sunk(2), soft-warn(1), or full nodes to the front!
        if pool.intra_tier_strategy == IntraTierStrategy::LeastInflightSwrr {
            let front_len = eligible_swrr_prefix_len(&group);
            if front_len > 1 {
                if let Some(best_idx) =
                    preview_swrr_winner(&pool.id, role_ord, tier, &group[..front_len], swrr_states)
                {
                    group[..front_len].rotate_left(best_idx);
                }
            }
        }

        result.extend(group);
    }

    explain.order = result
        .iter()
        .map(|c| {
            let m = &c.metrics;
            OrderEntry {
                node: c.node_key.clone(),
                tier: c.effective_weight_tier,
                sub_weight: c.sub_weight,
                sub_bucket: health_sub_bucket(m),
                in_flight: m.in_flight,
                max_conc: m.max_concurrency,
                active_sessions: m.active_sessions,
                max_sessions: m.max_sessions,
                sunk: m.sink_seq > 0,
            }
        })
        .collect();

    result
}

/// Count leading candidates eligible for SWRR rotation:
/// `sub_bucket == 0 && has_free_slot() && load_band == first_load_band`.
pub fn eligible_swrr_prefix_len(group: &[&AdmittedCandidate<'_>]) -> usize {
    let Some(first) = group.first() else {
        return 0;
    };
    let m0 = &first.metrics;
    if health_sub_bucket(m0) != 0 || !m0.has_free_slot() {
        return 0;
    }
    let first_band = m0.load_ratio_bps() / 1000;
    let mut len = 1;
    for cand in &group[1..] {
        let m = &cand.metrics;
        if health_sub_bucket(m) == 0
            && m.has_free_slot()
            && (m.load_ratio_bps() / 1000) == first_band
        {
            len += 1;
        } else {
            break;
        }
    }
    len
}

/// Read-only SWRR winner preview (zero state mutation).
fn preview_swrr_winner(
    pool_id: &PoolId,
    role_ord: u8,
    tier: u16,
    prefix: &[&AdmittedCandidate<'_>],
    swrr_states: &DashMap<TierBucketKey, Mutex<SwrrRound>>,
) -> Option<usize> {
    if prefix.len() <= 1 {
        return None;
    }
    let key = TierBucketKey {
        pool_id: pool_id.clone(),
        role_ord,
        weight_tier: tier,
    };

    let guard = swrr_states.get(&key);
    let round_opt = guard.as_ref().map(|entry| entry.lock());

    let mut best_idx = 0usize;
    let mut best_score = i64::MIN;

    for (idx, cand) in prefix.iter().enumerate() {
        let cur = round_opt
            .as_ref()
            .and_then(|r| r.currents.get(&cand.node_key).copied())
            .unwrap_or(0);
        let eff_w = cand.sub_weight.max(1) as i64;
        let score = cur.saturating_add(eff_w);
        if score > best_score {
            best_score = score;
            best_idx = idx;
        }
    }

    Some(best_idx)
}

/// Advance SWRR cursor AFTER a real slot reservation succeeded (`!dry_run`).
pub fn commit_swrr_pick(
    pool: &PoolConfig,
    picked: &AdmittedCandidate<'_>,
    all_admitted: &[AdmittedCandidate<'_>],
    swrr_states: &DashMap<TierBucketKey, Mutex<SwrrRound>>,
) {
    if pool.intra_tier_strategy != IntraTierStrategy::LeastInflightSwrr {
        return;
    }
    let role_ord = role_ordinal(picked.member_role);
    let tier = picked.effective_weight_tier;

    let mut peer_count = 0usize;
    let mut total_weight = 0i64;
    for c in all_admitted {
        if role_ordinal(c.member_role) == role_ord && c.effective_weight_tier == tier {
            peer_count += 1;
            total_weight += c.sub_weight.max(1) as i64;
        }
    }
    if peer_count <= 1 {
        return;
    }
    let total_weight = total_weight.max(1);

    let key = TierBucketKey {
        pool_id: pool.id.clone(),
        role_ord,
        weight_tier: tier,
    };
    let entry = swrr_states
        .entry(key)
        .or_insert_with(|| Mutex::new(SwrrRound::default()));
    let mut round = entry.lock();

    for cand in all_admitted {
        if role_ordinal(cand.member_role) == role_ord && cand.effective_weight_tier == tier {
            let cur = round.currents.entry(cand.node_key.clone()).or_insert(0);
            *cur = cur
                .saturating_add(cand.sub_weight.max(1) as i64)
                .clamp(-MAX_SWRR_CREDIT, MAX_SWRR_CREDIT);
        }
    }
    let picked_cur = round.currents.entry(picked.node_key.clone()).or_insert(0);
    *picked_cur = picked_cur
        .saturating_sub(total_weight)
        .clamp(-MAX_SWRR_CREDIT, MAX_SWRR_CREDIT);

    round.last_picked = Some(picked.node_key.clone());
    round.last_total_weight = total_weight;
}

/// `MoveRound` sticky credit compensation (Magpie `round.go:64-80`):
/// When Stage 1 (`SessionHit`) or Stage 2 (`MachineHomeHit`) keeps a request on `kept`,
/// refund the previously naturally-picked node and charge `kept` (clamped against overflow)
/// so subsequent new sessions naturally rebalance proportional weight shares.
pub fn compensate_swrr_for_sticky(
    pool: &PoolConfig,
    kept: &AdmittedCandidate<'_>,
    all_admitted: &[AdmittedCandidate<'_>],
    swrr_states: &DashMap<TierBucketKey, Mutex<SwrrRound>>,
) {
    if pool.intra_tier_strategy != IntraTierStrategy::LeastInflightSwrr {
        return;
    }
    let role_ord = role_ordinal(kept.member_role);
    let tier = kept.effective_weight_tier;

    let mut peer_count = 0usize;
    let mut tier_total = 0i64;
    for c in all_admitted {
        if role_ordinal(c.member_role) == role_ord && c.effective_weight_tier == tier {
            peer_count += 1;
            tier_total += c.sub_weight.max(1) as i64;
        }
    }
    if peer_count <= 1 {
        return;
    }
    let tier_total = tier_total.max(1);

    let key = TierBucketKey {
        pool_id: pool.id.clone(),
        role_ord,
        weight_tier: tier,
    };
    let entry = swrr_states
        .entry(key)
        .or_insert_with(|| Mutex::new(SwrrRound::default()));
    let mut round = entry.lock();

    match round.last_picked.clone() {
        Some(prev) if prev != kept.node_key => {
            let credit = if round.last_total_weight > 0 {
                round.last_total_weight
            } else {
                tier_total
            };
            let prev_cur = round.currents.entry(prev).or_insert(0);
            *prev_cur = prev_cur
                .saturating_add(credit)
                .clamp(-MAX_SWRR_CREDIT, MAX_SWRR_CREDIT);
            let kept_cur = round.currents.entry(kept.node_key.clone()).or_insert(0);
            *kept_cur = kept_cur
                .saturating_sub(credit)
                .clamp(-MAX_SWRR_CREDIT, MAX_SWRR_CREDIT);
            round.last_picked = Some(kept.node_key.clone());
            round.last_total_weight = credit;
        }
        Some(_) | None => {
            for cand in all_admitted {
                if role_ordinal(cand.member_role) == role_ord && cand.effective_weight_tier == tier
                {
                    let cur = round.currents.entry(cand.node_key.clone()).or_insert(0);
                    *cur = cur
                        .saturating_add(cand.sub_weight.max(1) as i64)
                        .clamp(-MAX_SWRR_CREDIT, MAX_SWRR_CREDIT);
                }
            }
            let kept_cur = round.currents.entry(kept.node_key.clone()).or_insert(0);
            *kept_cur = kept_cur
                .saturating_sub(tier_total)
                .clamp(-MAX_SWRR_CREDIT, MAX_SWRR_CREDIT);
            round.last_picked = Some(kept.node_key.clone());
            round.last_total_weight = tier_total;
        }
    }
}
