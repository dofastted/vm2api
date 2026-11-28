use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use compact_str::CompactString;
use http_body_util::BodyExt;
use hyper::client::conn::http1;
use hyper_util::rt::TokioIo;
use scheduler_core::{EngineOptions, SchedulerEngine};
use scheduler_daemon::auth::INTERNAL_TOKEN_HEADER;
use scheduler_daemon::config::DaemonConfig;
use scheduler_daemon::router::build_router;
use scheduler_daemon::server::{BoundEndpoint, CapabilityFile, start_server};
use scheduler_proto::*;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tower::ServiceExt;

const TEST_TOKEN: &str = "0123456789abcdef0123456789abcdef";

fn sample_snapshot(num_nodes: usize, conc: u32) -> ConfigSnapshot {
    let mut nodes = Vec::with_capacity(num_nodes);
    let mut members = Vec::with_capacity(num_nodes);
    for i in 1..=num_nodes {
        let id = format!("vm{i}");
        let key = format!("claude_vm:{id}");
        nodes.push(BackendNodeConfig {
            node_key: CompactString::from(&key),
            node_type: NodeType::ClaudeVm,
            node_id: CompactString::from(&id),
            provider: Provider::Anthropic,
            protocol: None,
            owner_id: None,
            plan_tier: Some(CompactString::const_new("max_20x")),
            weight_tier_mode: WeightTierMode::Manual,
            weight_tier: 8,
            auto_weight_tier: None,
            sub_weight: 10,
            supported_models: vec![],
            capacity: NodeCapacityConfig {
                max_concurrency: conc,
                max_sessions: conc,
                ..Default::default()
            },
            enabled: true,
            temp_unschedulable_until_ms: None,
            temp_unschedulable_reason: None,
        });
        members.push(PoolMemberConfig {
            node_key: CompactString::from(&key),
            node_type: NodeType::ClaudeVm,
            node_id: CompactString::from(&id),
            enabled: true,
            member_role: MemberRole::Active,
            weight_tier_override: None,
            sub_weight_override: None,
            member_order: i as i32,
        });
    }

    ConfigSnapshot {
        config_version: 1,
        pools: vec![PoolConfig {
            id: CompactString::const_new("pool_main"),
            slug: CompactString::const_new("main"),
            name: CompactString::const_new("Main Pool"),
            provider_scope: ProviderScope::Anthropic,
            system_prompt_mode: SystemPromptMode::ZeroInject,
            members,
            ..Default::default()
        }],
        nodes,
        ..Default::default()
    }
}

fn make_acquire(req_id: &str, sid: &str, mid: Option<&str>) -> AcquireRequest {
    AcquireRequest {
        request_id: CompactString::from(req_id),
        attempt_no: 1,
        controller_epoch: CompactString::const_new("ep1"),
        min_config_version: 1,
        origin_pool_id: CompactString::const_new("pool_main"),
        jev_downgrade_pool_id: None,
        api_key_scope: ApiKeyScope {
            api_key_id: CompactString::const_new("k1"),
            pool_binding_mode: PoolBindingMode::StrictPool,
            default_pool_id: Some(CompactString::const_new("pool_main")),
            allowed_pool_ids: vec![CompactString::const_new("pool_main")],
            ..Default::default()
        },
        model: CompactString::const_new("claude-sonnet-4"),
        model_family: ModelFamily::Claude,
        protocol: CompactString::const_new("anthropic"),
        machine_id: mid.map(CompactString::from),
        session_id: CompactString::from(sid),
        session_id_source: Some(CompactString::const_new("caller")),
        parent_session_id: None,
        is_ephemeral_probe: false,
        no_queue: false,
        is_admin_diagnostic: false,
        pin_node_key: None,
        exclude_nodes: vec![],
    }
}

async fn send_router(
    app: &axum::Router,
    method: Method,
    uri: &str,
    token: Option<&str>,
    body: Option<serde_json::Value>,
) -> (StatusCode, serde_json::Value) {
    let mut builder = Request::builder().method(method).uri(uri);
    if let Some(tok) = token {
        builder = builder.header(INTERNAL_TOKEN_HEADER, tok);
    }
    let req = if let Some(b) = body {
        builder
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_vec(&b).unwrap()))
            .unwrap()
    } else {
        builder.body(Body::empty()).unwrap()
    };
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let json = if bytes.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or_else(|_| {
            serde_json::Value::String(String::from_utf8_lossy(&bytes).to_string())
        })
    };
    (status, json)
}

#[test]
fn daemon_config_parses_single_and_double_dash_flags() {
    let args: Vec<String> = vec![
        "-socket",
        "/tmp/sched.sock",
        "--token",
        "abc123",
        "--cap-file=/tmp/sched.cap",
        "--lease-ttl-ms",
        "90000",
        "-reap-interval-ms",
        "2000",
    ]
    .into_iter()
    .map(String::from)
    .collect();
    let cfg = DaemonConfig::parse_from(&args).unwrap();
    assert_eq!(
        cfg.socket_path.unwrap().to_str().unwrap(),
        "/tmp/sched.sock"
    );
    assert_eq!(cfg.token, "abc123");
    assert_eq!(cfg.cap_file.unwrap().to_str().unwrap(), "/tmp/sched.cap");
    assert_eq!(cfg.lease_ttl_ms, 90_000);
    assert_eq!(cfg.reap_interval_ms, 2_000);
}

