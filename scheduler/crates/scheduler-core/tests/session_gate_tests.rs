use compact_str::CompactString;
use parking_lot::Mutex;
use scheduler_core::{EngineOptions, SchedulerEngine, SessionGateTable};
use scheduler_proto::*;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

fn build_two_node_engine() -> Arc<SchedulerEngine> {
    let engine = Arc::new(SchedulerEngine::new(EngineOptions::default()));
    let make_node = |id: &str, tier: u16| BackendNodeConfig {
        node_key: CompactString::from(format!("claude_vm:{id}")),
        node_type: NodeType::ClaudeVm,
        node_id: CompactString::from(id),
        provider: Provider::Anthropic,
        protocol: None,
        owner_id: None,
        plan_tier: Some(CompactString::const_new("max_20x")),
        weight_tier_mode: WeightTierMode::Manual,
        weight_tier: tier,
        auto_weight_tier: None,
        sub_weight: 10,
        supported_models: vec![],
        capacity: NodeCapacityConfig {
            max_concurrency: 16,
            max_sessions: 16,
            ..Default::default()
        },
        enabled: true,
        temp_unschedulable_until_ms: None,
        temp_unschedulable_reason: None,
    };

    let pool = PoolConfig {
        id: CompactString::const_new("pool_1"),
        slug: CompactString::const_new("pool-1"),
        name: CompactString::const_new("Pool 1"),
        provider_scope: ProviderScope::Anthropic,
        session_queue_max: 64,
        session_queue_timeout_ms: 5_000,
        members: vec![
            PoolMemberConfig {
                node_key: CompactString::const_new("claude_vm:vm1"),
                node_type: NodeType::ClaudeVm,
                node_id: CompactString::const_new("vm1"),
                enabled: true,
                member_role: MemberRole::Active,
                weight_tier_override: None,
                sub_weight_override: None,
                member_order: 1,
            },
            PoolMemberConfig {
                node_key: CompactString::const_new("claude_vm:vm2"),
                node_type: NodeType::ClaudeVm,
                node_id: CompactString::const_new("vm2"),
                enabled: true,
                member_role: MemberRole::Active,
                weight_tier_override: None,
                sub_weight_override: None,
                member_order: 2,
            },
        ],
        ..Default::default()
    };

    engine.bootstrap(BootstrapRequest {
        controller_epoch: CompactString::const_new("ep1"),
        role: Role::Leader,
        config_version: Some(1),
        config_snapshot: ConfigSnapshot {
            config_version: 1,
            pools: vec![pool],
            nodes: vec![make_node("vm1", 8), make_node("vm2", 8)],
            ..Default::default()
        },
        active_sticky_bindings: vec![],
        active_penalties: vec![],
        initial_telemetry: vec![],
    });
    engine
}

fn make_req(req_id: &str, pool_id: &str, family: ModelFamily, sid: &str) -> AcquireRequest {
    AcquireRequest {
        request_id: CompactString::from(req_id),
        attempt_no: 1,
        controller_epoch: CompactString::const_new("ep1"),
        min_config_version: 1,
        origin_pool_id: CompactString::from(pool_id),
        jev_downgrade_pool_id: None,
        api_key_scope: ApiKeyScope {
            api_key_id: CompactString::const_new("key_1"),
            pool_binding_mode: PoolBindingMode::StrictPool,
            default_pool_id: Some(CompactString::from(pool_id)),
            allowed_pool_ids: vec![CompactString::from(pool_id)],
            ..Default::default()
        },
        model: CompactString::const_new("claude-sonnet-4"),
        model_family: family,
        protocol: CompactString::const_new("anthropic"),
        machine_id: None,
        session_id: CompactString::from(sid),
        session_id_source: None,
        parent_session_id: None,
        is_ephemeral_probe: false,
        no_queue: false,
        is_admin_diagnostic: false,
        pin_node_key: None,
        exclude_nodes: vec![],
    }
}

