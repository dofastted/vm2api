pub mod admission;
pub mod affinity;
pub mod delta;
pub mod engine;
pub mod events;
pub mod health;
pub mod lease;
pub mod node_state;
pub mod session_gate;
pub mod snapshot;
pub mod tier_rank;

pub use engine::{EngineOptions, SchedulerEngine};
pub use session_gate::{GateHoldGuard, GateToken, SessionGateTable};

use std::time::{SystemTime, UNIX_EPOCH};

#[inline]
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
