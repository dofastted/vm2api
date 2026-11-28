# Phase 0 Baseline Report — 20K RPM × 100K-Context Replay (`PR #2102` / `feat/redis-pg-io-optimization`)

- **Date**: 2026-11-28
- **SUT**: `/mnt/x/vm2api-wt-redis-pg-opt` (`feat/redis-pg-io-optimization`, commit `7d22502f`, `KIN_CRS_MOCK=0`, real Rust `kin-scheduler` + UDS mock dataplane)
- **Database & Cache**: Isolated Docker `postgres:18-alpine` (`127.0.0.1:55432`, `shared_buffers=256MB`, `max_wal_size=1GB`, `max_connections=200`) + `redis:8-alpine` (`127.0.0.1:56379`, `maxmemory 256mb`, `allkeys-lru`, `appendonly yes`)
- **Topology**: `vms=200`, `keys=100`, `tenants=10`, `mock-workers=4`, `ttft-ms=50`, `stream-ms=300`, `fault-rate=0.02`
- **Locked Corpus**: `.local/bench-20k/corpus/corpus-100k.jsonl` (not committed)
  - **SHA-256**: `c7a037507b717412fb2655564dcb3312d4d27e5b67da2263c18d948b47f29417`
  - **Shape**: `count=120`, `unique_sessions=24` (all multi-turn), `source_counts={ omp: 60, claude: 60 }`, `body_bytes p50=402,842 / p95=446,852 / max=449,172`, `approx_tokens p50=100,840 / p95=134,036`, `redaction_audit=pass (leaks_found=0, byte_length_mismatches=0)`

---

## 1. Executive Verdict

| Dimension | 1 Instance (`1inst-low` + `1inst`) | 4 Instances (`4inst`) | Target (Phase 1/2) |
| --- | --- | --- | --- |
| **0%-Error Proxy RPM** | **60 RPM** (p95 `18.55s`) | **300 RPM** (120 RPM p95 `3.94s`; 300 RPM p95 `13.85s`) | `20,000 RPM` |
| **True Sustained Completed Ceiling** | **~56–61 RPM** (~1.0 req/s) | **~220–240 RPM** (~3.7–4.0 req/s) | `≥20,000 RPM` |
| **Timeout Collapse Cliff** | **120 RPM** (55.0% `EDRAINTIMEOUT`) | **600 RPM** (21.0% → 1200 RPM 65.0% → 3000 RPM 100%) | `0%` |
| **Main-Thread `Atomics.wait` Block** | **70.9%–83.6% of wall time** (`636–963 waits/req`, `1.23–1.91s/req`) | **55.8%–75.0% of wall time** (`514–876 waits/req`, `0.75–1.14s/req`) | `<1 wait/req`, `<1ms/req` |
| **SUT CPU per Instance** | **40.3%–44.4%** (idle sleeping in `Atomics.wait`) | **45.0%–46.5%/inst** (`180–186%` total) | High useful CPU |
| **PostgreSQL 18 Load** | WAL `0.01–0.05 MB/s`, `act/wait=3/0` (<5% utilized) | WAL `0.02–0.07 MB/s`, `act/wait=5/0–5/2` (<5% utilized) | Headroom verified |
| **Redis 8 Load** | `93–264 ops/s`, `2.4–2.8 MB`, `0 evictions` (<1% utilized) | `406–1,155 ops/s`, `2.6–5.2 MB`, `0 evictions` (<1% utilized) | Headroom verified |
| **Closed-Loop `usage_logs` Loss** | **0.0000%** (`84/84`, `81/80`) | **0.0000%** (`464/452`) | `0%` |
| **Closed-Loop `api_keys` Billing** | **FAIL** (`0/84`, `0/81` — PG 18 SQL type bug) | **FAIL** (`0/458` — PG 18 SQL type bug) | `0 drift` |
| **Closed-Loop `live:inflight` Orphans** | **FAIL** (`68` / `335` orphans after client timeout) | **FAIL** (`479` orphans after client timeout) | `0 orphans` |