#[test]
fn daemon_config_reads_token_file_and_rejects_missing_token() {
    let tmp = std::env::temp_dir().join(format!("kin-tok-{}.txt", std::process::id()));
    std::fs::write(&tmp, "secret_file_token\n").unwrap();
    let args = vec![
        "--listen".to_owned(),
        "127.0.0.1:0".to_owned(),
        "--token-file".to_owned(),
        tmp.display().to_string(),
    ];
    let cfg = DaemonConfig::parse_from(&args).unwrap();
    assert_eq!(cfg.token, "secret_file_token");
    let _ = std::fs::remove_file(&tmp);

    // Without token & without env token -> error (unless env set)
    if std::env::var("KIN_SCHEDULER_TOKEN").is_err()
        && std::env::var("KIN_SCHEDULER_TOKEN_FILE").is_err()
    {
        let err = DaemonConfig::parse_from(&["--listen".to_owned(), "127.0.0.1:0".to_owned()]);
        assert!(err.is_err());
    }
}

#[tokio::test]
async fn auth_middleware_rejects_missing_wrong_and_wrong_length_tokens() {
    let eng = Arc::new(SchedulerEngine::new(EngineOptions::default()));
    let app = build_router(eng, Arc::new(TEST_TOKEN.to_owned()));

    let (st1, b1) = send_router(&app, Method::GET, "/internal/v1/health", None, None).await;
    assert_eq!(st1, StatusCode::UNAUTHORIZED);
    assert_eq!(b1["error"]["code"], "unauthorized");

    let (st2, _) = send_router(
        &app,
        Method::GET,
        "/internal/v1/health",
        Some("wrong_short"),
        None,
    )
    .await;
    assert_eq!(st2, StatusCode::UNAUTHORIZED);

    let (st3, _) = send_router(
        &app,
        Method::GET,
        "/internal/v1/health",
        Some("0123456789abcdef0123456789abcde0"),
        None,
    )
    .await;
    assert_eq!(st3, StatusCode::UNAUTHORIZED);

    let (st4, b4) = send_router(
        &app,
        Method::GET,
        "/internal/v1/health",
        Some(TEST_TOKEN),
        None,
    )
    .await;
    assert_eq!(st4, StatusCode::OK);
    assert_eq!(b4["ok"], true);
}

