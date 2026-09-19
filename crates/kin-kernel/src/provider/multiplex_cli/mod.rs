//! One Claude OS process, N slots.
//!
//! Jobs go to the CLI's stdin as `kin_job_start`; the CLI hosts the slots and
//! its stdout `kin_stream_event` / `kin_job_done` frames are the only
//! authority for a job's text and terminal state.

pub mod bootstrap;
pub mod envelope;
pub mod job;
pub mod memory_guard;
pub mod native_protocol;
pub mod scheduler;
pub mod slot;
pub mod supervisor;

use std::{
    collections::{HashMap, HashSet},
    env,
    io::Read,
    path::PathBuf,
    sync::{
        Arc, OnceLock, Weak,
        atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering},
    },
    time::Duration,
};

use async_trait::async_trait;
use serde_json::{Value, json};
use tokio::sync::{Mutex, Notify, OnceCell, mpsc};
use uuid::Uuid;

use crate::{
    error::KernelError,
    model::{ContentBlock, MessageContent, MessageRequest, MessageResponse, StopReason, Usage},
    provider::{ExecutionContext, Provider, ProviderCapabilities, StreamTx, job_event_channel},
    stream::{StreamAssembler, StreamItem},
};

use self::{
    job::{Job, new_id},
    memory_guard::MemoryGuard,
    scheduler::SlotScheduler,
    slot::{Slot, SlotPhase},
};

#[derive(Clone)]
pub struct MultiplexConfig {
    pub slot_count: usize,
    pub simulate: bool,
    pub bin: PathBuf,
    pub mock_bin: bool,
    pub model: String,
    pub max_jobs_per_slot: u32,
    pub slot_max_lifetime: Duration,
    pub session_idle_ttl: Duration,
    pub simulate_latency: Duration,
    pub continuation_ttl_secs: i64,
    pub client_stall_timeout: Duration,
    /// Bounded wait for a slot to re-enter slot_wait before returning 503.
    pub submit_wait: Duration,
    /// Go control-plane's computed `RuntimeProfile` hash (design.md §6),
    /// mirrors `crate::config::Config::desired_config_hash`. Read once at
    /// startup; `None` skips three-way config_hash validation.
    pub desired_config_hash: Option<String>,
    /// Live Claude config dir. None → temp dir + env oauth write.
    pub session_dir: Option<PathBuf>,
}

impl MultiplexConfig {
    pub fn from_env() -> Result<Self, Box<dyn std::error::Error>> {
        let slot_count = env::var("KIN_SLOTS_PER_WORKER")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(20)
            .clamp(1, 20);
        let bin = env::var("KIN_CLAUDE_BIN")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".into()))
                    .join("../../scripts/kin-node-kernel/mock-claude.mjs")
            });
        let mock_bin = bin.to_string_lossy().contains("mock-claude");
        let simulate = env::var("KIN_MULTIPLEX_SIMULATE")
            .map(|value| value != "0")
            .unwrap_or(mock_bin);
        Ok(Self {
            slot_count,
            simulate,
            mock_bin,
            bin,
            model: env::var("KIN_CLI_MODEL").unwrap_or_else(|_| "claude-sonnet-5".into()),
            max_jobs_per_slot: env::var("KIN_SLOT_MAX_JOBS")
                .ok()
                .and_then(|value| value.parse().ok())
                .unwrap_or(50),
            slot_max_lifetime: Duration::from_secs(
                env::var("KIN_SLOT_MAX_LIFETIME_SECS")
                    .ok()
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(1800),
            ),
            session_idle_ttl: Duration::from_secs(
                env::var("KIN_SESSION_IDLE_TTL_SECS")
                    .ok()
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(600),
            ),
            simulate_latency: Duration::from_millis(
                env::var("KIN_SIMULATE_LATENCY_MS")
                    .ok()
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(40),
            ),
            continuation_ttl_secs: 600,
            client_stall_timeout: crate::config::client_stall_timeout_from_env()?,
            submit_wait: Duration::from_millis(
                env::var("KIN_SUBMIT_WAIT_MS")
                    .ok()
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(2000),
            ),
            desired_config_hash: env::var("KIN_DESIRED_CONFIG_HASH").ok(),
            session_dir: None,
        })
    }
}

pub struct Runtime {
    pub pid: AtomicU32,
    cfg: MultiplexConfig,
    slots: Mutex<Vec<Slot>>,
    sched: Mutex<SlotScheduler>,
    jobs: Mutex<HashMap<String, Job>>,
    sinks: Mutex<HashMap<String, JobSink>>,
    job_sizes: Mutex<HashMap<String, usize>>,
    /// Boxed rather than `ChildStdin` so the simulated CLI can be driven
    /// over an in-memory pipe on exactly the same code path.
    cli_stdin: Mutex<Option<Box<dyn tokio::io::AsyncWrite + Send + Unpin>>>,
    pub memory: MemoryGuard,
    running: AtomicUsize,
    peak_running: AtomicUsize,
    ready: AtomicUsize,
    stage_dropped: AtomicU64,
    native_host: Mutex<Option<NativeHostInfo>>,
    /// P0(5.4): per-job aggregation of native `kin_stream_event` SSE into
    /// real `{id,name,input}` content blocks, for `stream:false` clients and
    /// for populating `complete_job()`'s response content under
    /// native/native_messages. Only touched from the native code paths.
    stream_assemblers: Mutex<HashMap<String, StreamAssembler>>,
    /// Set when `validate_host_ready()` rejects a `kin_host_ready` handshake
    /// due to config_hash mismatch (design.md §6, AC14). Surfaced via
    /// `Provider::config_hash_mismatch()` for `/readyz`.
    config_hash_mismatch: AtomicBool,
}

const JOB_SINK_ITEMS: usize = 256;
const JOB_SINK_BYTES: usize = 2 * 1024 * 1024;

#[derive(Clone, Debug, serde::Serialize)]
struct NativeHostInfo {
    protocol_version: u32,
    slots: usize,
    system_layout: String,
    timezone: String,
    capabilities: Vec<String>,
    config_hash: Option<String>,
}

#[derive(Clone)]
struct JobSink {
    data_tx: mpsc::Sender<SinkEnvelope>,
    terminal: Arc<OnceLock<Terminal>>,
    terminal_notify: Arc<Notify>,
    budget: Arc<ByteBudget>,
    client_tx: Arc<Mutex<Option<StreamTx>>>,
}

struct SinkEnvelope {
    item: StreamItem,
    bytes: usize,
}

struct ByteBudget {
    used: AtomicUsize,
    max: usize,
}

#[derive(Debug)]
enum Terminal {
    Overflow,
    ClientTooSlow,
    ClientGone,
    Done,
    Failed(KernelError),
}

#[derive(Debug, PartialEq, Eq)]
enum EmitResult {
    Sent,
    StageDropped,
    Failed,
    Closed,
    Missing,
}

enum SinkPushError {
    Full,
    Closed,
}

impl JobSink {
    fn new(client_tx: StreamTx) -> (Self, mpsc::Receiver<SinkEnvelope>) {
        let (data_tx, data_rx) = mpsc::channel(JOB_SINK_ITEMS);
        let sink = Self {
            data_tx,
            terminal: Arc::new(OnceLock::new()),
            terminal_notify: Arc::new(Notify::new()),
            budget: Arc::new(ByteBudget::new(JOB_SINK_BYTES)),
            client_tx: Arc::new(Mutex::new(Some(client_tx))),
        };
        (sink, data_rx)
    }

    fn try_push(&self, item: StreamItem) -> Result<(), SinkPushError> {
        if self.terminal_failed() {
            return Err(SinkPushError::Closed);
        }
        let bytes = stream_item_bytes(&item);
        if !self.budget.try_reserve(bytes) {
            return Err(SinkPushError::Full);
        }
        let envelope = SinkEnvelope { item, bytes };
        match self.data_tx.try_send(envelope) {
            Ok(()) => Ok(()),
            Err(mpsc::error::TrySendError::Full(envelope)) => {
                self.budget.release(envelope.bytes);
                Err(SinkPushError::Full)
            }
            Err(mpsc::error::TrySendError::Closed(envelope)) => {
                self.budget.release(envelope.bytes);
                Err(SinkPushError::Closed)
            }
        }
    }

    fn set_terminal(&self, terminal: Terminal) -> bool {
        let set = self.terminal.set(terminal).is_ok();
        if set {
            self.terminal_notify.notify_waiters();
        }
        set
    }

    fn terminal_failed(&self) -> bool {
        self.terminal.get().is_some_and(Terminal::is_failure)
    }
}

impl ByteBudget {
    fn new(max: usize) -> Self {
        Self {
            used: AtomicUsize::new(0),
            max,
        }
    }

    fn try_reserve(&self, bytes: usize) -> bool {
        let bytes = bytes.max(1);
        let mut current = self.used.load(Ordering::Relaxed);
        loop {
            let Some(next) = current.checked_add(bytes) else {
                return false;
            };
            if next > self.max {
                return false;
            }
            match self.used.compare_exchange_weak(
                current,
                next,
                Ordering::AcqRel,
                Ordering::Relaxed,
            ) {
                Ok(_) => return true,
                Err(actual) => current = actual,
            }
        }
    }

    fn release(&self, bytes: usize) {
        self.used
            .fetch_update(Ordering::AcqRel, Ordering::Relaxed, |current| {
                Some(current.saturating_sub(bytes.max(1)))
            })
            .ok();
    }
}

impl Terminal {
    fn is_failure(&self) -> bool {
        matches!(
            self,
            Self::Overflow | Self::ClientTooSlow | Self::ClientGone | Self::Failed(_)
        )
    }

    fn error(&self) -> KernelError {
        match self {
            Self::Overflow => KernelError::Provider("job stream overflow".into()),
            Self::ClientTooSlow => KernelError::Provider("client read timed out".into()),
            Self::ClientGone => KernelError::Provider("client disconnected".into()),
            Self::Done => KernelError::Provider("job already completed".into()),
            Self::Failed(err) => KernelError::Provider(err.to_string()),
        }
    }
}

impl Runtime {
    pub fn new(cfg: MultiplexConfig) -> Arc<Self> {
        Arc::new(Self {
            pid: AtomicU32::new(0),
            cfg,
            slots: Mutex::new(Vec::new()),
            sched: Mutex::new(SlotScheduler::new()),
            jobs: Mutex::new(HashMap::new()),
            sinks: Mutex::new(HashMap::new()),
            job_sizes: Mutex::new(HashMap::new()),
            cli_stdin: Mutex::new(None),
            memory: MemoryGuard::from_env(),
            running: AtomicUsize::new(0),
            peak_running: AtomicUsize::new(0),
            ready: AtomicUsize::new(0),
            stage_dropped: AtomicU64::new(0),
            native_host: Mutex::new(None),
            stream_assemblers: Mutex::new(HashMap::new()),
            config_hash_mismatch: AtomicBool::new(false),
        })
    }

    pub async fn start(self: &Arc<Self>) -> Result<(), KernelError> {
        if self.cfg.simulate {
            self.start_simulated().await
        } else {
            self.start_claude().await
        }
    }