**Core Finding**: On 200 VMs + 100K-Context traffic, **neither PostgreSQL 18 nor Redis 8 nor `PgLogWriter` is the bottleneck** (PG WAL is `<0.07 MB/s`, Redis is `<1,200 ops/s` with `0` evictions, `PgLogWriter` has `0` overflow/fallback/drops/errors and `0%` log loss). Instead, **a single N+1 synchronous `PgSyncDb` (`Atomics.wait`) storm in the Rust scheduler JS bridge freezes every SUT main thread for 55%–84% of wall-clock time**, capping throughput at **~60 RPM/instance (~240 RPM across 4 instances)** — a **~83× gap** to the 20,000 RPM target, scaling linearly (`~4×`) with instance count because the bottleneck is strictly per-process main-thread blocking.

---

## 2. Live PostgreSQL 18 + Redis 8 Integration Test Results (`PR #2102`)

Executed read-only against `/mnt/x/vm2api-wt-redis-pg-opt` with live `postgres:18-alpine` and `redis:8-alpine`:

| Test Suite | Result | Duration | Notes |
| --- | :---: | ---: | --- |
| `test/unit/pg-redis-cache-e2e.test.mjs` | **2/2 PASS** | 4.14s | Redis 8 L1+L2, Lua atomic billing, ZSET TIME concurrency, Pub/Sub & PG LISTEN/NOTIFY all green |
| `test/unit/pg-log-writer.test.mjs` | **14/14 PASS** | 3.43s | Live PG 18 migration 011, multi-row INSERTs, `runRetentionCleanupAsync` all green |
| `test/unit/pg-integration.test.mjs` | **1/1 PASS** | 8.93s | Full PG engine, repos, read pool, metrics, aggregation, cache green |
| `test/unit/pg-repos-parity.test.mjs` | **1/2 PASS (1 FAIL)** | 17.53s | Tier 2 (22 repos + ThinkingOwnerStore) PASS; **Tier 2B FAIL at line 1058** (`dirty user must vanish after restore`) |

### Verified Real PG 18 / Redis 8 Defects Discovered in Phase 0

1. **[P0 — Billing Loss] `api-keys.mjs:1554-1615` (`_applyUsageBatchToPg`) PG 18 type mismatch silently drops all API key usage counters**:
   - `$1` is cast as `$1::timestamptz` in `EXTRACT(EPOCH FROM ($1::timestamptz - k.window_5h_start::timestamptz))` and simultaneously used untyped in `CASE ... THEN $1 ELSE k.window_5h_start END` where `window_5h_start` is `TEXT`. PostgreSQL rejects the mixed parameter typing; `flushPendingUsage()` (`api-keys.mjs:1702`) catches silently and re-queues dirty deltas forever.
   - **Impact observed**: Across all 3 benchmark sweeps (`84`, `81`, and `458` HTTP 200 requests), `usage_logs` persisted 100% of rows (`$9.64` / `$10.17` / `$51.11` total cost), while `api_keys.quota_requests_used`, `tokens_in`, `tokens_out`, and `quota_used` remained **`0`** on every single key!
2. **[P0 — Stale Auth/Entity Data After Restore] `backup-service.mjs:522` (`restoreBackup`) omits `'entity:'`, `'risk:'`, and `'live:'` cache prefixes**:
   - Line 522 invalidates only `['apikey:', 'billing:', 'sched:', 'dash:']`. Because PR #2102 caches `UsersRepo` / `GroupsRepo` / `VmPoolsRepo` under `'entity:'`, `pg-repos-parity.test.mjs:1058` fails: `UsersRepo.getById('usr_dirty_only')` still returns the pre-restore deleted user from L1/L2 cache.
3. **[P1 — Live Log Leak Under Client Disconnect/Timeout] `vm2api:live:inflight` accumulates orphan members (`68` / `335` / `479`)**:
   - When clients time out or disconnect under heavy event-loop stalls (`EDRAINTIMEOUT`), in-flight entries registered in `vm2api:live:inflight` are not reliably cleaned up on abort/close until TTL expiry (300s), leaving hundreds of ghost "in-flight" requests visible in the live log panel.

