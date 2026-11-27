use scheduler_core::{EngineOptions, SchedulerEngine};
use scheduler_daemon::config::DaemonConfig;
use scheduler_daemon::server::start_server;
use std::sync::Arc;
use tracing::{error, info};

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_writer(std::io::stderr)
        .with_target(false)
        .init();

    let cfg = match DaemonConfig::parse_from_args_and_env() {
        Ok(c) => c,
        Err(msg) => {
            eprintln!("{msg}");
            std::process::exit(2);
        }
    };

    let engine = Arc::new(SchedulerEngine::new(EngineOptions {
        lease_ttl_ms: cfg.lease_ttl_ms,
        ..Default::default()
    }));

    let running = match start_server(cfg, engine).await {
        Ok(r) => r,
        Err(err) => {
            error!(error = %err, "failed to start kin-scheduler");
            std::process::exit(1);
        }
    };

    wait_for_shutdown_signal().await;
    info!("shutdown signal received, draining kin-scheduler");
    let _ = running.shutdown_tx.send(());

    match running.join_handle.await {
        Ok(Ok(())) => info!("kin-scheduler stopped cleanly"),
        Ok(Err(e)) => {
            error!(error = %e, "kin-scheduler exited with error");
            std::process::exit(1);
        }
        Err(e) => {
            error!(error = %e, "kin-scheduler server task panicked");
            std::process::exit(1);
        }
    }
}

async fn wait_for_shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut sig) => {
                sig.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {}
        _ = terminate => {}
    }
}