    /// Stand-in for the CLI child: an in-memory pipe carrying the very same
    /// `kin_*` protocol, so tests exercise `write_cli_stdin` /
    /// `decode_stdout` instead of a bespoke fake.
    async fn start_simulated(self: &Arc<Self>) -> Result<(), KernelError> {
        self.pid.store(std::process::id(), Ordering::Relaxed);
        let (kernel_side, cli_side) = tokio::io::duplex(256 * 1024);
        let (kernel_read, kernel_write) = tokio::io::split(kernel_side);
        let (cli_read, cli_write) = tokio::io::split(cli_side);
        *self.cli_stdin.lock().await = Some(Box::new(kernel_write));
        let runtime = Arc::clone(self);
        tokio::spawn(async move {
            decode_stdout(runtime, kernel_read).await;
        });
        tokio::spawn(simulated_cli(
            cli_read,
            cli_write,
            self.cfg.slot_count,
            self.cfg.simulate_latency,
            self.cfg.desired_config_hash.clone(),
        ));
        bootstrap::wait_ready(self, self.cfg.slot_count, Duration::from_secs(5)).await
    }

    async fn start_claude(self: &Arc<Self>) -> Result<(), KernelError> {
        ensure_socks_http_bridge()?;
        let reuse = self.cfg.session_dir.is_some();
        let dir = self.cfg.session_dir.clone().unwrap_or_else(|| {
            PathBuf::from("/tmp/kin-cli/multiplex").join(Uuid::new_v4().to_string())
        });
        let spec = supervisor::SpawnSpec {
            bin: self.cfg.bin.clone(),
            mock: self.cfg.mock_bin,
            model: self.cfg.model.clone(),
            slot_count: self.cfg.slot_count,
            session_dir: dir,
            desired_config_hash: self.cfg.desired_config_hash.clone(),
            reuse_credentials: reuse,
        };
        let mut supervised = supervisor::spawn(&spec).await?;
        self.pid.store(supervised.pid, Ordering::Relaxed);
        self.memory.set_claude_pid(supervised.pid);
        let stdout = supervised
            .child
            .stdout
            .take()
            .ok_or_else(|| KernelError::Provider("claude stdout missing".into()))?;
        let stdin = supervised
            .child
            .stdin
            .take()
            .ok_or_else(|| KernelError::Provider("claude stdin missing".into()))?;
        let runtime = Arc::clone(self);
        tokio::spawn(async move {
            decode_stdout(runtime, stdout).await;
        });
        if let Some(stderr) = supervised.child.stderr.take() {
            tokio::spawn(async move {
                use tokio::io::{AsyncBufReadExt, BufReader};
                let mut lines = BufReader::new(stderr).lines();
                let path = "/tmp/kin-live/claude.multiplex.stderr.log";
                let mut file = tokio::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(path)
                    .await
                    .ok();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::info!(target: "kin_kernel::claude", "{line}");
                    if let Some(file) = file.as_mut() {
                        use tokio::io::AsyncWriteExt;
                        let _ = file.write_all(line.as_bytes()).await;
                        let _ = file.write_all(b"\n").await;
                    }
                }
            });
        }
        // Do not write kin_hello: official `-p` peeks stdin and, after the
        // first byte, waits for EOF. A live job pipe never ends, so a boot
        // hello hung the CLI before runHeadless / kin_slot_ready.
        *self.cli_stdin.lock().await = Some(Box::new(stdin));
        tokio::spawn(async move {
            match supervised.child.wait().await {
                Ok(status) => tracing::warn!(%status, "claude process exited"),
                Err(err) => tracing::warn!(%err, "claude wait failed"),
            }
        });
        tracing::info!(pid = supervised.pid, "claude supervisor alive");
        let wait = Duration::from_secs((120 + 8 * self.cfg.slot_count as u64).min(240));
        bootstrap::wait_ready(self, self.cfg.slot_count, wait).await
    }

    pub fn ready_slots(&self) -> usize {
        self.ready.load(Ordering::Relaxed)
    }

    #[cfg(test)]
    pub async fn snapshots(&self) -> Vec<slot::SlotSnapshot> {
        self.slots
            .lock()
            .await
            .iter()
            .map(|slot| slot::SlotSnapshot {
                id: slot.id.clone(),
                phase: slot.phase,
                session_id: slot.session_id.clone(),
                tenant_id: slot.tenant_id.clone(),
                jobs_completed: slot.jobs_completed,
            })
            .collect()
    }

    pub fn peak_running(&self) -> usize {
        self.peak_running.load(Ordering::Relaxed)
    }

    pub fn running_jobs(&self) -> usize {
        self.running.load(Ordering::Relaxed)
    }

    /// Terminal handler for a job: `kin_job_done` / `kin_job_error`.
    async fn complete_job(
        &self,
        job_id: &str,
        error: String,
        is_error: bool,
        stop_reason: &str,
        usage: Value,
    ) -> Result<(), KernelError> {
        let job = self
            .jobs
            .lock()
            .await
            .get(job_id)
            .cloned()
            .ok_or(KernelError::ContinuationLost)?;
        if is_error {
            if let Some(sink) = self.sinks.lock().await.get(job_id).cloned() {
                sink.set_terminal(Terminal::Failed(KernelError::Provider(error)));
            }
            // kin_job_error already released the slot on the CLI side.
            self.abort_terminal_job(job_id, false).await;
            return Ok(());
        }
        let assembler = self.stream_assemblers.lock().await.remove(job_id);
        if assembler.as_ref().is_none_or(|a| !a.saw_stop()) {
            // First-byte path flushes message_start before the CLI turn
            // ends. JobDone is the authority; without message_stop the hop
            // client marks incomplete and the panel paints api_error.
            let _ = self
                .emit(job_id, StreamItem::Event(json!({ "type": "message_stop" })))
                .await;
        }
        let (content, assembled_stop, assembled_usage) =
            assembler.map(StreamAssembler::parts).unwrap_or_else(|| {
                (
                    Vec::new(),
                    native_stop_reason(stop_reason),
                    Usage::default(),
                )
            });
        let usage_value = if usage.is_null() { json!({}) } else { usage };
        let usage = if usage_value == json!({}) {
            assembled_usage
        } else {
            usage_from_value(&usage_value)
        };
        let stop_reason = if stop_reason.is_empty() {
            assembled_stop
        } else {
            native_stop_reason(stop_reason)
        };
        let response = MessageResponse {
            id: format!("msg_{}", self.pid.load(Ordering::Relaxed)),
            r#type: "message",
            role: "assistant",
            model: job.request.model.clone(),
            content,
            stop_reason,
            usage,
        };
        if self.emit(job_id, StreamItem::Finished(response)).await != EmitResult::Sent {
            // kin_job_done arrived; only client delivery failed.
            self.abort_terminal_job(job_id, false).await;
        }
        Ok(())
    }

    async fn finish_sent_job(&self, job_id: &str) {
        if let Some(sink) = self.sinks.lock().await.get(job_id).cloned()
            && !sink.set_terminal(Terminal::Done)
        {
            self.abort_terminal_job(job_id, false).await;
            return;
        }
        let job = self.jobs.lock().await.remove(job_id);
        let slot_id = job.as_ref().map(|job| job.slot_id.clone());
        self.sinks.lock().await.remove(job_id);
        self.stream_assemblers.lock().await.remove(job_id);
        self.running
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| {
                Some(n.saturating_sub(1))
            })
            .ok();
        if let Some(size) = self.job_sizes.lock().await.remove(job_id) {
            self.memory.end(size);
        }
        let retire = if let Some(job) = job {
            let mut slots = self.slots.lock().await;
            if let Some(slot) = slots.iter_mut().find(|slot| slot.id == job.slot_id) {
                slot.jobs_completed = slot.jobs_completed.saturating_add(1);
                slot.should_retire(
                    self.cfg.max_jobs_per_slot,
                    self.cfg.slot_max_lifetime,
                    self.cfg.session_idle_ttl,
                )
            } else {
                false
            }
        } else {
            false
        };
        if let Some(slot_id) = slot_id {
            if retire {
                self.retire_slot(&slot_id).await;
            } else {
                // A job is always fully retired here regardless of
                // stop_reason (including ToolUse): continuation never resumes
                // this job_id, it always starts a fresh one via resume()'s
                // submit() delegation (design.md §5.2), so the slot is free
                // the moment this job's terminal frame has been delivered.
                self.register_native_ready(slot_id).await;
            }
        }
    }

    #[allow(dead_code)]
    async fn retire_idle(&self) {
        let ids: Vec<String> = {
            let slots = self.slots.lock().await;
            slots
                .iter()
                .filter(|slot| {
                    slot.phase == SlotPhase::ReadyBlocked
                        && slot.should_retire(
                            self.cfg.max_jobs_per_slot,
                            self.cfg.slot_max_lifetime,
                            self.cfg.session_idle_ttl,
                        )
                })
                .map(|slot| slot.id.clone())
                .collect()
        };
        for id in ids {
            self.retire_slot(&id).await;
        }
    }

    async fn retire_slot(&self, slot_id: &str) {
        {
            let mut slots = self.slots.lock().await;
            if let Some(slot) = slots.iter_mut().find(|slot| slot.id == slot_id) {
                slot.retire();
            }
        }
        self.sched.lock().await.forget(slot_id);
    }

    pub async fn handle_cli_frame(&self, frame: Value) {
        let Some(native) = native_protocol::decode_stdout_value(&frame) else {
            tracing::debug!(?frame, "unrecognised cli frame");
            return;
        };
        self.handle_native_frame(native).await;
    }

    async fn handle_native_frame(&self, frame: native_protocol::KinStdout) {
        match frame {
            native_protocol::KinStdout::HostReady {
                protocol_version,
                slots,
                system_layout,
                timezone,
                capabilities,
                config_hash,
            } => {
                tracing::info!(
                    protocol_version,
                    slots,
                    %system_layout,
                    %timezone,
                    ?capabilities,
                    ?config_hash,
                    "native host ready"
                );
                if let Err(reason) = self.validate_host_ready(
                    protocol_version,
                    slots,
                    &system_layout,
                    &timezone,
                    &capabilities,
                    config_hash.as_deref(),
                ) {
                    tracing::error!(
                        reason,
                        "native host ready validation failed, refusing to register slots"
                    );
                    if reason.starts_with("config_hash mismatch") {
                        self.config_hash_mismatch.store(true, Ordering::Relaxed);
                    }
                    return;
                }
                *self.native_host.lock().await = Some(NativeHostInfo {
                    protocol_version,
                    slots,
                    system_layout,
                    timezone,
                    capabilities,
                    config_hash,
                });
                for index in 0..slots {
                    self.register_native_ready(native_protocol::slot_id(index))
                        .await;
                }
            }
            native_protocol::KinStdout::SlotReady { slot_id } => {
                self.register_native_ready(slot_id).await;
            }
            native_protocol::KinStdout::StreamEvent {
                job_id,
                slot_id,
                event,
            } => {
                let model = {
                    let jobs = self.jobs.lock().await;
                    if let Some(job) = jobs.get(&job_id)
                        && job.slot_id != slot_id
                    {
                        tracing::warn!(
                            %job_id,
                            expected = %job.slot_id,
                            got = %slot_id,
                            "native stream slot_id mismatch"
                        );
                        return;
                    }
                    jobs.get(&job_id)
                        .map(|job| job.request.model.clone())
                        .unwrap_or_default()
                };
                self.stream_assemblers
                    .lock()
                    .await
                    .entry(job_id.clone())
                    .or_insert_with(|| StreamAssembler::new(model))
                    .apply_event(&event);
                self.emit(&job_id, StreamItem::Event(event)).await;
            }
            native_protocol::KinStdout::JobDone {
                job_id,
                slot_id,
                stop_reason,
                usage,
                headers,
            } => {
                if let Some(job) = self.jobs.lock().await.get(&job_id)
                    && job.slot_id != slot_id
                {
                    tracing::warn!(
                        %job_id,
                        expected = %job.slot_id,
                        got = %slot_id,
                        "native job_done slot_id mismatch"
                    );
                    return;
                }
                if !headers.is_empty() {
                    let _ = self
                        .emit(
                            &job_id,
                            StreamItem::Event(json!({
                                "type": "kin_response_headers",
                                "headers": headers,
                            })),
                        )
                        .await;
                }
                let _ = self
                    .complete_job(&job_id, String::new(), false, &stop_reason, usage)
                    .await;
            }
            native_protocol::KinStdout::JobError {
                job_id,
                slot_id: _,
                error,
            } => {
                let _ = self
                    .complete_job(&job_id, error, true, "error", json!({}))
                    .await;
            }
            native_protocol::KinStdout::CancelAck { job_id: _, slot_id } => {
                self.register_native_ready(slot_id).await;
            }
        }
    }

    /// P1-3: reject a `kin_host_ready` handshake that doesn't match what
    /// Rust expects, instead of registering slots against a CLI running an
    /// incompatible protocol/env. `config_hash` has no "desired" side yet
    /// (Go `RuntimeProfile`, design.md §6, not implemented) so it is only
    /// checked for presence under `native_messages`, not compared to a
    /// reference value.
    fn validate_host_ready(
        &self,
        protocol_version: u32,
        slots: usize,
        system_layout: &str,
        timezone: &str,
        capabilities: &[String],
        config_hash: Option<&str>,
    ) -> Result<(), String> {
        if protocol_version != native_protocol::KIN_PROTOCOL_VERSION {
            return Err(format!(
                "protocol_version {protocol_version} != {}",
                native_protocol::KIN_PROTOCOL_VERSION
            ));
        }
        if slots != self.cfg.slot_count {
            return Err(format!(
                "slots {slots} != configured slot_count {}",
                self.cfg.slot_count
            ));
        }
        let expected = envelope::load();
        if system_layout != expected.mode.as_str() {
            return Err(format!(
                "system_layout {system_layout} != expected {}",
                expected.mode.as_str()
            ));
        }
        if timezone != expected.timezone {
            return Err(format!(
                "timezone {timezone} != expected {}",
                expected.timezone
            ));
        }
        for required in native_protocol::KIN_CAPABILITIES {
            if !capabilities.iter().any(|c| c == required) {
                return Err(format!("missing required capability {required}"));
            }
        }
        if let Some(expected_hash) = &self.cfg.desired_config_hash
            && config_hash != Some(expected_hash.as_str())
        {
            return Err(format!(
                "config_hash mismatch: cli={config_hash:?} expected={expected_hash}"
            ));
        }
        Ok(())
    }

    async fn register_native_ready(&self, slot_id: String) {
        let mut slots = self.slots.lock().await;
        if !slots.iter().any(|slot| slot.id == slot_id) {
            slots.push(Slot::new(slot_id.clone()));
        }
        if let Some(slot) = slots.iter_mut().find(|slot| slot.id == slot_id) {
            slot.unbind_ready();
        }
        drop(slots);
        if self.sched.lock().await.enqueue_ready(slot_id) {
            self.ready.fetch_add(1, Ordering::Relaxed);
        }
    }

    async fn write_cli_stdin(&self, frame: native_protocol::KinStdin) -> Result<(), KernelError> {
        let line = native_protocol::encode_stdin(&frame).map_err(KernelError::Provider)?;
        let mut guard = self.cli_stdin.lock().await;
        let stdin = guard
            .as_mut()
            .ok_or_else(|| KernelError::Provider("native cli stdin closed".into()))?;
        use tokio::io::AsyncWriteExt;
        stdin
            .write_all(&line)
            .await
            .map_err(|err| KernelError::Provider(format!("native stdin: {err}")))?;
        stdin
            .flush()
            .await
            .map_err(|err| KernelError::Provider(err.to_string()))
    }

    async fn emit(&self, job_id: &str, item: StreamItem) -> EmitResult {
        let lossless_delta = is_lossless_delta(&item);
        let sink = self.sinks.lock().await.get(job_id).cloned();
        let Some(sink) = sink else {
            return EmitResult::Missing;
        };
        match sink.try_push(item) {
            Ok(()) => EmitResult::Sent,
            Err(SinkPushError::Full) => {
                if lossless_delta {
                    sink.set_terminal(Terminal::Overflow);
                    EmitResult::Failed
                } else if matches!(sink.terminal.get(), Some(Terminal::Done)) {
                    EmitResult::Closed
                } else {
                    self.stage_dropped.fetch_add(1, Ordering::Relaxed);
                    EmitResult::StageDropped
                }
            }
            Err(SinkPushError::Closed) => EmitResult::Closed,
        }
    }

    async fn start_job_sink(self: &Arc<Self>, job_id: String, tx: StreamTx) {
        let (sink, data_rx) = JobSink::new(tx);
        self.sinks.lock().await.insert(job_id.clone(), sink.clone());
        tokio::spawn(job_egress(
            Arc::downgrade(self),
            job_id.clone(),
            data_rx,
            sink,
            self.cfg.client_stall_timeout,
        ));
    }

    /// Tear down a job that will not complete normally.
    ///
    /// `cli_owns_job` decides who frees the slot. The CLI drops its slot back
    /// to idle the moment it emits `kin_job_done`/`kin_job_error`, and its
    /// `kin_cancel` handler returns silently for a job it no longer owns — so
    /// cancelling after a CLI-side terminal frame gets no `kin_cancel_ack`
    /// and would leak the slot forever. Pass `false` in that case and
    /// re-register locally; pass `true` only while the CLI is still running
    /// the job (client gone / overflow / stall), where the ack is the
    /// authoritative release.
    async fn abort_terminal_job(&self, job_id: &str, cli_owns_job: bool) {
        let sink = self.sinks.lock().await.get(job_id).cloned();
        if let Some(sink) = &sink
            && let Some(terminal) = sink.terminal.get()
            && terminal.is_failure()
        {
            fail_client_stream(sink, terminal).await;
        }
        let job = self.jobs.lock().await.remove(job_id);
        self.sinks.lock().await.remove(job_id);
        self.stream_assemblers.lock().await.remove(job_id);
        if let Some(size) = self.job_sizes.lock().await.remove(job_id) {
            self.memory.end(size);
        }
        if let Some(job) = job {
            self.running
                .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| {
                    Some(n.saturating_sub(1))
                })
                .ok();
            if !cli_owns_job {
                self.register_native_ready(job.slot_id).await;
                return;
            }
            let frame = native_protocol::KinStdin::Cancel {
                job_id: job.job_id.clone(),
                slot_id: Some(job.slot_id.clone()),
            };
            if self.write_cli_stdin(frame).await.is_err() {
                self.register_native_ready(job.slot_id).await;
            }
        }
    }

    pub async fn submit(
        self: &Arc<Self>,
        request: MessageRequest,
        context: ExecutionContext,
        tx: StreamTx,
    ) -> Result<(), KernelError> {
        if context.resumed {
            return self.resume(request, context, tx).await;
        }
        self.submit_fresh(request, context, tx).await
    }

    /// Bind an idle slot and dispatch a brand-new job. Shared by `submit()`
    /// and native `resume()` (which, per design.md §5.2, treats a
    /// continuation as a fresh job once the caller has already merged the
    /// message history).
    async fn submit_fresh(
        self: &Arc<Self>,
        request: MessageRequest,
        context: ExecutionContext,
        tx: StreamTx,
    ) -> Result<(), KernelError> {
        let request_bytes = request.messages.len().saturating_mul(1024).max(1024);
        self.memory.admit(request_bytes)?;
        let deadline = tokio::time::Instant::now() + self.cfg.submit_wait;
        let (slot_id, job_id) = loop {
            let mut slots = self.slots.lock().await;
            let mut sched = self.sched.lock().await;
            match sched.pick(&mut slots, &context.tenant_id, &context.session_id) {
                Ok(slot_id) => {
                    self.ready
                        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| {
                            Some(n.saturating_sub(1))
                        })
                        .ok();
                    let job_id = new_id("job");
                    let slot = slots
                        .iter_mut()
                        .find(|slot| slot.id == slot_id)
                        .ok_or(KernelError::NoCapacity)?;
                    if !slot.bind_job(&context.tenant_id, &context.session_id, &job_id) {
                        return Err(KernelError::NoCapacity);
                    }
                    break (slot_id, job_id);
                }
                Err(err) => {
                    drop(sched);
                    drop(slots);
                    if tokio::time::Instant::now() >= deadline {
                        return Err(err);
                    }
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            }
        };
        let job = Job {
            job_id: job_id.clone(),
            slot_id: slot_id.clone(),
            request,
        };
        let request_value = serde_json::to_value(&job.request).unwrap_or_else(|_| json!({}));
        self.jobs.lock().await.insert(job_id.clone(), job);
        self.start_job_sink(job_id.clone(), tx).await;
        self.write_cli_stdin(native_protocol::KinStdin::JobStart {
            job_id: job_id.clone(),
            slot_id,
            request: request_value,
        })
        .await?;
        self.job_sizes.lock().await.insert(job_id, request_bytes);
        self.memory.begin(request_bytes);
        let n = self.running.fetch_add(1, Ordering::Relaxed) + 1;
        self.peak_running.fetch_max(n, Ordering::Relaxed);
        Ok(())
    }

    async fn resume(
        self: &Arc<Self>,
        request: MessageRequest,
        context: ExecutionContext,
        tx: StreamTx,
    ) -> Result<(), KernelError> {
        // The CLI holds no cross-job state. Continuation + tenant +
        // tool_use_id-subset validation and the full message-history merge
        // already happened one layer up (api.rs::ActiveTurn::begin ->
        // session.rs::SessionDirectory::resume) by the time `context.resumed`
        // is set here, so a "resume" is structurally a fresh job: new job_id,
        // any idle slot (sticky preferred), fresh kin_job_start with the
        // already-merged request (design.md §5.2).
        let context = ExecutionContext {
            resumed: false,
            ..context
        };
        self.submit_fresh(request, context, tx).await
    }

    pub fn pid(&self) -> u32 {
        self.pid.load(Ordering::Relaxed)
    }

    /// Diagnostic only, best-effort: current slot_id bound to `session_id`.
    pub fn session_slot(&self, session_id: &str) -> Option<String> {
        let slots = self.slots.try_lock().ok()?;
        slots
            .iter()
            .find(|slot| slot.session_id.as_deref() == Some(session_id))
            .map(|slot| slot.id.clone())
    }

    /// True if the native host's last `kin_host_ready` was rejected for a
    /// config_hash mismatch against `desired_config_hash` (design.md §6).
    pub fn config_hash_mismatch(&self) -> bool {
        self.config_hash_mismatch.load(Ordering::Relaxed)
    }
}