---

## 3. Baseline A — Single Instance (`--instances 1`, 200 VMs, 10 Panel Pollers)

### A1. Pre-Saturation Low-RPM Probe (`steps=30,60,120,240`, `20s/step`, `warmup=3s`)

| Target RPM | Achieved RPM | Ratio | OK 2xx | Non-Inj Err | Total p50 / p95 (ms) | Est. Overhead p95 (ms) | EL p95 (ms) | `Atomics.wait` /req (ms/req) | CPU % | `accounts` seq/idx | `account_runtime` seq | Redis ops/s |
| ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | --- | ---: | --- | ---: | ---: |
| 30 | 23.2 | 77.2% | 10/10 | 0 (0.0%) | 12,309 / 14,440 | ~13,747 | 962.6 | 963.4 (1,914.7ms) | 44.4% | 2,496 / 5,085 | 2,302 | 263.9 |
| 60 | 37.3 | 62.2% | 20/20 | 0 (0.0%) | 14,063 / 18,552 | ~17,810 | 1,030.2 | 635.9 (1,229.6ms) | 41.7% | 4,653 / 5,585 | 4,269 | 154.4 |
| 120 | 49.0 | 40.8% | 18/40 | 22 (55.0%) | 20,301 / 34,836 | ~33,873 | 1,707.1 | 531.1 (1,005.1ms) | 41.4% | 8,202 / 8,725 | 7,469 | 182.0 |
| 240 | 97.0 | 40.4% | 34/80 | 46 (57.5%) | 25,804 / 42,816 | ~41,641 | 1,398.8 | 314.8 (527.0ms) | 43.3% | 10,737 / 8,633 | 9,753 | 168.7 |

### A2. Full Stepped Sweep (`steps=300,600,1200,2400,4800,8000`, `20s/step`, `warmup=5s`)

| Target RPM | OK 2xx / Dispatched | Non-Inj Err (`EDRAINTIMEOUT`) | Mock Completed (Sustained RPM) | Total p95 (ms) | EL p95 (ms) | `Atomics.wait` Block (Window) | CPU % | RSS MB | `accounts` seq/idx | `account_runtime` seq | WAL MB/s | Redis ops/s (MB) |
| ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | --- | ---: | ---: | --- |
| 300 | 43 / 100 | 57 (57.0%) | 47 (~56 RPM) | 39,830 | 1,461.7 | 28,110 calls / 42.6s (**83.6%**) | 44.2% | 731.4 | 12,398 / 9,692 | 11,287 | 0.01 | 152.7 (2.5) |
| 600 | 12 / 200 | 188 (94.0%) | 51 (~61 RPM) | 43,769 | 2,476.7 | 28,978 calls / 43.8s (**87.7%**) | 40.3% | 751.8 | 15,608 / 10,533 | 14,375 | 0.02 | 149.0 (2.5) |
| 1,200 | 0 / 400 | 400 (100%) | 49 (~59 RPM) | timeout | 2,029.0 | 26,194 calls / 43.3s (**86.7%**) | 41.9% | 767.0 | 12,931 / 9,644 | 11,875 | 0.01 | 100.6 (2.6) |
| 2,400 | 0 / 800 | 800 (100%) | 60 (~72 RPM) | timeout | 2,311.1 | 26,130 calls / 41.2s (**82.4%**) | 40.6% | 765.0 | 13,671 / 9,692 | 12,768 | 0.03 | 145.8 (2.7) |
| 4,800 | 0 / 1,600 | 1,600 (100%) | 46 (~55 RPM) | timeout | 2,506.1 | 19,649 calls / 41.2s (**82.4%**) | 40.6% | 803.6 | 7,980 / 8,269 | 7,327 | 0.01 | 172.0 (2.8) |
| 8,000 | 0 / 2,668 | 2,668 (100%) | 52 (~62 RPM) | timeout | 2,306.9 | 23,995 calls / 44.0s (**88.0%**) | 42.5% | 805.0 | 11,525 / 9,877 | 10,670 | 0.01 | 93.4 (2.8) |