#[tokio::test]
async fn fifty_concurrent_same_session_strict_fifo_and_peak_concurrency_one() {
    let table = Arc::new(SessionGateTable::new());
    let key = ScopedSessionKey::new("pool_1", ModelFamily::Claude, "sess-50-fifo");

    // Hold initial gate so all 50 followers enqueue in deterministic order!
    let initial = table.acquire(&key, false, 64, 5_000).await.unwrap();
    let in_flight = Arc::new(AtomicUsize::new(0));
    let peak = Arc::new(AtomicUsize::new(0));
    let order = Arc::new(Mutex::new(Vec::<usize>::with_capacity(50)));

    let mut handles = Vec::with_capacity(50);
    for idx in 0..50usize {
        let t = Arc::clone(&table);
        let k = key.clone();
        let inf = Arc::clone(&in_flight);
        let pk = Arc::clone(&peak);
        let ord = Arc::clone(&order);
        let enqueued = Arc::new(tokio::sync::Notify::new());
        let enq_clone = Arc::clone(&enqueued);

        handles.push(tokio::spawn(async move {
            let fut = t.acquire(&k, false, 64, 5_000);
            tokio::pin!(fut);
            // Poll once until queued? Better: wait for peek depth in outer loop!
            enq_clone.notify_one();
            let guard = fut.await.expect("must acquire in FIFO order");
            let cur = inf.fetch_add(1, Ordering::SeqCst) + 1;
            pk.fetch_max(cur, Ordering::SeqCst);
            ord.lock().push(idx);
            tokio::task::yield_now().await;
            inf.fetch_sub(1, Ordering::SeqCst);
            drop(guard);
        }));

        // Wait until this exact waiter is queued before spawning the next so enqueue order is 0..50.
        enqueued.notified().await;
        while table.peek(&key).1 < idx + 1 {
            tokio::task::yield_now().await;
        }
    }

    assert_eq!(table.peek(&key), (true, 50));
    drop(initial);

    for h in handles {
        h.await.unwrap();
    }

    assert_eq!(peak.load(Ordering::SeqCst), 1, "peak concurrency MUST be 1");
    assert_eq!(
        *order.lock(),
        (0..50).collect::<Vec<_>>(),
        "FIFO order MUST be strictly preserved"
    );
    assert_eq!(
        table.active_count(),
        0,
        "empty gate must be removed atomically"
    );
}