async fn job_egress(
    runtime: Weak<Runtime>,
    job_id: String,
    mut data_rx: mpsc::Receiver<SinkEnvelope>,
    sink: JobSink,
    stall_timeout: Duration,
) {
    loop {
        if let Some(terminal) = sink.terminal.get()
            && terminal.is_failure()
        {
            // Flush queued frames (Extra 5h headers) before the error so
            // Node trailers still ingest the window on wrap 400/limit.
            while let Ok(envelope) = data_rx.try_recv() {
                sink.budget.release(envelope.bytes);
                if let Some(tx) = sink.client_tx.lock().await.clone() {
                    let _ = tx.send(Ok(envelope.item)).await;
                }
            }
            fail_client_stream(&sink, terminal).await;
            if let Some(runtime) = runtime.upgrade() {
                runtime.abort_terminal_job(&job_id, true).await;
            }
            break;
        }
        let envelope = tokio::select! {
            biased;
            envelope = data_rx.recv() => envelope,
            _ = sink.terminal_notify.notified() => continue,
        };
        let Some(envelope) = envelope else {
            break;
        };
        sink.budget.release(envelope.bytes);
        // Every terminal frame ends the job, `tool_use` included: the client
        // resumes through a brand-new job, never back into this one.
        let final_response = match &envelope.item {
            StreamItem::Finished(response) => Some(response.clone()),
            StreamItem::Event(_) => None,
        };
        let Some(tx) = sink.client_tx.lock().await.clone() else {
            sink.set_terminal(Terminal::ClientGone);
            continue;
        };
        let send = tx.send(Ok(envelope.item));
        tokio::pin!(send);
        let deadline = tokio::time::sleep(stall_timeout);
        tokio::pin!(deadline);
        // A `Done` notification must not abandon the envelope mid-send (it may
        // be the Finished frame); only failure terminals abort the delivery.
        let sent = loop {
            tokio::select! {
                biased;
                result = &mut send => break result.map_err(|_| Terminal::ClientGone),
                _ = sink.terminal_notify.notified() => {
                    if sink.terminal_failed() {
                        break Err(Terminal::ClientGone);
                    }
                }
                _ = &mut deadline => break Err(Terminal::ClientTooSlow),
            }
        };
        match sent {
            Ok(()) if final_response.is_some() => {
                sink.client_tx.lock().await.take();
                if let Some(runtime) = runtime.upgrade() {
                    runtime.finish_sent_job(&job_id).await;
                }
                break;
            }
            Ok(()) => {}
            Err(terminal) => {
                sink.set_terminal(terminal);
            }
        }
    }
}