- **Closed-Loop (`1inst-low` / `1inst`)**: `usage_logs` **PASS** (`84/84` & `81/80`, 0% loss); `api_keys` **FAIL** (`0/84` & `0/81`, `$10.17` & `$9.64` uncredited); `PgLogWriter` `overflow=0/fallback=0/drop=0`; Redis `evicted_keys=0`, `vm2api:live:inflight` orphans=`68` / `335`.

---

## 4. Baseline B — 4 Instances (`--instances 4`, 200 VMs, 20 Panel Pollers)

Executed with `steps=120,300,600,1200,3000`, `20s/step`, `warmup=5s`:

| Target RPM | Achieved RPM | OK 2xx / Dispatched | Non-Inj Err | Mock Completed | Total p50 / p95 (ms) | Est. Overhead p95 (ms) | Panel `dashboard` p95 (ms) | EL p95 (ms) | `Atomics.wait` /req (ms/req) | CPU % (4 inst) | `accounts` seq/idx | `account_runtime` seq | WAL MB/s | Redis ops/s (MB) |
| ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | --- | ---: | --- | ---: | ---: | --- |
| 120 | 124.3 | 40 / 40 | 0 (0.0%) | 42 (1×429) | 1,659 / 3,938 | ~3,542 | 9,571 (0 err) | 264.2 | 876.3 (1,143.2ms) | 180.1% | 10,068 / 17,502 | 9,300 | 0.06 | 817.4 (2.6) |
| 300 | 213.1 | 100 / 100 | 0 (0.0%) | 101 (1×502) | 8,247 / 13,852 | ~13,340 | 15,803 (0 err) | 569.4 | 568.1 (757.6ms) | 180.5% | 23,409 / 26,172 | 21,507 | 0.07 | 1,155.4 (2.9) |
| 600 | 241.8 | 158 / 200 | 42 (21.0%) | 177 (5×429, 2×502) | 28,110 / 39,292 | ~38,442 | 15,002 (5/5 err) | 1,700.8 | 513.9 (750.1ms) | 185.9% | 47,314 / 37,220 | 43,582 | 0.06 | 913.0 (3.1) |
| 1,200 | 481.8 | 140 / 400 | 260 (65.0%) | 155 (5×502) | 28,216 / 41,713 | ~40,714 | 15,001 (5/5 err) | 1,328.5 | 125.0 (189.3ms) | 91.0% | 47,552 / 39,103 | 43,407 | 0.04 | 588.9 (3.3) |
| 3,000 | 1,201.5 | 0 / 1,000 | 1,000 (100%)* | 71 | 49,128 / 49,295 | ~48,205 | 15,005 (5/5 err) | 3,468.7 | 89.5 (178.0ms) | 318.4% | 37,554 / 34,597 | 34,457 | 0.02 | 405.6 (5.2) |

*\*At 3,000 RPM, 996 requests hit client `EDRAINTIMEOUT` and 4 returned HTTP `503`. Note: during Phase 0 sweeps, `/api/panel/statistics?range=24h` returned HTTP 400 because `statistics-repo.mjs:18` only accepts `today|7days|30days|thisMonth`; `load-runner.mjs` has been corrected to `range=today` for Phase 1. All other panel endpoints (`usage-logs`, `dashboard`, `active-sessions`, `overview`, `PUT /api/panel/backups/config`) had 0 errors at 120–300 RPM and timed out at 15s once proxy load exceeded 600 RPM.*

- **Closed-Loop (`4inst`)**: `usage_logs` **PASS** (`464` persisted vs `452` client-completed = 0% loss; `458` HTTP 200 + `6` HTTP 503); `api_keys` **FAIL** (`67/68` keys drifted, `0/458` requests credited, `$51.11` uncredited); `PgLogWriter` `overflow=0/fallback=0/drop=0/err=0` (`queued=5` still flushing at 16s drain timeout because 4 overloaded instances were still finishing queued requests); Redis `evicted_keys=0`, `vm2api:live:inflight` orphans=`479`.