#[tokio::test]
async fn fifty_concurrent_same_session_through_full_engine_peak_concurrency_one() {
    let engine = build_two_node_engine();
    let active = Arc::new(AtomicUsize::new(0));
    let peak = Arc::new(AtomicUsize::new(0));
    let mut handles = Vec::with_capacity(50);

    for i in 0..50usize {
        let eng = Arc::clone(&engine);
        let act = Arc::clone(&active);
        let pk = Arc::clone(&peak);
        handles.push(tokio::spawn(async move {
            let req = make_req(
                &format!("req_{i}"),
                "pool_1",
                ModelFamily::Claude,
                "550e8400-e29b-41d4-a716-446655440000",
            );
            let resp = eng.acquire(req).await.expect("acquire must succeed");
            let cur = act.fetch_add(1, Ordering::SeqCst) + 1;
            pk.fetch_max(cur, Ordering::SeqCst);
            eng.commit(CommitRequest {
                lease_id: resp.lease_id.clone(),
            });
            tokio::task::yield_now().await;
            act.fetch_sub(1, Ordering::SeqCst);
            eng.release(ReleaseRequest {
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
        }));
    }

    for h in handles {
        h.await.unwrap();
    }

    assert_eq!(peak.load(Ordering::SeqCst), 1);
    assert_eq!(engine.health().active_leases, 0);
    assert_eq!(engine.health().active_session_gates, 0);
}

#[tokio::test]
async fn high_frequency_acquire_release_empty_remove_aba_regression() {
    let table = Arc::new(SessionGateTable::new());
    let key = ScopedSessionKey::new("pool_1", ModelFamily::Claude, "sess-aba");
    let active = Arc::new(AtomicUsize::new(0));
    let peak = Arc::new(AtomicUsize::new(0));

    let mut handles = Vec::new();
    for _ in 0..8 {
        let t = Arc::clone(&table);
        let k = key.clone();
        let act = Arc::clone(&active);
        let pk = Arc::clone(&peak);
        handles.push(tokio::spawn(async move {
            for _ in 0..250 {
                let g = t.acquire(&k, false, 32, 5_000).await.unwrap();
                let cur = act.fetch_add(1, Ordering::SeqCst) + 1;
                pk.fetch_max(cur, Ordering::SeqCst);
                assert_eq!(cur, 1, "ABA violation detected: concurrent gate holders!");
                act.fetch_sub(1, Ordering::SeqCst);
                drop(g);
            }
        }));
    }

    for h in handles {
        h.await.unwrap();
    }

    assert_eq!(peak.load(Ordering::SeqCst), 1);
    assert_eq!(table.active_count(), 0);
}

#[tokio::test]
async fn no_queue_returns_session_in_flight_immediately() {
    let table = Arc::new(SessionGateTable::new());
    let key = ScopedSessionKey::new("pool_1", ModelFamily::Claude, "sess-nq");
    let _g1 = table.acquire(&key, false, 16, 5_000).await.unwrap();

    let err = table.acquire(&key, true, 16, 5_000).await.err().unwrap();
    assert_eq!(err.code(), ErrorCode::SessionInFlight);
    assert_eq!(err.http_status_code(), 429);
    assert_eq!(table.metrics.reject_in_flight.load(Ordering::Relaxed), 1);
}

#[tokio::test]
async fn queue_max_returns_session_queue_full() {
    let table = Arc::new(SessionGateTable::new());
    let key = ScopedSessionKey::new("pool_1", ModelFamily::Claude, "sess-qmax");
    let g1 = table.acquire(&key, false, 2, 5_000).await.unwrap();

    let t2 = Arc::clone(&table);
    let k2 = key.clone();
    let h2 = tokio::spawn(async move { t2.acquire(&k2, false, 2, 5_000).await });
    while table.peek(&key).1 < 1 {
        tokio::task::yield_now().await;
    }

    let t3 = Arc::clone(&table);
    let k3 = key.clone();
    let h3 = tokio::spawn(async move { t3.acquire(&k3, false, 2, 5_000).await });
    while table.peek(&key).1 < 2 {
        tokio::task::yield_now().await;
    }

    let err = table.acquire(&key, false, 2, 5_000).await.err().unwrap();
    assert_eq!(err.code(), ErrorCode::SessionQueueFull);
    assert_eq!(err.http_status_code(), 429);

    drop(g1);
    drop(h2.await.unwrap().unwrap());
    drop(h3.await.unwrap().unwrap());
    assert_eq!(table.active_count(), 0);
}

#[tokio::test]
async fn queue_timeout_returns_429_and_does_not_block_next_waiter() {
    let table = Arc::new(SessionGateTable::new());
    let key = ScopedSessionKey::new("pool_1", ModelFamily::Claude, "sess-timeout");
    let g1 = table.acquire(&key, false, 16, 5_000).await.unwrap();

    let t2 = Arc::clone(&table);
    let k2 = key.clone();
    let h2 = tokio::spawn(async move { t2.acquire(&k2, false, 16, 40).await });
    while table.peek(&key).1 < 1 {
        tokio::task::yield_now().await;
    }

    let t3 = Arc::clone(&table);
    let k3 = key.clone();
    let h3 = tokio::spawn(async move { t3.acquire(&k3, false, 16, 2_000).await });
    while table.peek(&key).1 < 2 {
        tokio::task::yield_now().await;
    }

    let r2 = h2.await.unwrap();
    assert_eq!(r2.err().unwrap().code(), ErrorCode::SessionQueueTimeout);
    assert_eq!(table.peek(&key), (true, 1));

    drop(g1);
    let g3 = h3.await.unwrap().expect("R3 must wake after R2 timed out");
    drop(g3);
    assert_eq!(table.active_count(), 0);
}

#[tokio::test]
async fn mid_queue_abort_removes_waiters_and_never_deadlocks() {
    let table = Arc::new(SessionGateTable::new());
    let key = ScopedSessionKey::new("pool_1", ModelFamily::Claude, "sess-abort");
    let g1 = table.acquire(&key, false, 16, 5_000).await.unwrap();

    let t2 = Arc::clone(&table);
    let k2 = key.clone();
    let h2 = tokio::spawn(async move { t2.acquire(&k2, false, 16, 5_000).await });
    while table.peek(&key).1 < 1 {
        tokio::task::yield_now().await;
    }

    let t3 = Arc::clone(&table);
    let k3 = key.clone();
    let h3 = tokio::spawn(async move { t3.acquire(&k3, false, 16, 5_000).await });
    while table.peek(&key).1 < 2 {
        tokio::task::yield_now().await;
    }

    let t4 = Arc::clone(&table);
    let k4 = key.clone();
    let h4 = tokio::spawn(async move { t4.acquire(&k4, false, 16, 5_000).await });
    while table.peek(&key).1 < 3 {
        tokio::task::yield_now().await;
    }

    // Abort R2 and R3 while waiting in FIFO queue!
    h2.abort();
    h3.abort();
    let _ = h2.await;
    let _ = h3.await;

    assert_eq!(table.peek(&key), (true, 1));
    drop(g1);

    let g4 = tokio::time::timeout(Duration::from_secs(2), h4)
        .await
        .expect("R4 must not deadlock")
        .unwrap()
        .unwrap();
    drop(g4);
    assert_eq!(table.active_count(), 0);
}

#[tokio::test]
async fn handoff_vs_drop_race_stress_relays_token_zero_lost_wakeups() {
    let table = Arc::new(SessionGateTable::new());
    let key = ScopedSessionKey::new("pool_1", ModelFamily::Claude, "sess-race");

    for _ in 0..120 {
        let g1 = table.acquire(&key, false, 16, 2_000).await.unwrap();

        let t2 = Arc::clone(&table);
        let k2 = key.clone();
        let h2 = tokio::spawn(async move { t2.acquire(&k2, false, 16, 2_000).await });
        while table.peek(&key).1 < 1 {
            tokio::task::yield_now().await;
        }

        let t3 = Arc::clone(&table);
        let k3 = key.clone();
        let h3 = tokio::spawn(async move { t3.acquire(&k3, false, 16, 2_000).await });
        while table.peek(&key).1 < 2 {
            tokio::task::yield_now().await;
        }

        // Simultaneously drop R1 (triggering handoff to R2) AND abort R2 (triggering SessionWaitGuard::drop)!
        h2.abort();
        drop(g1);

        let _ = h2.await;
        let g3 = tokio::time::timeout(Duration::from_secs(2), h3)
            .await
            .expect("R3 MUST NEVER lose wakeup in handoff-vs-drop race")
            .unwrap()
            .unwrap();
        drop(g3);
    }

    assert_eq!(table.active_count(), 0);
}

#[tokio::test]
async fn wrong_token_cannot_release_active_holder() {
    let table = Arc::new(SessionGateTable::new());
    let key = ScopedSessionKey::new("pool_1", ModelFamily::Claude, "sess-tok");
    let g1 = table.acquire(&key, false, 16, 5_000).await.unwrap();
    let bogus = scheduler_core::GateToken(g1.token().0 + 999);
    table.release(&key, bogus);
    assert_eq!(table.peek(&key), (true, 0));
    drop(g1);
    assert_eq!(table.active_count(), 0);
}

#[tokio::test]
async fn switch_keeps_session_gate_locked_until_final_release() {
    let engine = build_two_node_engine();
    let sid = "550e8400-e29b-41d4-a716-446655440011";

    // R1 acquires lease #1
    let r1 = engine
        .acquire(make_req("req_r1", "pool_1", ModelFamily::Claude, sid))
        .await
        .unwrap();

    // R2 arrives concurrently and MUST queue on SessionGate
    let eng2 = Arc::clone(&engine);
    let r2_started = Arc::new(AtomicUsize::new(0));
    let r2_started_c = Arc::clone(&r2_started);
    let h2 = tokio::spawn(async move {
        let resp = eng2
            .acquire(make_req("req_r2", "pool_1", ModelFamily::Claude, sid))
            .await
            .unwrap();
        r2_started_c.store(1, Ordering::SeqCst);
        resp
    });

    let gk = ScopedSessionKey::new("pool_1", ModelFamily::Claude, sid);
    while engine.session_gates.peek(&gk).1 < 1 {
        tokio::task::yield_now().await;
    }

    // R1 hits 529 and executes atomic /schedule/switch -> moves to other VM!
    let mut next_req = make_req("req_r1", "pool_1", ModelFamily::Claude, sid);
    next_req.attempt_no = 2;
    let r1_switched = engine
        .switch(SwitchRequest {
            release_lease_id: r1.lease_id.clone(),
            failure: FailureReport {
                http_status: 529,
                error_class: ErrorClass::Overloaded529,
                ..Default::default()
            },
            next_attempt: next_req,
        })
        .await
        .unwrap();

    assert_ne!(
        r1_switched.selected_node.node_key,
        r1.selected_node.node_key
    );

    // Give runtime time: R2 MUST STILL BE BLOCKED because R1 inherited immutable SessionGate!
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert_eq!(
        r2_started.load(Ordering::SeqCst),
        0,
        "R2 MUST NOT run while R1 holds switched lease!"
    );
    assert_eq!(engine.session_gates.peek(&gk), (true, 1));

    // Release R1's switched lease -> R2 immediately unblocks!
    engine.release(ReleaseRequest {
        lease_id: r1_switched.lease_id,
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

    let r2 = tokio::time::timeout(Duration::from_secs(2), h2)
        .await
        .expect("R2 must wake after R1 final release")
        .unwrap();
    assert_eq!(r2_started.load(Ordering::SeqCst), 1);

    engine.release(ReleaseRequest {
        lease_id: r2.lease_id,
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
    assert_eq!(engine.health().active_session_gates, 0);
}

#[tokio::test]
async fn switch_failure_exhausted_releases_session_gate_and_wakes_r2() {
    let engine = build_two_node_engine();
    let sid = "550e8400-e29b-41d4-a716-446655440022";

    let r1 = engine
        .acquire(make_req("req_r1", "pool_1", ModelFamily::Claude, sid))
        .await
        .unwrap();

    let eng2 = Arc::clone(&engine);
    let h2 = tokio::spawn(async move {
        eng2.acquire(make_req("req_r2", "pool_1", ModelFamily::Claude, sid))
            .await
    });

    let gk = ScopedSessionKey::new("pool_1", ModelFamily::Claude, sid);
    while engine.session_gates.peek(&gk).1 < 1 {
        tokio::task::yield_now().await;
    }

    // Force switch to exhaust all nodes by excluding both vm1 & vm2!
    let mut next_req = make_req("req_r1", "pool_1", ModelFamily::Claude, sid);
    next_req.attempt_no = 2;
    next_req.exclude_nodes = vec![
        CompactString::const_new("claude_vm:vm1"),
        CompactString::const_new("claude_vm:vm2"),
    ];
    let sw_err = engine
        .switch(SwitchRequest {
            release_lease_id: r1.lease_id,
            failure: FailureReport {
                http_status: 400,
                error_class: ErrorClass::Client4xx,
                ..Default::default()
            },
            next_attempt: next_req,
        })
        .await
        .err()
        .unwrap();
    assert_eq!(sw_err.code(), ErrorCode::PoolExhausted);

    // R2 must immediately wake up and succeed!
    let r2 = tokio::time::timeout(Duration::from_secs(2), h2)
        .await
        .expect("R2 must wake when switch fails")
        .unwrap()
        .unwrap();
    engine.release(ReleaseRequest {
        lease_id: r2.lease_id,
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
    assert_eq!(engine.health().active_session_gates, 0);
}

#[tokio::test]
async fn gate_isolates_different_pools_and_model_families() {
    let table = Arc::new(SessionGateTable::new());
    let k1 = ScopedSessionKey::new("pool_1", ModelFamily::Claude, "same-sid");
    let k2 = ScopedSessionKey::new("pool_2", ModelFamily::Claude, "same-sid");
    let k3 = ScopedSessionKey::new("pool_1", ModelFamily::Gemini, "same-sid");

    let g1 = table.acquire(&k1, true, 16, 1_000).await.unwrap();
    let g2 = table.acquire(&k2, true, 16, 1_000).await.unwrap();
    let g3 = table.acquire(&k3, true, 16, 1_000).await.unwrap();
    assert_eq!(table.active_count(), 3);
    drop(g1);
    drop(g2);
    drop(g3);
    assert_eq!(table.active_count(), 0);
}

#[tokio::test]
async fn ephemeral_probe_bypasses_session_gate() {
    let engine = build_two_node_engine();
    let sid = "550e8400-e29b-41d4-a716-446655440033";

    let r1 = engine
        .acquire(make_req("req_r1", "pool_1", ModelFamily::Claude, sid))
        .await
        .unwrap();

    let mut probe_req = make_req("req_probe", "pool_1", ModelFamily::Claude, sid);
    probe_req.is_ephemeral_probe = true;
    probe_req.no_queue = true;

    // Must NOT fail with 429 session_in_flight, and must NOT increment active_sessions!
    let p_resp = engine.acquire(probe_req).await.unwrap();
    let total_active_sessions =
        engine.node_active_sessions("claude_vm:vm1") + engine.node_active_sessions("claude_vm:vm2");
    assert_eq!(
        total_active_sessions, 1,
        "only r1 should be counted in active_sessions, not ephemeral probe"
    );

    engine.release(ReleaseRequest {
        lease_id: p_resp.lease_id,
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
    engine.release(ReleaseRequest {
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
    assert_eq!(engine.health().active_session_gates, 0);
}

#[tokio::test]
async fn explain_peeks_session_gate_without_blocking() {
    let engine = build_two_node_engine();
    let sid = "550e8400-e29b-41d4-a716-446655440044";
    let r1 = engine
        .acquire(make_req("req_r1", "pool_1", ModelFamily::Claude, sid))
        .await
        .unwrap();

    let exp = tokio::time::timeout(
        Duration::from_millis(200),
        engine.explain(make_req("req_exp", "pool_1", ModelFamily::Claude, sid)),
    )
    .await
    .expect("explain must NEVER block on SessionGate")
    .unwrap();

    assert!(exp.ok);
    assert!(exp.explain.session_gate.busy_at_peek);
    assert_eq!(exp.explain.session_gate.queue_depth_at_peek, 0);

    engine.release(ReleaseRequest {
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
async fn gate_guard_auto_releases_if_planning_fails() {
    let engine = build_two_node_engine();
    let sid = "550e8400-e29b-41d4-a716-446655440055";
    let mut bad_req = make_req("req_bad", "pool_1", ModelFamily::Claude, sid);
    bad_req.exclude_nodes = vec![
        CompactString::const_new("claude_vm:vm1"),
        CompactString::const_new("claude_vm:vm2"),
    ];
    let err = engine.acquire(bad_req).await.err().unwrap();
    assert_eq!(err.code(), ErrorCode::PoolExhausted);
    assert_eq!(engine.health().active_session_gates, 0);
}

#[tokio::test]
async fn gate_rearm_preserves_original_key_and_token_across_switch() {
    let table = Arc::new(SessionGateTable::new());
    let key = ScopedSessionKey::new("pool_1", ModelFamily::Claude, "sess-rearm");
    let g1 = table.acquire(&key, false, 16, 2_000).await.unwrap();
    let (gk, tok) = g1.disarm_into_parts();
    assert_eq!(table.peek(&key), (true, 0));

    let g2 = table.rearm_guard(gk, tok);
    assert_eq!(g2.token(), tok);
    assert_eq!(table.peek(&key), (true, 0));
    drop(g2);
    assert_eq!(table.active_count(), 0);
}