async fn fail_client_stream(sink: &JobSink, terminal: &Terminal) {
    if let Some(tx) = sink.client_tx.lock().await.take() {
        let _ = tx.try_send(Err(terminal.error()));
    }
}

fn stream_item_bytes(item: &StreamItem) -> usize {
    match item {
        StreamItem::Event(event) => event.to_string().len(),
        StreamItem::Finished(response) => {
            serde_json::to_vec(response).map_or(1, |bytes| bytes.len())
        }
    }
}

fn is_lossless_delta(item: &StreamItem) -> bool {
    let StreamItem::Event(event) = item else {
        return true;
    };
    matches!(
        event.get("type").and_then(Value::as_str),
        Some(
            "message_start"
                | "content_block_start"
                | "content_block_delta"
                | "content_block_stop"
                | "message_delta"
                | "message_stop"
        )
    )
}

fn native_stop_reason(reason: &str) -> StopReason {
    match reason {
        "tool_use" => StopReason::ToolUse,
        "max_tokens" => StopReason::MaxTokens,
        "refusal" => StopReason::Refusal,
        "stop_sequence" => StopReason::StopSequence,
        "pause_turn" => StopReason::PauseTurn,
        _ => StopReason::EndTurn,
    }
}

fn usage_from_value(value: &Value) -> Usage {
    Usage {
        input_tokens: value
            .get("input_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        output_tokens: value
            .get("output_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        ..Usage::default()
    }
}

fn latest_text(request: &MessageRequest) -> String {
    for message in request.messages.iter().rev() {
        if message.role != "user" {
            continue;
        }
        match &message.content {
            MessageContent::Text(text) => return text.clone(),
            MessageContent::Blocks(blocks) => {
                let mut out = String::new();
                for block in blocks {
                    if let ContentBlock::Text { text, .. } = block {
                        out.push_str(text);
                    }
                }
                if !out.is_empty() {
                    return out;
                }
            }
        }
    }
    String::new()
}

/// In-memory stand-in for the Claude CLI child. It speaks exactly the `kin_*`
/// protocol the real CLI speaks, so tests exercise `write_cli_stdin`,
/// `decode_stdout` and `handle_native_frame` instead of a bespoke fake.
///
/// The request text selects the reply shape: `[job_error]` emits
/// `kin_job_error`, `[use_tool:NAME]` ends the turn on `tool_use`,
/// `[web_search]` emits server tool blocks, anything else answers with a
/// single text block.
///
/// Cancel semantics mirror the real runner: a `kin_cancel` for a job the CLI
/// no longer owns is dropped **without** an ack, because the CLI releases its
/// slot as soon as it emits a terminal frame.
async fn simulated_cli(
    reader: impl tokio::io::AsyncRead + Unpin,
    writer: impl tokio::io::AsyncWrite + Unpin + Send + 'static,
    slots: usize,
    latency: Duration,
    config_hash: Option<String>,
) {
    use tokio::io::{AsyncBufReadExt, BufReader};
    let writer = Arc::new(Mutex::new(writer));
    let live: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));
    let layout = envelope::load();
    let ready = native_protocol::KinStdout::HostReady {
        protocol_version: native_protocol::KIN_PROTOCOL_VERSION,
        slots,
        system_layout: layout.mode.as_str().to_string(),
        timezone: layout.timezone.clone(),
        capabilities: native_protocol::KIN_CAPABILITIES
            .iter()
            .map(|cap| (*cap).to_string())
            .collect(),
        config_hash,
    };
    if write_sim_frame(&writer, &ready).await.is_err() {
        return;
    }
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(frame) = serde_json::from_str::<native_protocol::KinStdin>(&line) else {
            continue;
        };
        match frame {
            native_protocol::KinStdin::JobStart {
                job_id,
                slot_id,
                request,
            } => {
                let writer = Arc::clone(&writer);
                let live = Arc::clone(&live);
                live.lock().await.insert(job_id.clone());
                tokio::spawn(async move {
                    simulated_job(writer, job_id.clone(), slot_id, request, latency).await;
                    live.lock().await.remove(&job_id);
                });
            }
            native_protocol::KinStdin::Cancel { job_id, slot_id } => {
                if !live.lock().await.remove(&job_id) {
                    continue;
                }
                let slot_id = slot_id.unwrap_or_default();
                let _ = write_sim_frame(
                    &writer,
                    &native_protocol::KinStdout::CancelAck { job_id, slot_id },
                )
                .await;
            }
        }
    }
}

async fn write_sim_frame<W: tokio::io::AsyncWrite + Unpin>(
    writer: &Arc<Mutex<W>>,
    frame: &native_protocol::KinStdout,
) -> Result<(), std::io::Error> {
    use tokio::io::AsyncWriteExt;
    let mut line = serde_json::to_vec(frame).unwrap_or_default();
    line.push(b'\n');
    let mut guard = writer.lock().await;
    guard.write_all(&line).await?;
    guard.flush().await
}

async fn simulated_job<W: tokio::io::AsyncWrite + Unpin>(
    writer: Arc<Mutex<W>>,
    job_id: String,
    slot_id: String,
    request: Value,
    latency: Duration,
) {
    let request: MessageRequest = serde_json::from_value(request).unwrap_or_default();
    let model = request.model.clone();
    let text = latest_text(&request);
    let event = |writer: &Arc<Mutex<W>>, event: Value| {
        let writer = Arc::clone(writer);
        let job_id = job_id.clone();
        let slot_id = slot_id.clone();
        async move {
            write_sim_frame(
                &writer,
                &native_protocol::KinStdout::StreamEvent {
                    job_id,
                    slot_id,
                    event,
                },
            )
            .await
        }
    };
    // message_start is not gated on the answer: a client must see the turn
    // open before the model produces anything.
    if event(
        &writer,
        json!({
            "type": "message_start",
            "message": { "id": format!("msg_{job_id}"), "model": model, "usage": {} }
        }),
    )
    .await
    .is_err()
    {
        return;
    }
    tokio::time::sleep(latency).await;
    if text.contains("[job_error]") {
        let _ = write_sim_frame(
            &writer,
            &native_protocol::KinStdout::JobError {
                job_id,
                slot_id: Some(slot_id),
                error: "simulated job error".into(),
            },
        )
        .await;
        return;
    }
    let (stop_reason, usage) = if let Some(tool) = text
        .split("[use_tool:")
        .nth(1)
        .and_then(|part| part.split(']').next())
    {
        let tool_id = new_id("toolu");
        let _ = event(
            &writer,
            json!({
                "type": "content_block_start",
                "index": 0,
                "content_block": { "type": "tool_use", "id": tool_id, "name": tool, "input": {} }
            }),
        )
        .await;
        let _ = event(
            &writer,
            json!({
                "type": "content_block_delta",
                "index": 0,
                "delta": { "type": "input_json_delta", "partial_json": "{\"echo\":true}" }
            }),
        )
        .await;
        let _ = event(&writer, json!({"type": "content_block_stop", "index": 0})).await;
        ("tool_use", json!({ "output_tokens": 4 }))
    } else if text.contains("[web_search]") {
        for block in [
            json!({ "type": "server_tool_use", "id": "srvtoolu_sim", "name": "web_search", "input": { "query": text } }),
            json!({ "type": "web_search_tool_result", "tool_use_id": "srvtoolu_sim", "content": [] }),
        ] {
            let _ = event(
                &writer,
                json!({ "type": "content_block_start", "index": 0, "content_block": block }),
            )
            .await;
            let _ = event(&writer, json!({"type": "content_block_stop", "index": 0})).await;
        }
        let _ = event(
            &writer,
            json!({
                "type": "content_block_start",
                "index": 1,
                "content_block": { "type": "text", "text": "" }
            }),
        )
        .await;
        let _ = event(
            &writer,
            json!({
                "type": "content_block_delta",
                "index": 1,
                "delta": { "type": "text_delta", "text": "search-complete" }
            }),
        )
        .await;
        let _ = event(&writer, json!({"type": "content_block_stop", "index": 1})).await;
        ("end_turn", json!({ "web_search_requests": 1 }))
    } else {
        let reply = format!("slot {slot_id} :: {text}");
        let _ = event(
            &writer,
            json!({
                "type": "content_block_start",
                "index": 0,
                "content_block": { "type": "text", "text": "" }
            }),
        )
        .await;
        let _ = event(
            &writer,
            json!({
                "type": "content_block_delta",
                "index": 0,
                "delta": { "type": "text_delta", "text": reply }
            }),
        )
        .await;
        let _ = event(&writer, json!({"type": "content_block_stop", "index": 0})).await;
        ("end_turn", json!({ "output_tokens": 8 }))
    };
    let _ = event(
        &writer,
        json!({ "type": "message_delta", "delta": { "stop_reason": stop_reason }, "usage": usage }),
    )
    .await;
    let _ = event(&writer, json!({ "type": "message_stop" })).await;
    let _ = write_sim_frame(
        &writer,
        &native_protocol::KinStdout::JobDone {
            job_id,
            slot_id,
            stop_reason: stop_reason.to_string(),
            usage,
            headers: Default::default(),
        },
    )
    .await;
}