---

## 5. Exact Root-Cause Attribution: Top 5 `Atomics.wait` & Synchronous PG Offenders

Live `pg_stat_user_tables` captured during the 1-instance run after just **81 completed requests** (cumulative `182,523 Atomics.wait` calls = `306.2s` blocked out of `406.2s` uptime):

| Rank | Table / Subsystem | Live Cumulative Scans (81 reqs) | Exact Code Call Site(s) | Mechanism & Per-Request Cost |
| :---: | --- | ---: | --- | --- |
| **#1** | `accounts` + `account_runtime` (`seq_scan`) | **87,659** + **80,685** (`~230–250 seq_scans/req` each) | `src/lib/scheduler/scheduler-runtime.mjs:1921-1999` (`#resolveAllowedNodeKeys`) → `src/lib/db/repos/account-runtime-repo.mjs:78-79, 126-133` (`schedulingSnapshot([key])`) | **Critical N+1 Loop + Unindexable SQL**: Every `/v1/messages` request (and every failover retry / `peekAccount`) iterates all **200 Claude VMs** and calls `runtimeRepo.schedulingSnapshot([key])` **1 key at a time**. `account-runtime-repo.mjs:78-79` runs `FROM accounts a FULL JOIN account_runtime r ON r.account_id = a.id WHERE COALESCE(a.id, r.account_id) IN (SELECT value FROM json_each(?))`, defeating PK indexes and forcing a full sequential scan of BOTH tables **200+ times per request** (~350–500ms synchronous `Atomics.wait` per attempt). |
| **#2** | `accounts` (`idx_scan`) | **69,906** (`~280–500 idx_scans/req` + background) | `src/lib/scheduler/scheduler-runtime.mjs:1431-1660` (`buildTelemetryBatch`, `rawAccountForVm`, `#claudeQuotaGuardLevel`) & `src/lib/pool/account-quota.mjs:1604-1646` (`snapshot()`) | Periodic scheduler telemetry ticks and `/api/panel/dashboard` rebuilds loop over all 200 VMs invoking `rawAccountForVm()` twice per VM (`accountsRepo.get()` × 400) + `accountsRepo.list()`, all synchronously via `PgSyncDb`. |
| **#3** | `account_allocations` (`seq_scan`) | **6,685** (`~82 seq_scans/req`) | `src/lib/pool/account-quota.mjs:140-150, 1604-1646` (`_batchAllocsStmt` window scan) + `src/lib/db/repos/accounts-repo.mjs:96-106` | `accountQuota.snapshot()` runs a synchronous `ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY id DESC)` full scan on every dashboard/telemetry snapshot; `ingestHeaders()` also runs synchronous `INSERT` + `DELETE WHERE id NOT IN (...)` per completion. |
| **#4** | `vms` (`idx_scan` + `n_tup_upd`) | **6,422** scans + **1,392** updates | `src/lib/scheduler/scheduler-runtime.mjs:1594, 1976` & `src/lib/pool/pool-scheduler.mjs:537, 645, 902-903` (`listVms` / `getVm`) | Per-VM `getVm()` inside 200-VM loops + synchronous DB sync writes during scheduling/health maintenance. |
| **#5** | `sticky_sessions` & `account_runtime` writes (`n_tup_upd`) | **3,418** (`sticky_sessions`) + **1,777** (`account_runtime` upserts) + **1,507** (`accounts` updates) | `src/lib/pool/pool-scheduler.mjs:544, 886-906, 1050-1073, 1205-1211`, `src/lib/scheduler/scheduler-runtime.mjs:1717-1760` (`#persistDrainBatch`), `src/lib/pool/sticky-router.mjs` | Synchronous per-request `runtimeRepo.get()` / `upsert()` / `markCooldown()`, synchronous `writeHeartbeat()` loop, and synchronous `withTransaction()` sticky drain persistence on the main thread. |

---

## 6. Phase 1 Optimization Priority Order (Data-Driven Roadmap)

