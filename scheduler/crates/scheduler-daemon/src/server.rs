use crate::config::DaemonConfig;
use crate::router::build_router;
use scheduler_core::SchedulerEngine;
use serde::{Deserialize, Serialize};
use std::fs;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tracing::{info, warn};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CapabilityFile {
    pub transport: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub socket_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub addr: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    pub token: String,
    pub pid: u32,
}

#[derive(Clone, Debug)]
pub enum BoundEndpoint {
    #[cfg(unix)]
    Unix(PathBuf),
    Tcp(SocketAddr),
}

pub struct RunningServer {
    pub endpoint: BoundEndpoint,
    pub shutdown_tx: oneshot::Sender<()>,
    pub join_handle: tokio::task::JoinHandle<Result<(), String>>,
}

pub async fn start_server(
    cfg: DaemonConfig,
    engine: Arc<SchedulerEngine>,
) -> Result<RunningServer, String> {
    let token = Arc::new(cfg.token.clone());
    let app = build_router(Arc::clone(&engine), token);

    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    let (reap_stop_tx, mut reap_stop_rx) = oneshot::channel::<()>();

    // Spawn background 5s lease/poison/idempotency/sticky reaper task
    let reaper_engine = Arc::clone(&engine);
    let reap_interval = Duration::from_millis(cfg.reap_interval_ms);
    let reaper_handle = tokio::spawn(async move {
        let mut ticker = tokio::time::interval(reap_interval);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                _ = ticker.tick() => {
                    let _ = reaper_engine.reap_expired();
                }
                _ = &mut reap_stop_rx => {
                    break;
                }
            }
        }
    });

    #[cfg(unix)]
    if let Some(sock_path) = cfg.socket_path.clone() {
        if let Some(parent) = sock_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("failed to create socket dir '{}': {e}", parent.display()))?;
        }
        let _ = fs::remove_file(&sock_path);

        let listener = tokio::net::UnixListener::bind(&sock_path)
            .map_err(|e| format!("failed to bind unix socket '{}': {e}", sock_path.display()))?;

        set_mode_0600(&sock_path)?;

        if let Some(cap_path) = &cfg.cap_file {
            write_cap_file(
                cap_path,
                &CapabilityFile {
                    transport: "unix".to_owned(),
                    socket_path: Some(sock_path.display().to_string()),
                    addr: None,
                    host: None,
                    port: None,
                    token: cfg.token.clone(),
                    pid: std::process::id(),
                },
            )?;
        }

        info!(socket = %sock_path.display(), "kin-scheduler listening on UDS");
        let cleanup_path = sock_path.clone();
        let join_handle = tokio::spawn(async move {
            let res = axum::serve(listener, app)
                .with_graceful_shutdown(async move {
                    let _ = shutdown_rx.await;
                })
                .await
                .map_err(|e| format!("unix server error: {e}"));
            let _ = reap_stop_tx.send(());
            let _ = reaper_handle.await;
            let _ = fs::remove_file(&cleanup_path);
            res
        });

        return Ok(RunningServer {
            endpoint: BoundEndpoint::Unix(sock_path),
            shutdown_tx,
            join_handle,
        });
    }

    let bind_addr = cfg
        .listen_addr
        .clone()
        .unwrap_or_else(|| "127.0.0.1:0".to_owned());
    let listener = TcpListener::bind(&bind_addr)
        .await
        .map_err(|e| format!("failed to bind tcp '{bind_addr}': {e}"))?;
    let local_addr = listener
        .local_addr()
        .map_err(|e| format!("failed to read local_addr: {e}"))?;

    if let Some(cap_path) = &cfg.cap_file {
        write_cap_file(
            cap_path,
            &CapabilityFile {
                transport: "tcp".to_owned(),
                socket_path: None,
                addr: Some(local_addr.to_string()),
                host: Some(local_addr.ip().to_string()),
                port: Some(local_addr.port()),
                token: cfg.token.clone(),
                pid: std::process::id(),
            },
        )?;
    }

    info!(addr = %local_addr, "kin-scheduler listening on TCP");
    let join_handle = tokio::spawn(async move {
        let res = axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
            .map_err(|e| format!("tcp server error: {e}"));
        let _ = reap_stop_tx.send(());
        let _ = reaper_handle.await;
        res
    });

    Ok(RunningServer {
        endpoint: BoundEndpoint::Tcp(local_addr),
        shutdown_tx,
        join_handle,
    })
}

fn write_cap_file(path: &Path, cap: &CapabilityFile) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create cap-file dir '{}': {e}", parent.display()))?;
    }
    let tmp_path = path.with_extension("tmp");
    let json =
        serde_json::to_vec_pretty(cap).map_err(|e| format!("failed to serialize cap-file: {e}"))?;
    fs::write(&tmp_path, json)
        .map_err(|e| format!("failed to write cap-file '{}': {e}", tmp_path.display()))?;
    #[cfg(unix)]
    set_mode_0600(&tmp_path)?;
    if let Err(e) = fs::rename(&tmp_path, path) {
        warn!(error = %e, "atomic cap-file rename failed; falling back to direct write");
        fs::write(path, serde_json::to_vec_pretty(cap).unwrap_or_default())
            .map_err(|e2| format!("failed to write cap-file '{}': {e2}", path.display()))?;
        #[cfg(unix)]
        set_mode_0600(path)?;
        let _ = fs::remove_file(&tmp_path);
    }
    Ok(())
}

#[cfg(unix)]
fn set_mode_0600(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let perms = fs::Permissions::from_mode(0o600);
    fs::set_permissions(path, perms)
        .map_err(|e| format!("failed to chmod 0600 '{}': {e}", path.display()))
}