fn ensure_socks_http_bridge() -> Result<(), KernelError> {
    if env::var("KIN_HTTPS_PROXY")
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false)
    {
        return Ok(());
    }
    let socks = env::var("KIN_SOCKS5").unwrap_or_default();
    if socks.trim().is_empty() {
        return Ok(());
    }
    let listen = env::var("KIN_HTTP_BRIDGE_ADDR").unwrap_or_else(|_| "127.0.0.1:18080".into());
    let proxy = format!("http://{listen}");
    // SAFETY: boot-time only, before CLI spawn.
    unsafe {
        env::set_var("KIN_HTTPS_PROXY", &proxy);
        env::set_var("KIN_HTTP_BRIDGE_ADDR", &listen);
    }
    let script = http_to_socks_script();
    let mut child = std::process::Command::new("python3")
        .arg(&script)
        .env("KIN_SOCKS5", socks)
        .env("KIN_HTTP_BRIDGE_ADDR", &listen)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|err| KernelError::Provider(format!("http_to_socks spawn: {err}")))?;
    std::thread::sleep(Duration::from_millis(200));
    if let Ok(Some(status)) = child.try_wait() {
        let err = child
            .stderr
            .as_mut()
            .and_then(|pipe| {
                let mut buf = String::new();
                pipe.read_to_string(&mut buf).ok()?;
                Some(buf)
            })
            .unwrap_or_default();
        if err.contains("Address already in use") || err.contains("EADDRINUSE") {
            tracing::info!(proxy = %proxy, "cli https proxy already bound");
            return Ok(());
        }
        return Err(KernelError::Provider(format!(
            "http_to_socks exited {status}: {err}"
        )));
    }
    std::mem::forget(child);
    tracing::info!(proxy = %proxy, "cli https proxy -> socks5 bridge");
    Ok(())
}

fn http_to_socks_script() -> PathBuf {
    if let Ok(path) = env::var("KIN_HTTP_TO_SOCKS") {
        return PathBuf::from(path);
    }
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".into()));
    for candidate in [
        manifest.join("../../scripts/http_to_socks.py"),
        manifest.join("../scripts/http_to_socks.py"),
        PathBuf::from("service/scripts/http_to_socks.py"),
        PathBuf::from("scripts/http_to_socks.py"),
    ] {
        if candidate.exists() {
            return candidate;
        }
    }
    manifest.join("../../scripts/http_to_socks.py")
}

/// Charges `line_len` bytes against `job_id`'s running total in `job_bytes`
/// and reports whether that job has now exceeded `MAX_JOB_BYTES`, so one
/// runaway job's stdout can't starve other concurrent jobs sharing the same
/// CLI process.
fn charge_job_bytes(job_bytes: &mut HashMap<String, usize>, key: &str, line_len: usize) -> bool {
    let used = job_bytes.entry(key.to_string()).or_insert(0);
    *used = used.saturating_add(line_len);
    *used > native_protocol::MAX_JOB_BYTES
}

async fn decode_stdout(runtime: Arc<Runtime>, stdout: impl tokio::io::AsyncRead + Unpin) {
    use tokio::io::{AsyncBufReadExt, BufReader};
    let mut lines = BufReader::new(stdout).lines();
    let mut job_bytes: HashMap<String, usize> = HashMap::new();
    let mut dump = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open("/tmp/kin-live/claude.multiplex.stdout.log")
        .await
        .ok();
    while let Ok(Some(line)) = lines.next_line().await {
        if let Some(file) = dump.as_mut() {
            use tokio::io::AsyncWriteExt;
            let _ = file.write_all(line.as_bytes()).await;
            let _ = file.write_all(b"\n").await;
        }
        if line.len() > native_protocol::MAX_LINE_BYTES {
            continue;
        }
        let Ok(frame) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some(key) = frame.get("job_id").and_then(Value::as_str)
            && charge_job_bytes(&mut job_bytes, key, line.len())
        {
            continue;
        }
        runtime.handle_cli_frame(frame).await;
    }
}

pub struct MultiplexCliProvider {
    cfg: MultiplexConfig,
    runtime: OnceCell<Arc<Runtime>>,
}

impl MultiplexCliProvider {
    pub fn from_env() -> Result<Self, Box<dyn std::error::Error>> {
        Ok(Self {
            cfg: MultiplexConfig::from_env()?,
            runtime: OnceCell::new(),
        })
    }

    pub fn new(cfg: MultiplexConfig) -> Self {
        Self {
            cfg,
            runtime: OnceCell::new(),
        }
    }

    #[cfg(test)]
    pub fn simulated(slot_count: usize) -> Self {
        Self {
            cfg: MultiplexConfig {
                slot_count,
                simulate: true,
                bin: PathBuf::from("simulated"),
                mock_bin: true,
                model: "claude-sonnet-5".into(),
                max_jobs_per_slot: 32,
                slot_max_lifetime: Duration::from_secs(1800),
                session_idle_ttl: Duration::from_secs(600),
                simulate_latency: Duration::from_millis(60),
                continuation_ttl_secs: 600,
                client_stall_timeout: Duration::from_secs(crate::config::DEFAULT_CLIENT_STALL_SECS),
                submit_wait: Duration::from_millis(200),
                desired_config_hash: None,
                session_dir: None,
            },
            runtime: OnceCell::new(),
        }
    }

    async fn runtime(&self) -> Result<&Arc<Runtime>, KernelError> {
        self.runtime
            .get_or_try_init(|| async {
                let runtime = Runtime::new(self.cfg.clone());
                runtime.start().await?;
                Ok(runtime)
            })
            .await
    }
}