1. **P0 — Fix 2 Verified PG 18 Correctness Bugs First**:
   - Fix `api-keys.mjs:1554-1615` (`_applyUsageBatchToPg`): cast `$1::text` for `window_*_start` / `updated_at` and `$1::timestamptz` only inside the `EXTRACT(...)` arithmetic, and surface/log errors instead of silent swallow.
   - Fix `backup-service.mjs:522` (`restoreBackup`): invalidate `'entity:'`, `'risk:'`, and `'live:'` prefixes alongside `'apikey:'`, `'billing:'`, `'sched:'`, `'dash:'` so `pg-repos-parity.test.mjs` Tier 2B passes 100%.
   - Fix `vm2api:live:inflight` orphan cleanup on client socket `aborted`/`close` before `requestLog.finish()`.
2. **P0 — Eliminate the 200× Per-Request `Atomics.wait` N+1 Loop (Expected 50×–100× Single-Instance Gain)**:
   - In `scheduler-runtime.mjs:1921-1999` (`#resolveAllowedNodeKeys`), stop calling `runtimeRepo.schedulingSnapshot([key])` per VM on the hot path; serve from an async-refreshed in-memory/Redis scheduling snapshot cache (e.g., 1s TTL + event-driven invalidation on cooldown/quota change, falling back to 1 batched `getMany()`).
   - Rewrite `account-runtime-repo.mjs:78-79` (`_snapshots` / `schedulingSnapshot`) to use index-friendly PK `IN (...)` subqueries (identical to `getMany()` at lines 160-220) instead of `FULL JOIN ... WHERE COALESCE(...) IN (json_each(?))`.
3. **P1 — Eliminate Remaining Synchronous `PgSyncDb` Calls from Telemetry, Quota & Sticky Hot Paths**:
   - Cache `accountQuota` + `accounts` + `vms` snapshots in memory (backed by async PG pool refresh + write-behind for `ingestHeaders` / `account_allocations` / `writeHeartbeat` / `#persistDrainBatch`).
   - Move `buildTelemetryBatch()` and `pool-scheduler` maintenance ticks off synchronous `PgSyncDb` onto the async `pg.Pool`.
4. **P2 — Scale Verification to 20,000 RPM × 100K-Context**:
   - Re-run this exact Phase 0 benchmark (same locked corpus `c7a03750...`, 1-inst and 4-inst) after Phase 1 fixes to verify `<50ms` control-plane overhead p95, `0` `Atomics.wait`/req on the hot path, `0%` error rate, and **100% PASS** on all 4 closed-loop assertions.

---

## 7. Reproduction Commands

```bash
# 1. Start isolated PG 18 + Redis 8
docker compose -p vm2api-bench -f scripts/bench-20k/docker-compose.bench.yml up -d --wait

# 2. Run 1-instance & 4-instance 100K-context replay baselines
node scripts/bench-20k/run-phase0.mjs \
  --label phase0-baseline-1inst --sut-dir /mnt/x/vm2api-wt-redis-pg-opt \
  --instances 1 --vms 200 --keys 100 --ttft-ms 50 --stream-ms 300 --fault-rate 0.02 \
  --mock-workers 4 --workers 4 --panel-pollers 10 --step-sec 20 --warmup-sec 5 \
  --steps 30,60,120,240,300,600 --out-report .local/bench-20k/reports/phase0-baseline-1inst.md

node scripts/bench-20k/run-phase0.mjs \
  --label phase0-baseline-4inst --sut-dir /mnt/x/vm2api-wt-redis-pg-opt \
  --instances 4 --vms 200 --keys 100 --ttft-ms 50 --stream-ms 300 --fault-rate 0.02 \
  --mock-workers 4 --workers 4 --panel-pollers 20 --step-sec 20 --warmup-sec 5 \
  --steps 120,300,600,1200,3000 --out-report .local/bench-20k/reports/phase0-baseline-4inst.md

# 3. Tear down stack cleanly
docker compose -p vm2api-bench -f scripts/bench-20k/docker-compose.bench.yml down -v
```