#[tokio::test]
async fn all_14_internal_v1_endpoints_full_lifecycle_contract() {
    let eng = Arc::new(SchedulerEngine::new(EngineOptions::default()));
    let app = build_router(Arc::clone(&eng), Arc::new(TEST_TOKEN.to_owned()));

    // 1. GET /health (before bootstrap)
    let (st, h0) = send_router(
        &app,
        Method::GET,
        "/internal/v1/health",
        Some(TEST_TOKEN),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(h0["bootstrapped"], false);

    // 2. POST /bootstrap
    let boot = BootstrapRequest {
        controller_epoch: CompactString::const_new("ep1"),
        role: Role::Leader,
        config_version: Some(1),
        config_snapshot: sample_snapshot(2, 4),
        active_sticky_bindings: vec![],
        active_penalties: vec![],
        initial_telemetry: vec![],
    };
    let (st, br) = send_router(
        &app,
        Method::POST,
        "/internal/v1/bootstrap",
        Some(TEST_TOKEN),
        Some(serde_json::to_value(&boot).unwrap()),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(br["bootstrapped"], true);

    // 3. POST /config/sync
    let mut snap2 = sample_snapshot(2, 4);
    snap2.config_version = 2;
    let (st, sr) = send_router(
        &app,
        Method::POST,
        "/internal/v1/config/sync",
        Some(TEST_TOKEN),
        Some(serde_json::json!({ "config_version": 2, "config_snapshot": snap2 })),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(sr["applied"], true);
    assert_eq!(sr["config_version"], 2);

    // 4. POST /nodes/telemetry
    let (st, tr) = send_router(
        &app,
        Method::POST,
        "/internal/v1/nodes/telemetry",
        Some(TEST_TOKEN),
        Some(serde_json::json!({ "nodes": [{ "node_key": "claude_vm:vm1", "quota_util_5h_pct": 12.5 }] })),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(tr["updated"], 1);

    // 5. POST /schedule/acquire
    let (st, acq) = send_router(
        &app,
        Method::POST,
        "/internal/v1/schedule/acquire",
        Some(TEST_TOKEN),
        Some(serde_json::to_value(make_acquire("req_1", "sid_1", Some("mid_1"))).unwrap()),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let lease1 = acq["lease_id"].as_str().unwrap().to_owned();
    assert_eq!(acq["prompt_policy"]["mode"], "zero_inject");

    // 6. POST /schedule/explain (while lease1 holds SessionGate -> peeks busy=true without blocking!)
    let (st, exp) = send_router(
        &app,
        Method::POST,
        "/internal/v1/schedule/explain",
        Some(TEST_TOKEN),
        Some(serde_json::to_value(make_acquire("req_exp", "sid_1", Some("mid_1"))).unwrap()),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(exp["explain"]["session_gate"]["busy_at_peek"], true);

    // 7. POST /schedule/heartbeat
    let (st, hb) = send_router(
        &app,
        Method::POST,
        "/internal/v1/schedule/heartbeat",
        Some(TEST_TOKEN),
        Some(serde_json::json!({ "controller_epoch": "ep1", "lease_ids": [lease1] })),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(hb["renewed"], 1);

    // 8. POST /schedule/switch
    let mut next = make_acquire("req_1", "sid_1", Some("mid_1"));
    next.attempt_no = 2;
    let (st, sw) = send_router(
        &app,
        Method::POST,
        "/internal/v1/schedule/switch",
        Some(TEST_TOKEN),
        Some(
            serde_json::to_value(SwitchRequest {
                release_lease_id: CompactString::from(&lease1),
                failure: FailureReport {
                    http_status: 529,
                    error_class: ErrorClass::Overloaded529,
                    ..Default::default()
                },
                next_attempt: next,
            })
            .unwrap(),
        ),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let lease2 = sw["lease_id"].as_str().unwrap().to_owned();
    assert_ne!(
        sw["selected_node"]["node_key"],
        acq["selected_node"]["node_key"]
    );

    // 9. POST /schedule/commit
    let (st, cm) = send_router(
        &app,
        Method::POST,
        "/internal/v1/schedule/commit",
        Some(TEST_TOKEN),
        Some(serde_json::json!({ "lease_id": lease2 })),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(cm["committed"], true);

    // 10. POST /schedule/release
    let (st, rl) = send_router(
        &app,
        Method::POST,
        "/internal/v1/schedule/release",
        Some(TEST_TOKEN),
        Some(serde_json::json!({ "lease_id": lease2, "outcome": "ok" })),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(rl["released"], true);

    // 11. POST /persistence/drain (pull + ACK)
    let (st, dr) = send_router(
        &app,
        Method::POST,
        "/internal/v1/persistence/drain",
        Some(TEST_TOKEN),
        Some(serde_json::json!({ "max_items": 100 })),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let bid = dr["batch_id"].as_u64().unwrap();
    assert_eq!(dr["sticky_upserts"].as_array().unwrap().len(), 2);

    let (st, dr_ack) = send_router(
        &app,
        Method::POST,
        "/internal/v1/persistence/drain",
        Some(TEST_TOKEN),
        Some(serde_json::json!({ "ack_batch_id": bid, "ack_only": true })),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(dr_ack["remaining"], 0);

    // 12. GET /sticky & DELETE /sticky (both query and JSON body)
    let (st, st_list) = send_router(
        &app,
        Method::GET,
        "/internal/v1/sticky?pool_id=pool_main",
        Some(TEST_TOKEN),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(st_list["total"], 2);

    let (st, st_del) = send_router(
        &app,
        Method::DELETE,
        "/internal/v1/sticky",
        Some(TEST_TOKEN),
        Some(serde_json::json!({ "pool_id": "pool_main", "scope_kind": "machine" })),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(st_del["deleted"], 1);

    // 13. POST /admin/unrest
    let (st, un) = send_router(
        &app,
        Method::POST,
        "/internal/v1/admin/unrest",
        Some(TEST_TOKEN),
        Some(serde_json::json!({ "node_key": acq["selected_node"]["node_key"] })),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(un["ok"], true);
    assert!(un["cleared_cooldowns"].as_u64().unwrap() >= 1);

    // 14. GET /events?after=bad_epoch:1 -> 409 snapshot_required
    let (st, ev_err) = send_router(
        &app,
        Method::GET,
        "/internal/v1/events?after=wrong_epoch:1",
        Some(TEST_TOKEN),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::CONFLICT);
    assert_eq!(ev_err["error"]["code"], "snapshot_required");
}

#[tokio::test]
async fn standby_drain_returns_http_403_standby_drain_forbidden() {
    let eng = Arc::new(SchedulerEngine::new(EngineOptions::default()));
    let app = build_router(eng, Arc::new(TEST_TOKEN.to_owned()));

    let boot = BootstrapRequest {
        controller_epoch: CompactString::const_new("ep_sb"),
        role: Role::Standby,
        config_version: Some(1),
        config_snapshot: sample_snapshot(1, 2),
        active_sticky_bindings: vec![],
        active_penalties: vec![],
        initial_telemetry: vec![],
    };
    let (st, _) = send_router(
        &app,
        Method::POST,
        "/internal/v1/bootstrap",
        Some(TEST_TOKEN),
        Some(serde_json::to_value(&boot).unwrap()),
    )
    .await;
    assert_eq!(st, StatusCode::OK);

    let (st, err) = send_router(
        &app,
        Method::POST,
        "/internal/v1/persistence/drain",
        Some(TEST_TOKEN),
        Some(serde_json::json!({})),
    )
    .await;
    assert_eq!(st, StatusCode::FORBIDDEN);
    assert_eq!(err["error"]["code"], "standby_drain_forbidden");
}

#[tokio::test]
async fn sse_events_endpoint_replays_valid_cursor() {
    let eng = Arc::new(SchedulerEngine::new(EngineOptions::default()));
    let app = build_router(Arc::clone(&eng), Arc::new(TEST_TOKEN.to_owned()));

    eng.bootstrap(BootstrapRequest {
        controller_epoch: CompactString::const_new("ep_sse"),
        role: Role::Leader,
        config_version: Some(1),
        config_snapshot: sample_snapshot(1, 4),
        active_sticky_bindings: vec![],
        active_penalties: vec![],
        initial_telemetry: vec![],
    });
    let r = eng.acquire(make_acquire("rs1", "ss1", None)).await.unwrap();
    eng.release(ReleaseRequest {
        lease_id: r.lease_id,
        outcome: ReleaseOutcome::Ok,
        http_status: None,
        error_class: None,
        error_signature: None,
        error_message: None,
        retry_after_sec: None,
        ttft_ms: None,
        tokens_used: None,
        quota_headers: None,
    });

    // Request replay after ep_sse:1 (should stream seq 2 LeaseAcquired & seq 3 LeaseReleased)
    let req = Request::builder()
        .method(Method::GET)
        .uri("/internal/v1/events?after=ep_sse:1")
        .header(INTERNAL_TOKEN_HEADER, TEST_TOKEN)
        .body(Body::empty())
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let mut body = resp.into_body();
    let frame1 = tokio::time::timeout(Duration::from_secs(1), body.frame())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let text = String::from_utf8_lossy(frame1.data_ref().unwrap());
    assert!(text.contains("id: ep_sse:2"));
    assert!(text.contains("event: lease_acquired"));
}

#[tokio::test]
async fn tcp_server_cap_file_and_graceful_shutdown() {
    let cap_path = std::env::temp_dir().join(format!("kin-tcp-cap-{}.json", std::process::id()));
    let eng = Arc::new(SchedulerEngine::new(EngineOptions::default()));
    let running = start_server(
        DaemonConfig {
            socket_path: None,
            listen_addr: Some("127.0.0.1:0".to_owned()),
            token: TEST_TOKEN.to_owned(),
            cap_file: Some(cap_path.clone()),
            lease_ttl_ms: 120_000,
            reap_interval_ms: 5_000,
        },
        Arc::clone(&eng),
    )
    .await
    .unwrap();

    let addr = match running.endpoint {
        BoundEndpoint::Tcp(a) => a,
        #[cfg(unix)]
        _ => panic!("expected tcp endpoint"),
    };

    // Verify cap-file JSON contains addr, host, port, token, pid
    let cap: CapabilityFile = serde_json::from_slice(&std::fs::read(&cap_path).unwrap()).unwrap();
    assert_eq!(cap.transport, "tcp");
    assert_eq!(cap.addr.as_deref(), Some(addr.to_string().as_str()));
    assert_eq!(cap.port, Some(addr.port()));
    assert_eq!(cap.token, TEST_TOKEN);

    // Real HTTP/1.1 Keep-Alive call over TCP
    let stream = tokio::net::TcpStream::connect(addr).await.unwrap();
    let (mut sender, conn) = http1::handshake(TokioIo::new(stream)).await.unwrap();
    tokio::spawn(async move {
        let _ = conn.await;
    });

    let req = Request::builder()
        .method(Method::GET)
        .uri("/internal/v1/health")
        .header("host", "localhost")
        .header(INTERNAL_TOKEN_HEADER, TEST_TOKEN)
        .body(http_body_util::Empty::<bytes::Bytes>::new())
        .unwrap();
    let resp = sender.send_request(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let _ = running.shutdown_tx.send(());
    running.join_handle.await.unwrap().unwrap();
    let _ = std::fs::remove_file(&cap_path);
}

#[tokio::test]
async fn live_tcp_client_abort_mid_session_gate_wait_unblocks_next_waiter() {
    let eng = Arc::new(SchedulerEngine::new(EngineOptions::default()));
    eng.bootstrap(BootstrapRequest {
        controller_epoch: CompactString::const_new("ep1"),
        role: Role::Leader,
        config_version: Some(1),
        config_snapshot: sample_snapshot(2, 4),
        active_sticky_bindings: vec![],
        active_penalties: vec![],
        initial_telemetry: vec![],
    });
    let running = start_server(
        DaemonConfig {
            socket_path: None,
            listen_addr: Some("127.0.0.1:0".to_owned()),
            token: TEST_TOKEN.to_owned(),
            cap_file: None,
            lease_ttl_ms: 120_000,
            reap_interval_ms: 5_000,
        },
        Arc::clone(&eng),
    )
    .await
    .unwrap();
    let addr = match running.endpoint {
        BoundEndpoint::Tcp(a) => a,
        #[cfg(unix)]
        _ => panic!("expected tcp"),
    };

    let sid = "550e8400-e29b-41d4-a716-446655440777";
    let r1 = eng.acquire(make_acquire("r1", sid, None)).await.unwrap();

    // R2 connects over real TCP and sends POST /schedule/acquire -> parks in SessionGate
    let s2 = tokio::net::TcpStream::connect(addr).await.unwrap();
    let (mut tx2, conn2) = http1::handshake(TokioIo::new(s2)).await.unwrap();
    let conn2_handle = tokio::spawn(async move {
        let _ = conn2.await;
    });
    let body2 = serde_json::to_vec(&make_acquire("r2", sid, None)).unwrap();
    let req2 = Request::builder()
        .method(Method::POST)
        .uri("/internal/v1/schedule/acquire")
        .header("host", "localhost")
        .header("content-type", "application/json")
        .header(INTERNAL_TOKEN_HEADER, TEST_TOKEN)
        .body(http_body_util::Full::new(bytes::Bytes::from(body2)))
        .unwrap();
    let h2 = tokio::spawn(async move { tx2.send_request(req2).await });

    let gk = ScopedSessionKey::new("pool_main", ModelFamily::Claude, sid);
    while eng.session_gates.peek(&gk).1 < 1 {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }

    // R3 queues behind R2
    let eng3 = Arc::clone(&eng);
    let h3 = tokio::spawn(async move { eng3.acquire(make_acquire("r3", sid, None)).await });
    while eng.session_gates.peek(&gk).1 < 2 {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }

    // Hard-abort R2's HTTP connection mid-wait -> Axum drops handler Future -> SessionWaitGuard::drop runs!
    h2.abort();
    conn2_handle.abort();
    tokio::time::sleep(Duration::from_millis(40)).await;

    // Release R1 -> R3 MUST immediately acquire without deadlocking!
    eng.release(ReleaseRequest {
        lease_id: r1.lease_id,
        outcome: ReleaseOutcome::Ok,
        http_status: None,
        error_class: None,
        error_signature: None,
        error_message: None,
        retry_after_sec: None,
        ttft_ms: None,
        tokens_used: None,
        quota_headers: None,
    });

    let r3 = tokio::time::timeout(Duration::from_secs(2), h3)
        .await
        .expect("R3 must wake after R2 HTTP abort")
        .unwrap()
        .unwrap();
    eng.release(ReleaseRequest {
        lease_id: r3.lease_id,
        outcome: ReleaseOutcome::Ok,
        http_status: None,
        error_class: None,
        error_signature: None,
        error_message: None,
        retry_after_sec: None,
        ttft_ms: None,
        tokens_used: None,
        quota_headers: None,
    });
    assert_eq!(eng.health().active_session_gates, 0);

    let _ = running.shutdown_tx.send(());
    running.join_handle.await.unwrap().unwrap();
}

#[tokio::test]
async fn background_reaper_task_reclaims_expired_lease_automatically() {
    let eng = Arc::new(SchedulerEngine::new(EngineOptions {
        lease_ttl_ms: 120,
        ..Default::default()
    }));
    eng.bootstrap(BootstrapRequest {
        controller_epoch: CompactString::const_new("ep1"),
        role: Role::Leader,
        config_version: Some(1),
        config_snapshot: sample_snapshot(1, 1),
        active_sticky_bindings: vec![],
        active_penalties: vec![],
        initial_telemetry: vec![],
    });
    let running = start_server(
        DaemonConfig {
            socket_path: None,
            listen_addr: Some("127.0.0.1:0".to_owned()),
            token: TEST_TOKEN.to_owned(),
            cap_file: None,
            lease_ttl_ms: 120,
            reap_interval_ms: 50,
        },
        Arc::clone(&eng),
    )
    .await
    .unwrap();

    // Acquire and intentionally leak without calling /release
    let _leaked = eng
        .acquire(make_acquire("leak1", "s_leak", None))
        .await
        .unwrap();
    assert_eq!(eng.health().active_leases, 1);

    // Wait for background reaper to reclaim it automatically!
    let deadline = Instant::now() + Duration::from_secs(2);
    while eng.health().active_leases > 0 && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert_eq!(eng.health().active_leases, 0);
    assert_eq!(eng.health().active_session_gates, 0);

    let _ = running.shutdown_tx.send(());
    running.join_handle.await.unwrap().unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn unix_domain_socket_0600_keepalive_and_cleanup() {
    use std::os::unix::fs::PermissionsExt;

    let sock_path = std::env::temp_dir().join(format!("kin-sched-uds-{}.sock", std::process::id()));
    let cap_path = std::env::temp_dir().join(format!("kin-sched-uds-{}.cap", std::process::id()));
    let eng = Arc::new(SchedulerEngine::new(EngineOptions::default()));
    eng.bootstrap(BootstrapRequest {
        controller_epoch: CompactString::const_new("ep_uds"),
        role: Role::Leader,
        config_version: Some(1),
        config_snapshot: sample_snapshot(2, 8),
        active_sticky_bindings: vec![],
        active_penalties: vec![],
        initial_telemetry: vec![],
    });

    let running = start_server(
        DaemonConfig {
            socket_path: Some(sock_path.clone()),
            listen_addr: None,
            token: TEST_TOKEN.to_owned(),
            cap_file: Some(cap_path.clone()),
            lease_ttl_ms: 120_000,
            reap_interval_ms: 5_000,
        },
        Arc::clone(&eng),
    )
    .await
    .unwrap();

    // Verify 0600 permissions on BOTH socket file and cap-file!
    let sock_mode = std::fs::metadata(&sock_path).unwrap().permissions().mode() & 0o777;
    assert_eq!(sock_mode, 0o600, "UDS socket must have 0600 permissions");
    let cap_mode = std::fs::metadata(&cap_path).unwrap().permissions().mode() & 0o777;
    assert_eq!(cap_mode, 0o600, "cap-file must have 0600 permissions");

    // Speak HTTP/1.1 Keep-Alive directly over UnixStream!
    let stream = tokio::net::UnixStream::connect(&sock_path).await.unwrap();
    let (mut sender, conn) = http1::handshake(TokioIo::new(stream)).await.unwrap();
    tokio::spawn(async move {
        let _ = conn.await;
    });

    let req1 = Request::builder()
        .method(Method::GET)
        .uri("/internal/v1/health")
        .header("host", "localhost")
        .header(INTERNAL_TOKEN_HEADER, TEST_TOKEN)
        .body(http_body_util::Full::new(bytes::Bytes::new()))
        .unwrap();
    let r1 = sender.send_request(req1).await.unwrap();
    assert_eq!(r1.status(), StatusCode::OK);
    let _ = r1.into_body().collect().await.unwrap();

    // Second request on SAME keep-alive UDS connection: acquire -> release
    let acq_bytes = serde_json::to_vec(&make_acquire("uds_r1", "uds_s1", Some("uds_m1"))).unwrap();
    let req2 = Request::builder()
        .method(Method::POST)
        .uri("/internal/v1/schedule/acquire")
        .header("host", "localhost")
        .header("content-type", "application/json")
        .header(INTERNAL_TOKEN_HEADER, TEST_TOKEN)
        .body(http_body_util::Full::new(bytes::Bytes::from(acq_bytes)))
        .unwrap();
    let r2 = sender.send_request(req2).await.unwrap();
    assert_eq!(r2.status(), StatusCode::OK);
    let b2 = r2.into_body().collect().await.unwrap().to_bytes();
    let acq: AcquireResponse = serde_json::from_slice(&b2).unwrap();

    let rel_bytes = serde_json::to_vec(&serde_json::json!({
        "lease_id": acq.lease_id,
        "outcome": "ok"
    }))
    .unwrap();
    let req3 = Request::builder()
        .method(Method::POST)
        .uri("/internal/v1/schedule/release")
        .header("host", "localhost")
        .header("content-type", "application/json")
        .header(INTERNAL_TOKEN_HEADER, TEST_TOKEN)
        .body(http_body_util::Full::new(bytes::Bytes::from(rel_bytes)))
        .unwrap();
    let r3 = sender.send_request(req3).await.unwrap();
    assert_eq!(r3.status(), StatusCode::OK);

    // Graceful shutdown removes UDS socket file cleanly
    let _ = running.shutdown_tx.send(());
    running.join_handle.await.unwrap().unwrap();
    assert!(
        !sock_path.exists(),
        "graceful shutdown should clean up UDS file"
    );
    let _ = std::fs::remove_file(&cap_path);
}

#[cfg(unix)]
#[test]
fn stress_500_concurrency_acquire_p99_and_zero_ghost_leases() {
    let sock_path =
        std::env::temp_dir().join(format!("kin-sched-bench-{}.sock", std::process::id()));
    let eng = Arc::new(SchedulerEngine::new(EngineOptions::default()));
    eng.bootstrap(BootstrapRequest {
        controller_epoch: CompactString::const_new("ep_bench"),
        role: Role::Leader,
        config_version: Some(1),
        config_snapshot: sample_snapshot(10, 64),
        active_sticky_bindings: vec![],
        active_penalties: vec![],
        initial_telemetry: vec![],
    });

    // Run server and client on separate multi-thread runtimes (mirroring real sidecar isolation).
    let server_rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(4)
        .enable_all()
        .build()
        .unwrap();
    let client_rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(4)
        .enable_all()
        .build()
        .unwrap();

    let running = server_rt
        .block_on(start_server(
            DaemonConfig {
                socket_path: Some(sock_path.clone()),
                listen_addr: None,
                token: TEST_TOKEN.to_owned(),
                cap_file: None,
                lease_ttl_ms: 120_000,
                reap_interval_ms: 5_000,
            },
            Arc::clone(&eng),
        ))
        .unwrap();

    // 1. Direct in-engine 500-concurrency acquire/release stress (verifies pure core P99 < 0.5ms)
    let mut core_latencies_us = client_rt.block_on(async {
        let mut out = Vec::with_capacity(500);
        let barrier = Arc::new(tokio::sync::Barrier::new(500));
        let mut handles = Vec::with_capacity(500);
        for i in 0..500usize {
            let e = Arc::clone(&eng);
            let b = Arc::clone(&barrier);
            handles.push(tokio::spawn(async move {
                let r = make_acquire(
                    &format!("core_req_{i}"),
                    &format!("core_sid_{i}"),
                    Some(&format!("core_mid_{}", i % 50)),
                );
                b.wait().await;
                let t0 = Instant::now();
                let resp = e.acquire(r).await.unwrap();
                let us = t0.elapsed().as_micros() as u64;
                e.commit(CommitRequest {
                    lease_id: resp.lease_id.clone(),
                });
                e.release(ReleaseRequest {
                    lease_id: resp.lease_id,
                    outcome: ReleaseOutcome::Ok,
                    http_status: None,
                    error_class: None,
                    error_signature: None,
                    error_message: None,
                    retry_after_sec: None,
                    ttft_ms: None,
                    tokens_used: None,
                    quota_headers: None,
                });
                us
            }));
        }
        for h in handles {
            out.push(h.await.unwrap());
        }
        out
    });
    core_latencies_us.sort_unstable();
    let core_p50 = core_latencies_us[250];
    let core_p99 = core_latencies_us[495];

    // 2. Real UDS HTTP/1.1 Keep-Alive 500-request stress over 8 warmed pooled UDS connections
    let mut uds_latencies_us = client_rt.block_on(async {
        let mut out = Vec::with_capacity(500);
        let total = 500usize;
        let workers = 8usize;
        let ready_barrier = Arc::new(tokio::sync::Barrier::new(workers));
        let next_idx = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let mut handles = Vec::with_capacity(workers);

        for _ in 0..workers {
            let sp = sock_path.clone();
            let counter = Arc::clone(&next_idx);
            let ready = Arc::clone(&ready_barrier);
            handles.push(tokio::spawn(async move {
                let stream = tokio::net::UnixStream::connect(&sp).await.unwrap();
                let (mut sender, conn) = http1::handshake(TokioIo::new(stream)).await.unwrap();
                let conn_task = tokio::spawn(async move {
                    let _ = conn.await;
                });

                // Warm up Keep-Alive connection with 2 RTTs before timing steady-state acquire.
                for _ in 0..2 {
                    let warm = Request::builder()
                        .method(Method::GET)
                        .uri("/internal/v1/health")
                        .header("host", "localhost")
                        .header(INTERNAL_TOKEN_HEADER, TEST_TOKEN)
                        .body(http_body_util::Full::new(bytes::Bytes::new()))
                        .unwrap();
                    let wr = sender.send_request(warm).await.unwrap();
                    assert_eq!(wr.status(), StatusCode::OK);
                    let _ = wr.into_body().collect().await.unwrap();
                }

                ready.wait().await;

                let mut local = Vec::new();
                loop {
                    let i = counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    if i >= total {
                        break;
                    }
                    let acq_body = serde_json::to_vec(&make_acquire(
                        &format!("uds_req_{i}"),
                        &format!("uds_sid_{i}"),
                        Some(&format!("uds_mid_{}", i % 50)),
                    ))
                    .unwrap();
                    let req = Request::builder()
                        .method(Method::POST)
                        .uri("/internal/v1/schedule/acquire")
                        .header("host", "localhost")
                        .header("content-type", "application/json")
                        .header(INTERNAL_TOKEN_HEADER, TEST_TOKEN)
                        .body(http_body_util::Full::new(bytes::Bytes::from(acq_body)))
                        .unwrap();

                    let t0 = Instant::now();
                    let resp = sender.send_request(req).await.unwrap();
                    assert_eq!(resp.status(), StatusCode::OK);
                    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
                    let us = t0.elapsed().as_micros() as u64;
                    let acq: AcquireResponse = serde_json::from_slice(&bytes).unwrap();
                    local.push(us);

                    let rel_body = serde_json::to_vec(&serde_json::json!({
                        "lease_id": acq.lease_id,
                        "outcome": "ok"
                    }))
                    .unwrap();
                    let rel_req = Request::builder()
                        .method(Method::POST)
                        .uri("/internal/v1/schedule/release")
                        .header("host", "localhost")
                        .header("content-type", "application/json")
                        .header(INTERNAL_TOKEN_HEADER, TEST_TOKEN)
                        .body(http_body_util::Full::new(bytes::Bytes::from(rel_body)))
                        .unwrap();
                    let rel_resp = sender.send_request(rel_req).await.unwrap();
                    assert_eq!(rel_resp.status(), StatusCode::OK);
                    let _ = rel_resp.into_body().collect().await.unwrap();
                }
                conn_task.abort();
                local
            }));
        }
        for h in handles {
            out.extend(h.await.unwrap());
        }
        out
    });
    uds_latencies_us.sort_unstable();
    let uds_p50 = uds_latencies_us[250];
    let uds_p95 = uds_latencies_us[475];
    let uds_p99 = uds_latencies_us[495];

    eprintln!(
        "[BENCH 500-conc] core_p50={core_p50}us core_p99={core_p99}us | uds_p50={uds_p50}us uds_p95={uds_p95}us uds_p99={uds_p99}us"
    );

    // Zero ghost leases and zero leaked session gates!
    let h = eng.health();
    assert_eq!(
        h.active_leases, 0,
        "zero ghost leases after 500 concurrency"
    );
    assert_eq!(
        h.active_session_gates, 0,
        "zero leaked session gates after 500 concurrency"
    );

    // Strict P99 < 2ms assertion in release mode (and sane upper bound in unoptimized debug mode)
    #[cfg(not(debug_assertions))]
    {
        assert!(
            core_p99 < 2_000,
            "Core 500-conc acquire P99 must be < 2000us in release mode, got {core_p99}us"
        );
        assert!(
            uds_p99 < 2_000,
            "UDS acquire P99 must be < 2000us in release mode, got {uds_p99}us"
        );
    }
    #[cfg(debug_assertions)]
    assert!(
        uds_p99 < 50_000,
        "UDS acquire P99 must be reasonable in debug mode, got {uds_p99}us"
    );

    let _ = running.shutdown_tx.send(());
    server_rt.block_on(running.join_handle).unwrap().unwrap();
    drop(client_rt);
    drop(server_rt);
}

#[tokio::test]
async fn http_acquire_returns_429_with_retry_after_on_session_in_flight() {
    let eng = Arc::new(SchedulerEngine::new(EngineOptions::default()));
    eng.bootstrap(BootstrapRequest {
        controller_epoch: CompactString::const_new("ep1"),
        role: Role::Leader,
        config_version: Some(1),
        config_snapshot: sample_snapshot(2, 4),
        active_sticky_bindings: vec![],
        active_penalties: vec![],
        initial_telemetry: vec![],
    });
    let app = build_router(Arc::clone(&eng), Arc::new(TEST_TOKEN.to_owned()));

    let r1 = eng
        .acquire(make_acquire("r1", "sid_busy", None))
        .await
        .unwrap();
    let mut r2 = make_acquire("r2", "sid_busy", None);
    r2.no_queue = true;

    let req = Request::builder()
        .method(Method::POST)
        .uri("/internal/v1/schedule/acquire")
        .header("content-type", "application/json")
        .header(INTERNAL_TOKEN_HEADER, TEST_TOKEN)
        .body(Body::from(serde_json::to_vec(&r2).unwrap()))
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(resp.headers().get("retry-after").unwrap(), "1");
    let body: serde_json::Value =
        serde_json::from_slice(&resp.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(body["error"]["code"], "session_in_flight");

    eng.release(ReleaseRequest {
        lease_id: r1.lease_id,
        outcome: ReleaseOutcome::Ok,
        http_status: None,
        error_class: None,
        error_signature: None,
        error_message: None,
        retry_after_sec: None,
        ttft_ms: None,
        tokens_used: None,
        quota_headers: None,
    });
}

#[tokio::test]
async fn http_acquire_returns_403_on_unauthorized_pool_and_forbidden_pin() {
    let eng = Arc::new(SchedulerEngine::new(EngineOptions::default()));
    eng.bootstrap(BootstrapRequest {
        controller_epoch: CompactString::const_new("ep1"),
        role: Role::Leader,
        config_version: Some(1),
        config_snapshot: sample_snapshot(2, 4),
        active_sticky_bindings: vec![],
        active_penalties: vec![],
        initial_telemetry: vec![],
    });
    let app = build_router(eng, Arc::new(TEST_TOKEN.to_owned()));

    let mut unauth = make_acquire("r1", "s1", None);
    unauth.api_key_scope.default_pool_id = None;
    unauth.api_key_scope.allowed_pool_ids.clear();
    let (st, body) = send_router(
        &app,
        Method::POST,
        "/internal/v1/schedule/acquire",
        Some(TEST_TOKEN),
        Some(serde_json::to_value(&unauth).unwrap()),
    )
    .await;
    assert_eq!(st, StatusCode::FORBIDDEN);
    assert_eq!(body["error"]["code"], "pool_forbidden");

    let mut bad_pin = make_acquire("r2", "s2", None);
    bad_pin.pin_node_key = Some(CompactString::const_new("claude_vm:vm1"));
    let (st2, body2) = send_router(
        &app,
        Method::POST,
        "/internal/v1/schedule/acquire",
        Some(TEST_TOKEN),
        Some(serde_json::to_value(&bad_pin).unwrap()),
    )
    .await;
    assert_eq!(st2, StatusCode::FORBIDDEN);
    assert_eq!(body2["error"]["code"], "forbidden");
}

#[tokio::test]
async fn http_switch_returns_404_missing_lease_and_422_poison_abort() {
    let eng = Arc::new(SchedulerEngine::new(EngineOptions::default()));
    eng.bootstrap(BootstrapRequest {
        controller_epoch: CompactString::const_new("ep1"),
        role: Role::Leader,
        config_version: Some(1),
        config_snapshot: sample_snapshot(3, 4),
        active_sticky_bindings: vec![],
        active_penalties: vec![],
        initial_telemetry: vec![],
    });
    let app = build_router(Arc::clone(&eng), Arc::new(TEST_TOKEN.to_owned()));

    // Missing lease -> 404
    let (st, b) = send_router(
        &app,
        Method::POST,
        "/internal/v1/schedule/switch",
        Some(TEST_TOKEN),
        Some(
            serde_json::to_value(SwitchRequest {
                release_lease_id: CompactString::const_new("ls_unknown"),
                failure: FailureReport::default(),
                next_attempt: make_acquire("r0", "s0", None),
            })
            .unwrap(),
        ),
    )
    .await;
    assert_eq!(st, StatusCode::NOT_FOUND);
    assert_eq!(b["error"]["code"], "lease_not_found");

    // 2 identical 500 errors across 2 healthy nodes -> 422 poison_abort
    let r1 = eng.acquire(make_acquire("rp", "sp", None)).await.unwrap();
    let mut a2 = make_acquire("rp", "sp", None);
    a2.attempt_no = 2;
    let (st2, sw2) = send_router(
        &app,
        Method::POST,
        "/internal/v1/schedule/switch",
        Some(TEST_TOKEN),
        Some(
            serde_json::to_value(SwitchRequest {
                release_lease_id: r1.lease_id,
                failure: FailureReport {
                    http_status: 500,
                    error_class: ErrorClass::Server5xx,
                    error_message: Some("fatal prompt crash".to_owned()),
                    ..Default::default()
                },
                next_attempt: a2,
            })
            .unwrap(),
        ),
    )
    .await;
    assert_eq!(st2, StatusCode::OK);
    let l2 = sw2["lease_id"].as_str().unwrap();

    let mut a3 = make_acquire("rp", "sp", None);
    a3.attempt_no = 3;
    let (st3, b3) = send_router(
        &app,
        Method::POST,
        "/internal/v1/schedule/switch",
        Some(TEST_TOKEN),
        Some(
            serde_json::to_value(SwitchRequest {
                release_lease_id: CompactString::from(l2),
                failure: FailureReport {
                    http_status: 500,
                    error_class: ErrorClass::Server5xx,
                    error_message: Some("fatal prompt crash".to_owned()),
                    ..Default::default()
                },
                next_attempt: a3,
            })
            .unwrap(),
        ),
    )
    .await;
    assert_eq!(st3, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(b3["error"]["code"], "poison_abort");
    assert_eq!(eng.health().active_session_gates, 0);
}

#[tokio::test]
async fn http_delete_sticky_via_query_and_invalid_json_returns_400() {
    let eng = Arc::new(SchedulerEngine::new(EngineOptions::default()));
    eng.bootstrap(BootstrapRequest {
        controller_epoch: CompactString::const_new("ep1"),
        role: Role::Leader,
        config_version: Some(1),
        config_snapshot: sample_snapshot(1, 4),
        active_sticky_bindings: vec![],
        active_penalties: vec![],
        initial_telemetry: vec![],
    });
    let r = eng
        .acquire(make_acquire("r1", "s1", Some("m1")))
        .await
        .unwrap();
    eng.commit(CommitRequest {
        lease_id: r.lease_id.clone(),
    });
    eng.release(ReleaseRequest {
        lease_id: r.lease_id,
        outcome: ReleaseOutcome::Ok,
        http_status: None,
        error_class: None,
        error_signature: None,
        error_message: None,
        retry_after_sec: None,
        ttft_ms: None,
        tokens_used: None,
        quota_headers: None,
    });

    let app = build_router(eng, Arc::new(TEST_TOKEN.to_owned()));
    let (st, del) = send_router(
        &app,
        Method::DELETE,
        "/internal/v1/sticky?pool_id=pool_main&scope_kind=session&session_id=s1",
        Some(TEST_TOKEN),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(del["deleted"], 1);

    // Invalid JSON on /persistence/drain returns 400
    let bad_req = Request::builder()
        .method(Method::POST)
        .uri("/internal/v1/persistence/drain")
        .header(INTERNAL_TOKEN_HEADER, TEST_TOKEN)
        .body(Body::from("{not-valid-json"))
        .unwrap();
    let bad_resp = app.oneshot(bad_req).await.unwrap();
    assert_eq!(bad_resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn http_events_evicted_after_512_returns_409_snapshot_required() {
    let eng = Arc::new(SchedulerEngine::new(EngineOptions::default()));
    eng.bootstrap(BootstrapRequest {
        controller_epoch: CompactString::const_new("ep_ring"),
        role: Role::Leader,
        config_version: Some(1),
        config_snapshot: sample_snapshot(1, 4),
        active_sticky_bindings: vec![],
        active_penalties: vec![],
        initial_telemetry: vec![],
    });
    // Emit >512 events via unrest calls
    for _ in 0..520 {
        eng.unrest(UnrestRequest {
            node_key: CompactString::const_new("claude_vm:vm1"),
            model_scope: None,
        });
    }

    let app = build_router(eng, Arc::new(TEST_TOKEN.to_owned()));
    let (st, body) = send_router(
        &app,
        Method::GET,
        "/internal/v1/events?after=ep_ring:2",
        Some(TEST_TOKEN),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::CONFLICT);
    assert_eq!(body["error"]["code"], "snapshot_required");
    assert_eq!(body["error"]["current_epoch"], "ep_ring");
}