#[async_trait]
impl Provider for MultiplexCliProvider {
    fn name(&self) -> &'static str {
        "local_cli"
    }

    async fn boot(&self) -> Result<(), KernelError> {
        self.runtime().await.map(|_| ())
    }

    fn capabilities(&self) -> ProviderCapabilities {
        ProviderCapabilities {
            streaming: true,
            resume: true,
            multiplex_slots: true,
            native_tool_wait: true,
            cancel_receipt: true,
        }
    }

    fn session_pid(&self, _session_id: &str) -> Option<u32> {
        self.runtime.get().map(|runtime| runtime.pid())
    }

    fn session_slot(&self, session_id: &str) -> Option<String> {
        self.runtime
            .get()
            .and_then(|runtime| runtime.session_slot(session_id))
    }

    fn config_hash_mismatch(&self) -> bool {
        self.runtime
            .get()
            .map(|runtime| runtime.config_hash_mismatch())
            .unwrap_or(false)
    }

    fn memory_snapshot(&self) -> Option<serde_json::Value> {
        self.runtime.get().map(|runtime| {
            let mut value =
                serde_json::to_value(runtime.memory.snapshot()).unwrap_or(serde_json::Value::Null);
            if let Some(obj) = value.as_object_mut() {
                obj.insert("peak_running".into(), json!(runtime.peak_running()));
                obj.insert("running".into(), json!(runtime.running_jobs()));
                obj.insert("ready_slots".into(), json!(runtime.ready_slots()));
                if let Ok(host) = runtime.native_host.try_lock()
                    && let Some(info) = host.as_ref()
                {
                    obj.insert("native_host".into(), json!(info));
                }
            }
            value
        })
    }

    async fn execute_stream(
        &self,
        request: &MessageRequest,
        context: &ExecutionContext,
    ) -> Result<crate::provider::StreamRx, KernelError> {
        let runtime = self.runtime().await?;
        let (tx, rx) = job_event_channel();
        let mut stamped = request.clone();
        crate::model::stamp_cli_hop_message_breakpoints(&mut stamped);
        runtime.submit(stamped, context.clone(), tx).await?;
        Ok(rx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Message, ToolDefinition};
    use crate::provider::stream_channel;
    use tokio::time::timeout;

    fn ctx(session: &str, resumed: bool) -> ExecutionContext {
        ExecutionContext {
            tenant_id: "demo".into(),
            session_id: session.into(),
            worker_id: "runtime-00".into(),
            worker_generation: 1,
            resumed,
        }
    }

    fn text_request(text: &str) -> MessageRequest {
        MessageRequest {
            model: "claude-sonnet-5".into(),
            messages: vec![Message {
                role: "user".into(),
                content: MessageContent::Text(text.into()),
                tool_call_id: None,
                tool_calls: Vec::new(),
            }],
            tools: vec![ToolDefinition {
                name: "echo".into(),
                description: "echo".into(),
                input_schema: json!({"type":"object"}),
                cache_control: None,
                tool_type: None,
                extra: Default::default(),
            }],
            max_tokens: 128,
            stream: false,
            ..MessageRequest::default()
        }
    }

    fn test_cfg(stall: Duration) -> MultiplexConfig {
        MultiplexConfig {
            slot_count: 1,
            simulate: true,
            bin: PathBuf::from("simulated"),
            mock_bin: true,
            model: "claude-sonnet-5".into(),
            max_jobs_per_slot: 32,
            slot_max_lifetime: Duration::from_secs(1800),
            session_idle_ttl: Duration::from_secs(600),
            simulate_latency: Duration::from_millis(1),
            continuation_ttl_secs: 600,
            client_stall_timeout: stall,
            submit_wait: Duration::from_millis(200),
            desired_config_hash: None,
            session_dir: None,
        }
    }

    fn delta(text: &str) -> StreamItem {
        StreamItem::Event(json!({
            "type": "content_block_delta",
            "index": 0,
            "delta": { "type": "text_delta", "text": text }
        }))
    }

    fn stage_event(name: &str) -> StreamItem {
        StreamItem::Event(json!({ "type": name }))
    }

    fn structural_start() -> StreamItem {
        StreamItem::Event(json!({
            "type": "content_block_start",
            "index": 0,
            "content_block": { "type": "text", "text": "" }
        }))
    }

    fn finished_response() -> StreamItem {
        StreamItem::Finished(MessageResponse {
            id: "msg_test".into(),
            r#type: "message",
            role: "assistant",
            model: "claude-sonnet-5".into(),
            content: vec![ContentBlock::Text {
                text: "done".into(),
                cache_control: None,
            }],
            stop_reason: StopReason::EndTurn,
            usage: Usage::default(),
        })
    }

    async fn wait_for_overflow(sink: &JobSink) {
        timeout(Duration::from_secs(1), async {
            loop {
                if matches!(sink.terminal.get(), Some(Terminal::Overflow)) {
                    return;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("overflow terminal");
    }

    async fn collect(
        provider: &MultiplexCliProvider,
        request: MessageRequest,
        context: ExecutionContext,
    ) -> Result<MessageResponse, KernelError> {
        let rx = provider.execute_stream(&request, &context).await?;
        crate::provider::collect_stream(rx).await
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn fast_consumer_receives_all_deltas() {
        let runtime = Runtime::new(test_cfg(Duration::from_secs(1)));
        let (tx, mut rx) = mpsc::channel(64);
        runtime.start_job_sink("job-fast".into(), tx).await;

        for index in 0..24 {
            assert_eq!(
                runtime
                    .emit("job-fast", delta(&format!("chunk-{index};")))
                    .await,
                EmitResult::Sent
            );
        }
        assert_eq!(
            runtime.emit("job-fast", finished_response()).await,
            EmitResult::Sent
        );

        let mut deltas = Vec::new();
        let mut finished = false;
        while let Some(item) = timeout(Duration::from_secs(1), rx.recv())
            .await
            .expect("stream item")
        {
            match item.unwrap() {
                StreamItem::Event(event) => {
                    if event.pointer("/delta/type").and_then(Value::as_str) == Some("text_delta") {
                        deltas.push(event["delta"]["text"].as_str().unwrap_or("").to_string());
                    }
                }
                StreamItem::Finished(_) => {
                    finished = true;
                    break;
                }
            }
        }
        assert!(finished);
        assert_eq!(deltas.len(), 24);
        assert_eq!(deltas[0], "chunk-0;");
        assert_eq!(deltas[23], "chunk-23;");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn final_finished_sets_done_only_after_client_delivery() {
        let runtime = Runtime::new(test_cfg(Duration::from_secs(1)));
        let (tx, mut rx) = mpsc::channel(8);
        runtime.start_job_sink("job-done".into(), tx).await;
        let sink = runtime
            .sinks
            .lock()
            .await
            .get("job-done")
            .cloned()
            .expect("sink");

        assert_eq!(
            runtime.emit("job-done", finished_response()).await,
            EmitResult::Sent
        );
        assert!(matches!(
            timeout(Duration::from_secs(1), rx.recv())
                .await
                .expect("finished")
                .expect("finished")
                .unwrap(),
            StreamItem::Finished(_)
        ));
        timeout(Duration::from_secs(1), async {
            loop {
                if matches!(sink.terminal.get(), Some(Terminal::Done)) {
                    return;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("done terminal");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn oversized_delta_overflow_sends_explicit_error() {
        let runtime = Runtime::new(test_cfg(Duration::from_secs(1)));
        let (tx, mut rx) = mpsc::channel(8);
        runtime.start_job_sink("job-big".into(), tx).await;

        let big = "x".repeat(JOB_SINK_BYTES + 1);
        assert_eq!(
            runtime.emit("job-big", delta(&big)).await,
            EmitResult::Failed
        );

        let item = timeout(Duration::from_secs(1), rx.recv())
            .await
            .expect("error item")
            .expect("error item");
        assert!(item.is_err(), "{item:?}");
        assert!(rx.recv().await.is_none());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn queue_full_text_delta_sets_overflow_terminal() {
        let runtime = Runtime::new(test_cfg(Duration::from_secs(1)));
        let (tx, _rx) = mpsc::channel(1);
        runtime.start_job_sink("job-full".into(), tx).await;
        let sink = runtime
            .sinks
            .lock()
            .await
            .get("job-full")
            .cloned()
            .expect("sink");

        for index in 0..(JOB_SINK_ITEMS + 32) {
            let _ = runtime
                .emit("job-full", delta(&format!("chunk-{index}")))
                .await;
        }

        wait_for_overflow(&sink).await;
        assert!(sink.terminal_failed());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn queue_full_structural_event_sets_overflow_terminal() {
        let runtime = Runtime::new(test_cfg(Duration::from_secs(1)));
        let (tx, _rx) = mpsc::channel(1);
        runtime.start_job_sink("job-struct-full".into(), tx).await;
        let sink = runtime
            .sinks
            .lock()
            .await
            .get("job-struct-full")
            .cloned()
            .expect("sink");

        for _ in 0..(JOB_SINK_ITEMS + 8) {
            let _ = runtime.emit("job-struct-full", structural_start()).await;
        }

        wait_for_overflow(&sink).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn stalled_client_never_receives_success_finish() {
        let runtime = Runtime::new(test_cfg(Duration::from_millis(20)));
        let (tx, mut rx) = mpsc::channel(1);
        runtime.start_job_sink("job-stalled".into(), tx).await;
        let sink = runtime
            .sinks
            .lock()
            .await
            .get("job-stalled")
            .cloned()
            .expect("sink");

        assert_eq!(
            runtime
                .emit("job-stalled", stage_event("message_start"))
                .await,
            EmitResult::Sent
        );
        assert_eq!(
            runtime.emit("job-stalled", finished_response()).await,
            EmitResult::Sent
        );

        tokio::time::sleep(Duration::from_millis(80)).await;
        let mut saw_finished = false;
        while let Some(item) = rx.recv().await {
            if matches!(item.unwrap(), StreamItem::Finished(_)) {
                saw_finished = true;
            }
        }
        assert!(!saw_finished);
        assert!(matches!(sink.terminal.get(), Some(Terminal::ClientTooSlow)));
        assert!(!matches!(sink.terminal.get(), Some(Terminal::Done)));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn submit_retries_through_slot_reentry_gap() {
        // FAIL-3 in the 20-way live test: a burst submission can land in the
        // window where a slot has finished its job but has not yet re-entered
        // slot_wait, seeing a spurious NoCapacity. submit must wait it out.
        let provider = MultiplexCliProvider::simulated(1);
        provider.runtime().await.expect("start");
        let runtime = Arc::clone(provider.runtime.get().unwrap());
        // Occupy the only slot, then submit again while it is busy: the retry
        // loop should pick it up as soon as the first job completes.
        let (tx1, rx1) = stream_channel();
        runtime
            .submit(text_request("first"), ctx("sess-gap-1", false), tx1)
            .await
            .unwrap();
        let second = {
            let runtime = Arc::clone(&runtime);
            tokio::spawn(async move {
                let (tx2, rx2) = stream_channel();
                runtime
                    .submit(text_request("second"), ctx("sess-gap-2", false), tx2)
                    .await?;
                crate::provider::collect_stream(rx2).await
            })
        };
        let first = crate::provider::collect_stream(rx1).await.unwrap();
        assert!(matches!(first.stop_reason, StopReason::EndTurn));
        let second = timeout(Duration::from_secs(5), second)
            .await
            .expect("second submit within retry window")
            .unwrap()
            .unwrap();
        assert!(matches!(second.stop_reason, StopReason::EndTurn));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn one_pid_five_parallel_slots() {
        let shared = MultiplexCliProvider::simulated(5);
        shared.runtime().await.expect("start");
        let pid = shared.session_pid("any").expect("pid");
        let mut joins = Vec::new();
        for index in 0..5 {
            let request = text_request(&format!("hello {index}"));
            let context = ctx(&format!("sess-{index}"), false);
            let runtime = Arc::clone(shared.runtime.get().unwrap());
            joins.push(tokio::spawn(async move {
                let (tx, rx) = stream_channel();
                runtime.submit(request, context, tx).await.unwrap();
                crate::provider::collect_stream(rx).await
            }));
        }
        let mut texts = Vec::new();
        for join in joins {
            let response = timeout(Duration::from_secs(5), join)
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            assert!(matches!(response.stop_reason, StopReason::EndTurn));
            assert_eq!(shared.session_pid("x").unwrap(), pid);
            if let ContentBlock::Text { text, .. } = &response.content[0] {
                texts.push(text.clone());
            }
        }
        assert_eq!(texts.len(), 5);
        assert!(shared.runtime.get().unwrap().peak_running() >= 2);
        assert_eq!(
            shared.runtime.get().unwrap().snapshots().await.len(),
            5,
            "each job must land on its own slot"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn two_tool_calls_resume_independently() {
        let provider = MultiplexCliProvider::simulated(2);
        let first = collect(
            &provider,
            text_request("please [use_tool:echo] now"),
            ctx("sess-tool-a", false),
        )
        .await
        .unwrap();
        let second = collect(
            &provider,
            text_request("please [use_tool:echo] now"),
            ctx("sess-tool-b", false),
        )
        .await
        .unwrap();
        assert!(matches!(first.stop_reason, StopReason::ToolUse));
        assert!(matches!(second.stop_reason, StopReason::ToolUse));
        let id_a = match &first.content[0] {
            ContentBlock::ToolUse { id, .. } => id.clone(),
            _ => panic!("tool a"),
        };
        let id_b = match &second.content[0] {
            ContentBlock::ToolUse { id, .. } => id.clone(),
            _ => panic!("tool b"),
        };
        assert_ne!(id_a, id_b);
        let resume = |id: String| MessageRequest {
            model: "claude-sonnet-5".into(),
            messages: vec![Message {
                role: "user".into(),
                content: MessageContent::Blocks(vec![ContentBlock::ToolResult {
                    tool_use_id: id,
                    content: json!("ok"),
                    is_error: false,
                    cache_control: None,
                }]),
                tool_call_id: None,
                tool_calls: Vec::new(),
            }],
            max_tokens: 32,
            stream: false,
            ..MessageRequest::default()
        };
        let a = collect(&provider, resume(id_a), ctx("sess-tool-a", true))
            .await
            .unwrap();
        let b = collect(&provider, resume(id_b), ctx("sess-tool-b", true))
            .await
            .unwrap();
        assert!(matches!(a.stop_reason, StopReason::EndTurn));
        assert!(matches!(b.stop_reason, StopReason::EndTurn));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn one_pid_twenty_parallel_slots() {
        let shared = MultiplexCliProvider::simulated(20);
        shared.runtime().await.expect("start");
        let pid = shared.session_pid("any").expect("pid");
        let started = std::time::Instant::now();
        let mut joins = Vec::new();
        for index in 0..20 {
            let request = text_request(&format!("hello {index}"));
            let context = ctx(&format!("sess-20-{index}"), false);
            let runtime = Arc::clone(shared.runtime.get().unwrap());
            joins.push(tokio::spawn(async move {
                let (tx, rx) = stream_channel();
                runtime.submit(request, context, tx).await.unwrap();
                crate::provider::collect_stream(rx).await
            }));
        }
        let mut texts = Vec::new();
        for join in joins {
            let response = timeout(Duration::from_secs(5), join)
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            assert_eq!(shared.session_pid("x").unwrap(), pid);
            if let ContentBlock::Text { text, .. } = &response.content[0] {
                texts.push(text.clone());
            }
        }
        let elapsed = started.elapsed();
        assert_eq!(texts.len(), 20);
        let unique: std::collections::HashSet<_> = texts.into_iter().collect();
        assert_eq!(unique.len(), 20, "outputs must not mix across slots");
        assert!(
            elapsed < Duration::from_millis(800),
            "20 slots should overlap, elapsed={elapsed:?}"
        );
        assert!(shared.runtime.get().unwrap().peak_running() >= 10);
        let slots = shared.runtime.get().unwrap().snapshots().await;
        assert_eq!(slots.len(), 20, "20 slots must stay distinct");
    }

    #[tokio::test]
    async fn memory_guard_rejects_when_rss_is_over_limit() {
        let provider = MultiplexCliProvider::simulated(2);
        provider.runtime().await.expect("start");
        provider
            .runtime
            .get()
            .unwrap()
            .memory
            .set_rss_override(4 * crate::provider::multiplex_cli::memory_guard::GIB);
        let err = collect(&provider, text_request("hello"), ctx("sess-oom", false))
            .await
            .unwrap_err();
        assert!(matches!(err, KernelError::Overloaded { .. }));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn message_start_arrives_before_slot_finishes() {
        let provider = MultiplexCliProvider::simulated(1);
        let rx = provider
            .execute_stream(&text_request("hello stream"), &ctx("sess-stream", false))
            .await
            .unwrap();
        let mut rx = rx;
        let first = timeout(Duration::from_millis(40), rx.recv())
            .await
            .expect("message_start should not wait for the slot")
            .unwrap()
            .unwrap();
        match first {
            StreamItem::Event(event) => {
                assert_eq!(
                    event.get("type").and_then(Value::as_str),
                    Some("message_start")
                );
            }
            other => panic!("expected message_start, got {other:?}"),
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn stdout_text_is_one_block_not_fake_tokens() {
        let provider = MultiplexCliProvider::simulated(1);
        let rx = provider
            .execute_stream(&text_request("hello stream"), &ctx("sess-block", false))
            .await
            .unwrap();
        let mut deltas = Vec::new();
        let mut types = Vec::new();
        let mut rx = rx;
        while let Some(item) = rx.recv().await {
            match item.unwrap() {
                StreamItem::Event(event) => {
                    types.push(
                        event
                            .get("type")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                    );
                    if event.pointer("/delta/type").and_then(Value::as_str) == Some("text_delta") {
                        deltas.push(event["delta"]["text"].as_str().unwrap_or("").to_string());
                    }
                }
                StreamItem::Finished(_) => {}
            }
        }
        assert_eq!(types.first().map(String::as_str), Some("message_start"));
        assert_eq!(deltas.len(), 1, "do not fake-chunk: {deltas:?}");
        assert!(deltas[0].contains("hello stream"), "{}", deltas[0]);
        assert!(types.iter().any(|t| t == "message_delta"));
        assert!(types.iter().any(|t| t == "message_stop"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn web_search_frames_are_forwarded() {
        let provider = MultiplexCliProvider::simulated(1);
        let rx = provider
            .execute_stream(
                &text_request("please [web_search] now"),
                &ctx("sess-ws", false),
            )
            .await
            .unwrap();
        let mut block_types = Vec::new();
        let mut deltas = Vec::new();
        let mut rx = rx;
        while let Some(item) = rx.recv().await {
            if let StreamItem::Event(event) = item.unwrap() {
                if event.get("type").and_then(Value::as_str) == Some("content_block_start") {
                    block_types.push(
                        event["content_block"]["type"]
                            .as_str()
                            .unwrap_or("")
                            .to_string(),
                    );
                }
                if event.pointer("/delta/type").and_then(Value::as_str) == Some("text_delta") {
                    deltas.push(event["delta"]["text"].as_str().unwrap_or("").to_string());
                }
            }
        }
        assert!(
            block_types.contains(&"server_tool_use".to_string()),
            "{block_types:?}"
        );
        assert!(
            block_types.contains(&"web_search_tool_result".to_string()),
            "{block_types:?}"
        );
        assert!(block_types.contains(&"text".to_string()), "{block_types:?}");
        assert_eq!(deltas, vec!["search-complete".to_string()]);
        assert!(
            !deltas.iter().any(|d| d.contains("DUPLICATE_FROM_KIN_DONE")),
            "{deltas:?}"
        );
    }

    /// AC13: a single job's stdout metering trips `MAX_JOB_BYTES` once its
    /// cumulative line bytes exceed the cap, while a concurrent job sharing
    /// the same CLI PID keeps accumulating independently and is unaffected.
    #[test]
    fn job_byte_metering_trips_only_the_oversized_job() {
        let mut job_bytes: HashMap<String, usize> = HashMap::new();

        // Job "big" steadily approaches the cap without tripping it yet.
        assert!(!charge_job_bytes(
            &mut job_bytes,
            "job-big",
            native_protocol::MAX_JOB_BYTES - 100
        ));
        // A concurrent job on the same PID has its own independent budget.
        assert!(!charge_job_bytes(&mut job_bytes, "job-small", 50));

        // "big" now crosses the cap and truncation should engage for it.
        assert!(charge_job_bytes(&mut job_bytes, "job-big", 200));
        // Once tripped, further bytes for the same job stay tripped.
        assert!(charge_job_bytes(&mut job_bytes, "job-big", 1));

        // "small" is completely unaffected by "big" having been truncated.
        assert!(!charge_job_bytes(&mut job_bytes, "job-small", 50));
    }

    #[test]
    fn validate_host_ready_rejects_config_hash_mismatch() {
        let mut cfg = test_cfg(Duration::from_secs(1));
        cfg.slot_count = 1;
        cfg.desired_config_hash = Some("expected-hash".into());
        let runtime = Runtime::new(cfg);
        let expected_envelope = envelope::load();
        let capabilities: Vec<String> = native_protocol::KIN_CAPABILITIES
            .iter()
            .map(|s| s.to_string())
            .collect();

        let err = runtime
            .validate_host_ready(
                native_protocol::KIN_PROTOCOL_VERSION,
                1,
                expected_envelope.mode.as_str(),
                &expected_envelope.timezone,
                &capabilities,
                Some("wrong-hash"),
            )
            .expect_err("mismatched config_hash must be rejected");
        assert!(
            err.contains("config_hash mismatch"),
            "unexpected error: {err}"
        );

        runtime
            .validate_host_ready(
                native_protocol::KIN_PROTOCOL_VERSION,
                1,
                expected_envelope.mode.as_str(),
                &expected_envelope.timezone,
                &capabilities,
                Some("expected-hash"),
            )
            .expect("matching config_hash must be accepted");
    }

    /// AC3: a native_messages job that ends on `tool_use` must assemble the
    /// correct `ContentBlock::ToolUse` from `kin_stream_event` frames alone
    /// (CLI sends empty `stop_reason`/`usage` in `kin_job_done`, per
    /// APPLY.md's second protocol-defect fix), free its slot once the
    /// response is delivered, and accept a second job on that same slot
    /// carrying the matching `ContentBlock::ToolResult` through to
    /// `StopReason::EndTurn`. This drives `handle_cli_frame()` directly
    /// (bypassing `submit()`/`resume()`, which require a real CLI child
    /// process for `write_cli_stdin()`) — see APPLY.md for the scope note.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn native_messages_tool_use_resume_round_trip() {
        let runtime = Runtime::new(test_cfg(Duration::from_secs(1)));
        let slot_id = "s00".to_string();
        runtime.register_native_ready(slot_id.clone()).await;

        // Turn 1: request ends on tool_use.
        let job_id_1 = "job-ac3-1".to_string();
        runtime.jobs.lock().await.insert(
            job_id_1.clone(),
            Job {
                job_id: job_id_1.clone(),
                slot_id: slot_id.clone(),
                request: text_request("please call echo"),
            },
        );
        let (tx1, mut rx1) = mpsc::channel(64);
        runtime.start_job_sink(job_id_1.clone(), tx1).await;

        runtime
            .handle_cli_frame(json!({
                "type": "kin_stream_event",
                "job_id": job_id_1,
                "slot_id": slot_id,
                "event": {
                    "type": "message_start",
                    "message": { "id": "msg_1", "model": "claude-sonnet-5", "usage": {} }
                }
            }))
            .await;
        runtime
            .handle_cli_frame(json!({
                "type": "kin_stream_event",
                "job_id": job_id_1,
                "slot_id": slot_id,
                "event": {
                    "type": "content_block_start",
                    "index": 0,
                    "content_block": { "type": "tool_use", "id": "toolu_1", "name": "echo", "input": {} }
                }
            }))
            .await;
        for chunk in ["{\"te", "xt\":\"", "hi\"}"] {
            runtime
                .handle_cli_frame(json!({
                    "type": "kin_stream_event",
                    "job_id": job_id_1,
                    "slot_id": slot_id,
                    "event": {
                        "type": "content_block_delta",
                        "index": 0,
                        "delta": { "type": "input_json_delta", "partial_json": chunk }
                    }
                }))
                .await;
        }
        runtime
            .handle_cli_frame(json!({
                "type": "kin_stream_event",
                "job_id": job_id_1,
                "slot_id": slot_id,
                "event": { "type": "content_block_stop", "index": 0 }
            }))
            .await;
        runtime
            .handle_cli_frame(json!({
                "type": "kin_stream_event",
                "job_id": job_id_1,
                "slot_id": slot_id,
                "event": {
                    "type": "message_delta",
                    "delta": { "stop_reason": "tool_use" },
                    "usage": { "output_tokens": 12, "input_tokens": 34 }
                }
            }))
            .await;
        runtime
            .handle_cli_frame(json!({
                "type": "kin_job_done",
                "job_id": job_id_1,
                "slot_id": slot_id,
                "stop_reason": "",
                "usage": {}
            }))
            .await;

        let response_1 = loop {
            match timeout(Duration::from_secs(1), rx1.recv())
                .await
                .expect("turn 1 stream item")
                .expect("turn 1 channel open")
                .expect("turn 1 item ok")
            {
                StreamItem::Finished(response) => break response,
                StreamItem::Event(_) => continue,
            }
        };
        assert!(matches!(response_1.stop_reason, StopReason::ToolUse));
        assert_eq!(response_1.usage.output_tokens, 12);
        assert_eq!(response_1.usage.input_tokens, 34);
        let tool_use_id = match &response_1.content[0] {
            ContentBlock::ToolUse {
                id, name, input, ..
            } => {
                assert_eq!(name, "echo");
                assert_eq!(input, &json!({"text": "hi"}));
                id.clone()
            }
            other => panic!("expected tool_use block, got {other:?}"),
        };

        // Slot must be free again (finish_sent_job re-registers native slots
        // unconditionally, including on ToolUse).
        drop(rx1);
        for _ in 0..20 {
            if !runtime.jobs.lock().await.contains_key(&job_id_1) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(!runtime.jobs.lock().await.contains_key(&job_id_1));
        assert!(
            runtime
                .slots
                .lock()
                .await
                .iter()
                .any(|slot| slot.id == slot_id && slot.phase == SlotPhase::ReadyBlocked),
            "slot should be re-registered ready after turn 1"
        );

        // Turn 2: continuation carries the matching tool_result, ends on end_turn.
        let job_id_2 = "job-ac3-2".to_string();
        let mut request_2 = text_request("please call echo");
        request_2.messages.push(Message {
            role: "user".into(),
            content: MessageContent::Blocks(vec![ContentBlock::ToolResult {
                tool_use_id: tool_use_id.clone(),
                content: json!("ok"),
                is_error: false,
                cache_control: None,
            }]),
            tool_call_id: None,
            tool_calls: Vec::new(),
        });
        runtime.jobs.lock().await.insert(
            job_id_2.clone(),
            Job {
                job_id: job_id_2.clone(),
                slot_id: slot_id.clone(),
                request: request_2,
            },
        );
        let (tx2, mut rx2) = mpsc::channel(64);
        runtime.start_job_sink(job_id_2.clone(), tx2).await;

        runtime
            .handle_cli_frame(json!({
                "type": "kin_stream_event",
                "job_id": job_id_2,
                "slot_id": slot_id,
                "event": {
                    "type": "content_block_start",
                    "index": 0,
                    "content_block": { "type": "text", "text": "" }
                }
            }))
            .await;
        runtime
            .handle_cli_frame(json!({
                "type": "kin_stream_event",
                "job_id": job_id_2,
                "slot_id": slot_id,
                "event": {
                    "type": "content_block_delta",
                    "index": 0,
                    "delta": { "type": "text_delta", "text": "done" }
                }
            }))
            .await;
        runtime
            .handle_cli_frame(json!({
                "type": "kin_stream_event",
                "job_id": job_id_2,
                "slot_id": slot_id,
                "event": {
                    "type": "message_delta",
                    "delta": { "stop_reason": "end_turn" },
                    "usage": { "output_tokens": 3, "input_tokens": 9 }
                }
            }))
            .await;
        runtime
            .handle_cli_frame(json!({
                "type": "kin_job_done",
                "job_id": job_id_2,
                "slot_id": slot_id,
                "stop_reason": "",
                "usage": {}
            }))
            .await;

        let response_2 = loop {
            match timeout(Duration::from_secs(1), rx2.recv())
                .await
                .expect("turn 2 stream item")
                .expect("turn 2 channel open")
                .expect("turn 2 item ok")
            {
                StreamItem::Finished(response) => break response,
                StreamItem::Event(_) => continue,
            }
        };
        assert!(matches!(response_2.stop_reason, StopReason::EndTurn));
        match &response_2.content[0] {
            ContentBlock::Text { text, .. } => assert_eq!(text, "done"),
            other => panic!("expected text block, got {other:?}"),
        }
    }

    /// AC17 "job-slot 不匹配丢弃": `handle_cli_frame()` must silently discard
    /// a `kin_stream_event`/`kin_job_done` frame whose `slot_id` does not
    /// match the job's actual assigned slot (`mod.rs`'s `job.slot_id !=
    /// slot_id` guards), rather than applying it to the wrong job's state.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn handle_cli_frame_discards_slot_id_mismatch() {
        let runtime = Runtime::new(test_cfg(Duration::from_secs(1)));
        let real_slot = "s00".to_string();
        let wrong_slot = "s99".to_string();
        runtime.register_native_ready(real_slot.clone()).await;

        let job_id = "job-ac17-mismatch".to_string();
        runtime.jobs.lock().await.insert(
            job_id.clone(),
            Job {
                job_id: job_id.clone(),
                slot_id: real_slot.clone(),
                request: text_request("hello"),
            },
        );
        let (tx, mut rx) = mpsc::channel(64);
        runtime.start_job_sink(job_id.clone(), tx).await;

        // A stream_event tagged with a slot_id that doesn't match the job's
        // real slot must be discarded: no StreamAssembler state, no emitted
        // StreamItem.
        runtime
            .handle_cli_frame(json!({
                "type": "kin_stream_event",
                "job_id": job_id,
                "slot_id": wrong_slot,
                "event": {
                    "type": "content_block_delta",
                    "index": 0,
                    "delta": { "type": "text_delta", "text": "should not apply" }
                }
            }))
            .await;
        assert!(
            !runtime.stream_assemblers.lock().await.contains_key(&job_id),
            "mismatched slot_id must not seed a StreamAssembler"
        );
        assert!(
            timeout(Duration::from_millis(100), rx.recv())
                .await
                .is_err(),
            "mismatched slot_id must not emit any StreamItem"
        );

        // A job_done tagged with the wrong slot_id must not complete the job.
        runtime
            .handle_cli_frame(json!({
                "type": "kin_job_done",
                "job_id": job_id,
                "slot_id": wrong_slot,
                "stop_reason": "end_turn",
                "usage": {}
            }))
            .await;
        assert!(
            runtime.jobs.lock().await.contains_key(&job_id),
            "mismatched slot_id job_done must not complete/remove the job"
        );
        assert!(
            timeout(Duration::from_millis(100), rx.recv())
                .await
                .is_err(),
            "mismatched slot_id job_done must not emit a Finished item"
        );

        // Sanity: the same frames on the correct slot_id do apply.
        runtime
            .handle_cli_frame(json!({
                "type": "kin_stream_event",
                "job_id": job_id,
                "slot_id": real_slot,
                "event": {
                    "type": "content_block_delta",
                    "index": 0,
                    "delta": { "type": "text_delta", "text": "ok" }
                }
            }))
            .await;
        assert!(
            runtime.stream_assemblers.lock().await.contains_key(&job_id),
            "matching slot_id must seed the StreamAssembler"
        );
        runtime
            .handle_cli_frame(json!({
                "type": "kin_job_done",
                "job_id": job_id,
                "slot_id": real_slot,
                "stop_reason": "end_turn",
                "usage": {}
            }))
            .await;
        loop {
            match timeout(Duration::from_secs(1), rx.recv())
                .await
                .expect("matching slot_id job_done must emit a stream item")
                .expect("channel open")
                .expect("item ok")
            {
                StreamItem::Finished(_) => break,
                StreamItem::Event(_) => continue,
            }
        }
        for _ in 0..20 {
            if !runtime.jobs.lock().await.contains_key(&job_id) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(
            !runtime.jobs.lock().await.contains_key(&job_id),
            "matching slot_id job_done must complete/remove the job"
        );
    }

    /// AC17 "取消七步时序" (R2): a slot must not be reusable until the
    /// terminal step of the cancel sequence — the real `KinStdin::Cancel`
    /// write succeeding means the slot stays occupied until a later
    /// `kin_cancel_ack` frame arrives; only a *failed* stdin write (CLI
    /// already gone) is allowed to free the slot immediately as a fallback.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn abort_terminal_job_waits_for_cancel_ack_before_freeing_slot() {
        let runtime = Runtime::new(test_cfg(Duration::from_secs(1)));
        let slot_id = "s00".to_string();
        runtime.register_native_ready(slot_id.clone()).await;

        let job_id = "job-ac17-cancel".to_string();
        runtime.jobs.lock().await.insert(
            job_id.clone(),
            Job {
                job_id: job_id.clone(),
                slot_id: slot_id.clone(),
                request: text_request("hello"),
            },
        );
        let (tx, _rx) = mpsc::channel(64);
        runtime.start_job_sink(job_id.clone(), tx).await;
        runtime.running.fetch_add(1, Ordering::Relaxed);

        // No CLI stdin is wired up in this test harness, so `write_cli_stdin`
        // fails exactly like a dead/never-started CLI process would — this
        // exercises abort_terminal_job's documented fallback branch, and is
        // the only branch a unit test (without a real ChildStdin) can drive.
        runtime.abort_terminal_job(&job_id, true).await;

        assert!(
            !runtime.jobs.lock().await.contains_key(&job_id),
            "abort_terminal_job must remove the job's bookkeeping unconditionally"
        );
        assert!(
            runtime
                .slots
                .lock()
                .await
                .iter()
                .any(|slot| slot.id == slot_id && slot.phase == SlotPhase::ReadyBlocked),
            "stdin write failure must fall back to freeing the slot immediately"
        );

        // Re-registering ready is idempotent: a real cancel_ack arriving
        // after the fallback already fired must not panic or double-count.
        runtime
            .handle_cli_frame(json!({
                "type": "kin_cancel_ack",
                "job_id": job_id,
                "slot_id": slot_id
            }))
            .await;
        assert!(
            runtime
                .slots
                .lock()
                .await
                .iter()
                .any(|slot| slot.id == slot_id && slot.phase == SlotPhase::ReadyBlocked),
            "a late cancel_ack must remain a no-op once the slot is already ready"
        );
    }

    /// A CLI-side terminal frame (`kin_job_error` here) already released the
    /// slot inside the CLI, and the CLI drops a `kin_cancel` for a job it no
    /// longer owns **without** acking it. Sending cancel on this path
    /// therefore leaked the slot forever (observed live: two failed jobs took
    /// a 2-slot runtime to `no_capacity`). The slot must come back
    /// immediately instead.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cli_side_job_error_frees_the_slot_without_a_cancel_ack() {
        let runtime = Runtime::new(test_cfg(Duration::from_secs(1)));
        runtime.start_simulated().await.expect("simulated cli");
        let slot_id = native_protocol::slot_id(0);

        let job_id = "job-cli-error".to_string();
        runtime.jobs.lock().await.insert(
            job_id.clone(),
            Job {
                job_id: job_id.clone(),
                slot_id: slot_id.clone(),
                request: text_request("hello"),
            },
        );
        let (tx, _rx) = mpsc::channel(64);
        runtime.start_job_sink(job_id.clone(), tx).await;
        runtime.running.fetch_add(1, Ordering::Relaxed);
        {
            let mut slots = runtime.slots.lock().await;
            let slot = slots
                .iter_mut()
                .find(|slot| slot.id == slot_id)
                .expect("registered slot");
            assert!(slot.bind_job("demo", "sess-cli-error", &job_id));
        }

        runtime
            .handle_cli_frame(json!({
                "type": "kin_job_error",
                "job_id": job_id,
                "slot_id": slot_id,
                "error": "API Error: 400 invalid_request_error"
            }))
            .await;

        assert!(
            !runtime.jobs.lock().await.contains_key(&job_id),
            "the failed job must be torn down"
        );
        assert!(
            runtime
                .slots
                .lock()
                .await
                .iter()
                .any(|slot| slot.id == slot_id && slot.phase == SlotPhase::ReadyBlocked),
            "slot must be reusable right after a CLI-side error, not wait for an ack that never comes"
        );
        assert_eq!(
            runtime.ready_slots(),
            1,
            "the freed slot must be schedulable"
        );
    }
}
