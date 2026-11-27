use crate::explain::DecisionExplain;
use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    Unauthorized,
    BadRequest,
    SchedulerNotBootstrapped,
    ConfigVersionTimeout,
    PoolUnavailable,
    PoolForbidden,
    Forbidden,
    StandbyDrainForbidden,
    NodeNotFound,
    LeaseNotFound,
    NodeBusy,
    SessionInFlight,
    SessionQueueFull,
    SessionQueueTimeout,
    SessionNodeBusy,
    PoolQueueFull,
    PoolExhausted,
    PoisonAbort,
    SnapshotRequired,
    InternalError,
}

impl ErrorCode {
    pub fn http_status_code(&self) -> u16 {
        match self {
            Self::Unauthorized => 401,
            Self::BadRequest => 400,
            Self::PoolUnavailable
            | Self::PoolForbidden
            | Self::Forbidden
            | Self::StandbyDrainForbidden => 403,
            Self::NodeNotFound | Self::LeaseNotFound => 404,
            Self::SnapshotRequired => 409,
            Self::PoisonAbort => 422,
            Self::SessionInFlight
            | Self::SessionQueueFull
            | Self::SessionQueueTimeout
            | Self::SessionNodeBusy
            | Self::PoolQueueFull => 429,
            Self::SchedulerNotBootstrapped
            | Self::ConfigVersionTimeout
            | Self::NodeBusy
            | Self::PoolExhausted => 503,
            Self::InternalError => 500,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ErrorBody {
    pub code: ErrorCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_sec: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub explain: Option<Box<DecisionExplain>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_epoch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oldest_seq: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_seq: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ErrorEnvelope {
    pub error: ErrorBody,
}

#[derive(Clone, Debug)]
pub enum ScheduleError {
    NotBootstrapped,
    ConfigVersionTimeout {
        requested: u64,
        current: u64,
    },
    BadRequest(String),
    PoolUnavailable(String),
    PoolForbidden(String),
    Forbidden(String),
    StandbyDrainForbidden,
    NodeNotFound(String),
    LeaseNotFound(String),
    NodeBusy {
        node_key: String,
        explain: Box<DecisionExplain>,
    },
    SessionInFlight,
    SessionQueueFull,
    SessionQueueTimeout,
    SessionNodeBusy {
        retry_after_sec: u64,
        explain: Box<DecisionExplain>,
    },
    PoolQueueFull {
        explain: Box<DecisionExplain>,
    },
    PoolExhausted {
        explain: Box<DecisionExplain>,
    },
    PoisonAbort {
        reason: String,
    },
    SnapshotRequired {
        message: String,
        current_epoch: String,
        oldest_seq: u64,
        latest_seq: u64,
    },
}

impl ScheduleError {
    pub fn code(&self) -> ErrorCode {
        match self {
            Self::NotBootstrapped => ErrorCode::SchedulerNotBootstrapped,
            Self::ConfigVersionTimeout { .. } => ErrorCode::ConfigVersionTimeout,
            Self::BadRequest(_) => ErrorCode::BadRequest,
            Self::PoolUnavailable(_) => ErrorCode::PoolUnavailable,
            Self::PoolForbidden(_) => ErrorCode::PoolForbidden,
            Self::Forbidden(_) => ErrorCode::Forbidden,
            Self::StandbyDrainForbidden => ErrorCode::StandbyDrainForbidden,
            Self::NodeNotFound(_) => ErrorCode::NodeNotFound,
            Self::LeaseNotFound(_) => ErrorCode::LeaseNotFound,
            Self::NodeBusy { .. } => ErrorCode::NodeBusy,
            Self::SessionInFlight => ErrorCode::SessionInFlight,
            Self::SessionQueueFull => ErrorCode::SessionQueueFull,
            Self::SessionQueueTimeout => ErrorCode::SessionQueueTimeout,
            Self::SessionNodeBusy { .. } => ErrorCode::SessionNodeBusy,
            Self::PoolQueueFull { .. } => ErrorCode::PoolQueueFull,
            Self::PoolExhausted { .. } => ErrorCode::PoolExhausted,
            Self::PoisonAbort { .. } => ErrorCode::PoisonAbort,
            Self::SnapshotRequired { .. } => ErrorCode::SnapshotRequired,
        }
    }

    pub fn http_status_code(&self) -> u16 {
        self.code().http_status_code()
    }

    pub fn retry_after_sec(&self) -> Option<u64> {
        match self {
            Self::SessionNodeBusy {
                retry_after_sec, ..
            } => Some(*retry_after_sec),
            Self::SessionInFlight
            | Self::SessionQueueFull
            | Self::SessionQueueTimeout
            | Self::PoolQueueFull { .. }
            | Self::NotBootstrapped
            | Self::ConfigVersionTimeout { .. }
            | Self::PoolExhausted { .. }
            | Self::NodeBusy { .. } => Some(1),
            _ => None,
        }
    }

    pub fn to_envelope(&self) -> ErrorEnvelope {
        let retry_after_sec = self.retry_after_sec();
        let (explain, current_epoch, oldest_seq, latest_seq) = match self {
            Self::NodeBusy { explain, .. }
            | Self::SessionNodeBusy { explain, .. }
            | Self::PoolQueueFull { explain }
            | Self::PoolExhausted { explain } => (Some(explain.clone()), None, None, None),
            Self::SnapshotRequired {
                current_epoch,
                oldest_seq,
                latest_seq,
                ..
            } => (
                None,
                Some(current_epoch.clone()),
                Some(*oldest_seq),
                Some(*latest_seq),
            ),
            _ => (None, None, None, None),
        };
        ErrorEnvelope {
            error: ErrorBody {
                code: self.code(),
                message: self.to_string(),
                retry_after_sec,
                explain,
                current_epoch,
                oldest_seq,
                latest_seq,
            },
        }
    }
}

impl fmt::Display for ScheduleError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotBootstrapped => write!(f, "scheduler has not completed bootstrap"),
            Self::ConfigVersionTimeout { requested, current } => {
                write!(
                    f,
                    "timed out waiting for config_version >= {requested} (current={current})"
                )
            }
            Self::BadRequest(m)
            | Self::PoolUnavailable(m)
            | Self::PoolForbidden(m)
            | Self::Forbidden(m)
            | Self::NodeNotFound(m)
            | Self::LeaseNotFound(m) => write!(f, "{m}"),
            Self::StandbyDrainForbidden => {
                write!(f, "persistence drain is forbidden in standby role")
            }
            Self::NodeBusy { node_key, .. } => write!(f, "pinned node {node_key} is busy"),
            Self::SessionInFlight => write!(f, "session already has an in-flight request"),
            Self::SessionQueueFull => write!(f, "session FIFO queue is full"),
            Self::SessionQueueTimeout => write!(f, "session FIFO queue wait timed out"),
            Self::SessionNodeBusy { .. } => {
                write!(f, "strict session sticky node is busy")
            }
            Self::PoolQueueFull { .. } => write!(f, "pool full-load queue is full"),
            Self::PoolExhausted { .. } => write!(f, "no eligible available node in pool"),
            Self::PoisonAbort { reason } => write!(f, "poison request aborted: {reason}"),
            Self::SnapshotRequired { message, .. } => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for ScheduleError {}
