//! 512-capacity SSE event ring buffer with `epoch:seq` cursor validation.

use compact_str::CompactString;
use parking_lot::Mutex;
use scheduler_proto::{
    NodeKey, PoolId, RequestId, ScheduleError, SchedulerEvent, SchedulerEventKind,
};
use std::collections::VecDeque;
use tokio::sync::broadcast;

pub const EVENT_RING_CAPACITY: usize = 512;

struct RingState {
    epoch: CompactString,
    latest_seq: u64,
    buffer: VecDeque<SchedulerEvent>,
}

pub struct EventRingBuffer {
    state: Mutex<RingState>,
    tx: broadcast::Sender<SchedulerEvent>,
}

impl EventRingBuffer {
    pub fn new(initial_epoch: impl AsRef<str>) -> Self {
        let (tx, _) = broadcast::channel(EVENT_RING_CAPACITY);
        Self {
            state: Mutex::new(RingState {
                epoch: CompactString::from(initial_epoch.as_ref()),
                latest_seq: 0,
                buffer: VecDeque::with_capacity(EVENT_RING_CAPACITY),
            }),
            tx,
        }
    }

    /// Reset cursor epoch (called on `/bootstrap` with a new `controller_epoch`).
    pub fn set_epoch(&self, epoch: impl AsRef<str>) {
        let mut g = self.state.lock();
        if g.epoch.as_str() != epoch.as_ref() {
            g.epoch = CompactString::from(epoch.as_ref());
            g.latest_seq = 0;
            g.buffer.clear();
        }
    }

    pub fn current_epoch(&self) -> CompactString {
        self.state.lock().epoch.clone()
    }

    pub fn emit(
        &self,
        kind: SchedulerEventKind,
        pool_id: Option<PoolId>,
        node_key: Option<NodeKey>,
        request_id: Option<RequestId>,
        detail: Option<String>,
    ) -> SchedulerEvent {
        let event = {
            let mut g = self.state.lock();
            g.latest_seq += 1;
            let seq = g.latest_seq;
            let epoch = g.epoch.clone();
            let ev = SchedulerEvent {
                cursor: format!("{epoch}:{seq}"),
                epoch,
                seq,
                ts_ms: crate::now_ms(),
                kind,
                pool_id,
                node_key,
                request_id,
                detail,
            };
            if g.buffer.len() >= EVENT_RING_CAPACITY {
                g.buffer.pop_front();
            }
            g.buffer.push_back(ev.clone());
            ev
        };
        let _ = self.tx.send(event.clone());
        event
    }

    /// Validate optional `after=<epoch:seq>` cursor and return `(replay_events, live_rx)`.
    /// Returns `ScheduleError::SnapshotRequired` (HTTP 409) when cursor epoch mismatches
    /// or `seq` has fallen behind the 512-event ring window.
    pub fn subscribe(
        &self,
        after: Option<&str>,
    ) -> Result<(Vec<SchedulerEvent>, broadcast::Receiver<SchedulerEvent>), ScheduleError> {
        let g = self.state.lock();
        let oldest_seq = g.buffer.front().map(|e| e.seq).unwrap_or(0);
        let latest_seq = g.latest_seq;

        let replay = match after.map(str::trim).filter(|s| !s.is_empty()) {
            None => Vec::new(),
            Some(cursor) => {
                let Some((req_epoch, req_seq_str)) = cursor.rsplit_once(':') else {
                    return Err(ScheduleError::SnapshotRequired {
                        message: format!("invalid cursor '{cursor}', expected '<epoch>:<seq>'"),
                        current_epoch: g.epoch.to_string(),
                        oldest_seq,
                        latest_seq,
                    });
                };
                let Ok(req_seq) = req_seq_str.parse::<u64>() else {
                    return Err(ScheduleError::SnapshotRequired {
                        message: format!("invalid sequence in cursor '{cursor}'"),
                        current_epoch: g.epoch.to_string(),
                        oldest_seq,
                        latest_seq,
                    });
                };

                if req_epoch != g.epoch.as_str() {
                    return Err(ScheduleError::SnapshotRequired {
                        message: format!(
                            "cursor epoch '{req_epoch}' does not match current epoch '{}'",
                            g.epoch
                        ),
                        current_epoch: g.epoch.to_string(),
                        oldest_seq,
                        latest_seq,
                    });
                }

                // If req_seq == latest_seq, client is fully caught up (empty replay).
                if req_seq > latest_seq {
                    return Err(ScheduleError::SnapshotRequired {
                        message: format!(
                            "cursor seq {req_seq} is ahead of latest seq {latest_seq}"
                        ),
                        current_epoch: g.epoch.to_string(),
                        oldest_seq,
                        latest_seq,
                    });
                }

                // If any event after req_seq has been evicted (oldest_seq > req_seq + 1),
                // client missed events and must re-snapshot.
                if latest_seq > req_seq && oldest_seq > req_seq.saturating_add(1) {
                    return Err(ScheduleError::SnapshotRequired {
                        message: format!(
                            "cursor seq {req_seq} evicted from {EVENT_RING_CAPACITY}-event ring (oldest={oldest_seq}, latest={latest_seq})"
                        ),
                        current_epoch: g.epoch.to_string(),
                        oldest_seq,
                        latest_seq,
                    });
                }

                g.buffer
                    .iter()
                    .filter(|e| e.seq > req_seq)
                    .cloned()
                    .collect()
            }
        };

        let rx = self.tx.subscribe();
        Ok((replay, rx))
    }
}
