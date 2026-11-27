#!/usr/bin/env node
/**
 * Full 34-table extreme-edge-case Mock SQLite database generator for vm2api.
 *
 * Ensures EVERY active table in vm2api (32 schema tables + thinking_signature_owners +
 * schema_migrations) is populated with deterministic, production-representative, and
 * edge-case records covering:
 *   - Tables often empty in prod (vm_pools, vm_pool_members, redeem_codes,
 *     refusal_session_blocks, risk_device_aliases, cluster_node_direct_links)
 *   - Embedded NUL bytes (\x00), 4-byte Emoji, CJK, escaped quotes/backslashes,
 *     and a 1.5 MiB request_log_debug JSON blob
 *   - BIGINT > 2^31-1 timestamps, token counts, and nano-USD costs
 *   - Out-of-order 3-level self-referential cluster_nodes.jump_node_id chain
 *   - All 4 crag_shop_orders states with integer & 'unlimited' slot_limit, UUIDv4, 64-hex SHA256
 *   - Case-insensitive unique indexes + soft-deleted duplicate rows (users, vm_pools)
 *   - Encrypted vms.vm_json ('enc:v1:...') & api_keys.key_secret
 *   - Multi-tenant, multi-protocol, DST-spanning, unpriced & upstream-400 usage_logs
 *
 * Usage:
 *   node scripts/seed-mock-sqlite.mjs --out /path/to/mock-kin.db [--usage-count 400] [--json]
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { createDatabase } from '../src/lib/db/database.mjs'
import { encryptString } from '../src/lib/db/secure.mjs'

export const MOCK_DB_SECRET = 'mock-e2e-db-secret-2026'

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex')
}

function hmacKey(secret, token) {
  return crypto.createHmac('sha256', secret).update(token).digest('hex')
}

/**
 * Populate a brand-new SQLite database with full 33-table edge-case Mock data.
 * @returns {{ sqlitePath: string, tableCounts: Record<string, number>, totalRows: number, nulEmbeddedCount: number }}
 */
export function seedMockSqlite({ outPath, usageCount = 400, hashSecret = 'mock-verify-hash-secret' } = {}) {
  if (!outPath) throw new Error('outPath is required')
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.rmSync(outPath + suffix, { force: true })
    } catch {}
  }

  const db = createDatabase({ dbPath: outPath })
  let nulEmbeddedCount = 0
  const nulBlob = (str) => {
    nulEmbeddedCount += 1
    return Buffer.from(str, 'utf8')
  }

  try {
    const nowMs = Date.now()
    const nowIso = new Date(nowMs).toISOString()
    const hourMs = 3_600_000
    const dayMs = 86_400_000

    // Ensure runtime-created thinking_signature_owners table also exists in SQLite
    db.exec(`
      CREATE TABLE IF NOT EXISTS thinking_signature_owners (
        key TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_thinking_owner_created ON thinking_signature_owners(created_at);
    `)

    db.exec('BEGIN')

    // 1. settings (including JSON, CJK/Emoji, and real embedded NUL byte via BLOB)
    const insSetting = db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)')
    insSetting.run('site_title', JSON.stringify('vm2api 🚀 测试平台 "quotes" \\slash'), nowIso)
    insSetting.run('routing_mode', JSON.stringify({ sticky: true, failover: 3 }), nowIso)
    insSetting.run('nul_edge_setting', nulBlob('"before\x00after"'), nowIso)
    insSetting.run('usage_logs_pruned_through', JSON.stringify(new Date(nowMs - 30 * dayMs).toISOString()), nowIso)

    // 2. users (admin + 2 active tenants + 1 disabled + 1 soft-deleted duplicate username)
    const insUser = db.prepare(`
      INSERT INTO users (
        id, email, username, password_hash, role, balance, concurrency,
        status, notes, last_login_at, last_active_at, created_at, updated_at, deleted_at, vm_create_quota
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    insUser.run(
      'u_admin',
      'admin@mock.local',
      'AdminRoot',
      'scrypt$mock$admin',
      'admin',
      9999.123456,
      50,
      'active',
      '系统管理员 👑',
      nowIso,
      nowIso,
      nowIso,
      nowIso,
      null,
      20,
    )
    insUser.run(
      'u_alice',
      'alice@mock.local',
      'AliceUser',
      'scrypt$mock$alice',
      'user',
      250.75,
      10,
      'active',
      'Tenant Alice',
      nowIso,
      nowIso,
      nowIso,
      nowIso,
      null,
      5,
    )
    insUser.run(
      'u_bob',
      'bob@mock.local',
      'BobUser',
      'scrypt$mock$bob',
      'user',
      18.5,
      4,
      'active',
      'Tenant Bob',
      nowIso,
      nowIso,
      nowIso,
      nowIso,
      null,
      2,
    )
    insUser.run(
      'u_disabled',
      'disabled@mock.local',
      'DisabledUser',
      'scrypt$mock$dis',
      'user',
      0,
      2,
      'disabled',
      'Disabled account',
      null,
      null,
      nowIso,
      nowIso,
      null,
      0,
    )
    // Soft-deleted row sharing case-insensitive username with active u_alice (verifies partial unique index!)
    insUser.run(
      'u_alice_old',
      'alice@mock.local',
      'aliceuser',
      'scrypt$mock$old',
      'user',
      0,
      1,
      'disabled',
      'Deleted prior',
      null,
      null,
      nowIso,
      nowIso,
      nowIso,
      0,
    )

    // 3. groups (keep default 1 & 2, plus custom group 3 & soft-deleted 4)
    const insGroup = db.prepare(`
      INSERT INTO groups (id, name, description, rate_multiplier, is_exclusive, platform, rpm_limit, sort_order, status, created_at, updated_at, deleted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    insGroup.run(3, 'vip-tier', 'VIP 专属通道 🌟', 1.25, 1, 'claude', 120, 2, 'active', nowIso, nowIso, null)
    insGroup.run(4, 'vip-tier', 'Old deleted VIP', 1.0, 0, 'claude', 0, 3, 'disabled', nowIso, nowIso, nowIso)

    // 4. proxies (SOCKS5 + HTTP + bound + soft-deleted + IPv4/IPv6 geo fields)
    const insProxy = db.prepare(`
      INSERT INTO proxies (
        id, protocol, host, port, username, password, raw, status, enabled, bound_vm_id,
        consecutive_failures, latency_ms, last_probe_at, last_error, created_at, name, updated_at, deleted_at,
        owner_user_id, geo_ip, geo_country, geo_country_code, geo_region, geo_city, geo_isp, geo_timezone,
        geo_checked_at, geo_error, label, geo_v6_ip, geo_v6_country, geo_v6_country_code, geo_v6_region,
        geo_v6_city, geo_v6_isp, geo_v6_timezone, geo_v6_checked_at, geo_v6_error, domain_forward, dns_disable_svcb_https
      ) VALUES (${Array(40).fill('?').join(', ')})
    `)
    for (let i = 1; i <= 5; i += 1) {
      insProxy.run(
        `px_${i}`,
        i % 2 === 0 ? 'http' : 'socks5',
        `198.51.100.${i}`,
        1080 + i,
        `user${i}`,
        `pass${i}`,
        `${i % 2 === 0 ? 'http' : 'socks5'}://user${i}:pass${i}@198.51.100.${i}:${1080 + i}`,
        i === 5 ? 'dead' : 'ok',
        i === 5 ? 0 : 1,
        i <= 3 ? `vm-0${i}` : null,
        i === 5 ? 4 : 0,
        45 + i * 10,
        nowIso,
        i === 5 ? 'connection timed out' : null,
        nowIso,
        `Proxy-${i}`,
        nowIso,
        i === 5 ? nowIso : null,
        i === 2 ? 'u_alice' : null,
        `198.51.100.${i}`,
        'United States',
        'US',
        'California',
        'Los Angeles',
        'MockISP',
        'America/Los_Angeles',
        nowIso,
        null,
        `us-west-${i}`,
        `2001:db8::${i}`,
        'United States',
        'US',
        'California',
        'Los Angeles',
        'MockISP-v6',
        'America/Los_Angeles',
        nowIso,
        null,
        i % 2,
        i === 1 ? 1 : 0,
      )
    }

    // 5. vms (plain JSON + AES enc:v1 ciphertext + integer-string oauth_expires_at + BIGINT file_mtime_ms)
    const insVm = db.prepare(`
      INSERT INTO vms (
        id, name, status, schedulable, email, account_uuid, org_uuid, access_token, refresh_token,
        session_key, oauth_expires_at, oauth_source, proxy_id, claude_code_version, timezone, locale,
        vm_json, encrypted, file_mtime_ms, synced_at, created_at, updated_at, owner_user_id, origin
      ) VALUES (${Array(24).fill('?').join(', ')})
    `)
    for (let i = 1; i <= 5; i += 1) {
      const id = `vm-0${i}`
      const isEnc = i === 3
      const plainVmJson = JSON.stringify({
        id,
        name: `Slot ${i}`,
        status: 'running',
        schedulable: true,
        machine: { memory: '1g' },
      })
      const rawJson = isEnc ? encryptString(plainVmJson, MOCK_DB_SECRET) : plainVmJson
      insVm.run(
        id,
        `Slot-${i}`,
        i === 5 ? 'stopped' : 'running',
        i === 5 ? 0 : 1,
        `acct${i}@mock.local`,
        `acc-uuid-${i}`,
        `org-uuid-${i}`,
        encryptString(`tok_${i}`, MOCK_DB_SECRET),
        encryptString(`ref_${i}`, MOCK_DB_SECRET),
        encryptString(`sk_${i}`, MOCK_DB_SECRET),
        i === 2 ? String(nowMs + 86_400_000) : new Date(nowMs + 86_400_000).toISOString(),
        'oauth',
        i <= 3 ? `px_${i}` : null,
        '2.1.321',
        'Asia/Shanghai',
        'en-US',
        rawJson,
        isEnc ? 1 : 0,
        nowMs, // > 2^31-1 BIGINT!
        nowIso,
        nowIso,
        nowIso,
        i === 2 ? 'u_alice' : i === 4 ? 'u_bob' : null,
        i === 4 ? 'user' : 'platform',
      )
    }

    // 6. vm_pools & 7. vm_pool_members (often empty in prod!)
    const insPool = db.prepare(
      'INSERT INTO vm_pools (id, name, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    )
    insPool.run('pool_alpha', 'AlphaPool', 1, nowIso, nowIso)
    insPool.run('pool_beta', 'BetaPool', 1, nowIso, nowIso)
    insPool.run('pool_empty', 'EmptyPool', 0, nowIso, nowIso)

    const insPoolMember = db.prepare('INSERT INTO vm_pool_members (pool_id, vm_id, created_at) VALUES (?, ?, ?)')
    insPoolMember.run('pool_alpha', 'vm-01', nowIso)
    insPoolMember.run('pool_alpha', 'vm-02', nowIso)
    insPoolMember.run('pool_beta', 'vm-03', nowIso)
    insPoolMember.run('pool_beta', 'vm-04', nowIso)

    // 8. accounts, 9. account_groups, 10. account_runtime, 11. account_allocations, 12. account_lifetime_usage_archive
    const insAcc = db.prepare(`
      INSERT INTO accounts (
        id, vm_id, email, concurrency, requests, tokens_in, tokens_out, updated_at,
        cache_read_tokens, cache_creation_tokens, concurrency_override, max_rpm, rpm_override,
        name, platform, type, credentials, extra, proxy_id, load_factor, priority, rate_multiplier,
        status, error_message, last_used_at, expires_at, schedulable, rate_limited_at, rate_limit_reset_at,
        overload_until, temp_unschedulable_until, temp_unschedulable_reason, session_window_start,
        session_window_end, session_window_status, created_at, deleted_at
      ) VALUES (${Array(37).fill('?').join(', ')})
    `)
    const insAccGroup = db.prepare(
      'INSERT INTO account_groups (account_id, group_id, priority, created_at) VALUES (?, ?, ?, ?)',
    )
    const insAccRt = db.prepare(`
      INSERT INTO account_runtime (
        account_id, vm_id, status, model_states_json, credential_generation, refresh_status,
        worker_heartbeat_at, worker_status_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const insAlloc = db.prepare(`
      INSERT INTO account_allocations (
        account_id, at, source, util_5h, util_7d, status_5h, status_7d, claim, tokens_in, tokens_out
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const insArchive = db.prepare(
      'INSERT INTO account_lifetime_usage_archive (account_id, total_cost, total_tokens) VALUES (?, ?, ?)',
    )

    for (let i = 1; i <= 6; i += 1) {
      const aid = `acct_${i}`
      const vmId = i <= 5 ? `vm-0${i}` : null
      insAcc.run(
        aid,
        vmId,
        `acct${i}@mock.local`,
        4,
        1000 * i,
        5_000_000_000 * i,
        900_000 * i,
        nowIso,
        2_500_000_000 * i,
        300_000_000 * i,
        0,
        60,
        0,
        `Account-${i}`,
        i === 6 ? 'openai' : 'claude',
        'oauth',
        '{}',
        JSON.stringify({ tier: 'max_20x' }),
        i <= 3 ? `px_${i}` : null,
        100,
        50 - i,
        1.0,
        i === 5 ? 'cooldown' : 'active',
        i === 5 ? 'rate limited' : null,
        nowIso,
        new Date(nowMs + 7 * dayMs).toISOString(),
        i === 5 ? 0 : 1,
        i === 5 ? nowIso : null,
        i === 5 ? new Date(nowMs + hourMs).toISOString() : null,
        null,
        null,
        null,
        nowIso,
        new Date(nowMs + 5 * hourMs).toISOString(),
        'open',
        nowIso,
        null,
      )
      insAccGroup.run(aid, 1, 50, nowIso)
      if (i <= 2) insAccGroup.run(aid, 3, 20, nowIso)
      if (vmId) {
        insAccRt.run(
          aid,
          vmId,
          i === 5 ? 'cooldown' : 'healthy',
          JSON.stringify({ 'claude-sonnet-4-5': { ok: true } }),
          100 + i,
          'ok',
          nowMs - i * 1000,
          JSON.stringify({ ready: true }),
          nowIso,
        )
      }
      for (let j = 0; j < 4; j += 1) {
        insAlloc.run(
          aid,
          new Date(nowMs - j * hourMs).toISOString(),
          'probe',
          0.12 * i,
          0.08 * i,
          'allowed',
          'allowed',
          'ok',
          120000,
          15000,
        )
      }
      insArchive.run(aid, 123.456789 * i, 9_876_543_210 * i)
    }

    // 13. api_endpoints, 14. api_endpoint_keys, 15. api_endpoint_models
    const insEp = db.prepare(`
      INSERT INTO api_endpoints (
        id, name, disabled, prefix, base_url, headers_json, disable_cooling, priority,
        created_at, updated_at, kind, protocol, risk_review_enabled, body_policy
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    insEp.run(
      'ep_anth',
      'Anthropic Direct',
      0,
      'relay/',
      'https://api.example.com/anthropic',
      '{"x-test":"1"}',
      0,
      10,
      nowIso,
      nowIso,
      'custom',
      'anthropic',
      1,
      'persona',
    )
    insEp.run(
      'ep_oai',
      'OpenAI Direct',
      0,
      '',
      'https://api.example.com/openai',
      '{}',
      1,
      5,
      nowIso,
      nowIso,
      'custom',
      'openai',
      0,
      'caller',
    )

    const insEpKey = db.prepare(`
      INSERT INTO api_endpoint_keys (id, endpoint_id, api_key, proxy_url, disabled, cooldown_until, created_at, proxy_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    insEpKey.run('epk_1', 'ep_anth', 'sk-ant-mock-001', null, 0, null, nowIso, 'px_1')
    insEpKey.run('epk_2', 'ep_oai', 'sk-oai-mock-002', 'http://198.51.100.2:1082', 0, null, nowIso, 'px_2')

    const insEpModel = db.prepare(`
      INSERT INTO api_endpoint_models (id, endpoint_id, sort, upstream_name, alias, image, thinking_levels_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    insEpModel.run('epm_1', 'ep_anth', 0, 'claude-sonnet-4-5', 'relay/sonnet', 0, JSON.stringify(['low', 'high']))
    insEpModel.run('epm_2', 'ep_oai', 1, 'gpt-5.4', 'gpt-5.4', 1, null)

    // 16. api_keys (active, user-owned, pool-scoped, api-category, quota_exhausted, soft-deleted)
    const insKey = db.prepare(`
      INSERT INTO api_keys (
        id, name, key, status, max_concurrency, quota_requests, quota_requests_used, rpm, expires_at,
        created_at, updated_at, last_used_at, requests, tokens_in, tokens_out, key_hash, key_prefix, key_suffix,
        cache_read_tokens, cache_creation_tokens, category, key_secret, user_id, group_id, quota, quota_used,
        rate_limit_5h, rate_limit_1d, rate_limit_7d, usage_5h, usage_1d, usage_7d,
        window_5h_start, window_1d_start, window_7d_start, ip_whitelist, ip_blacklist, deleted_at,
        group_type, allowed_vms, vm_pool_id, api_endpoint_id, allowed_models
      ) VALUES (${Array(43).fill('?').join(', ')})
    `)
    const mockKeys = [
      {
        id: 'key_admin_1',
        name: 'Admin Key',
        token: 'sk-vm-mockadminkey00000000000001',
        userId: 'u_admin',
        groupId: 1,
        status: 'active',
        cat: 'oauth',
        pool: 'pool_alpha',
        ep: null,
        del: null,
      },
      {
        id: 'key_alice_1',
        name: 'Alice OAuth Key',
        token: 'sk-vm-mockalicekey00000000000002',
        userId: 'u_alice',
        groupId: 3,
        status: 'active',
        cat: 'oauth',
        pool: null,
        ep: null,
        del: null,
      },
      {
        id: 'key_bob_api',
        name: 'Bob API Key',
        token: 'sk-vm-mockbobapikey0000000000003',
        userId: 'u_bob',
        groupId: 1,
        status: 'active',
        cat: 'api',
        pool: null,
        ep: 'ep_oai',
        del: null,
      },
      {
        id: 'key_exhausted',
        name: 'Exhausted Key',
        token: 'sk-vm-mockexhausted0000000000004',
        userId: 'u_bob',
        groupId: 1,
        status: 'quota_exhausted',
        cat: 'oauth',
        pool: null,
        ep: null,
        del: null,
      },
      {
        id: 'key_deleted',
        name: 'Deleted Key',
        token: 'sk-vm-mockdeletedkey000000000005',
        userId: 'u_alice',
        groupId: 1,
        status: 'disabled',
        cat: 'oauth',
        pool: null,
        ep: null,
        del: nowIso,
      },
    ]
    for (const k of mockKeys) {
      const h = hmacKey(hashSecret, k.token)
      insKey.run(
        k.id,
        k.name,
        `hmac:${h}`,
        k.status,
        10,
        10000,
        120,
        60,
        new Date(nowMs + 30 * dayMs).toISOString(),
        nowIso,
        nowIso,
        nowIso,
        120,
        500000,
        80000,
        h,
        k.token.slice(0, 10),
        k.token.slice(-4),
        1_200_000,
        150_000,
        k.cat,
        k.token,
        k.userId,
        k.groupId,
        500.0,
        k.status === 'quota_exhausted' ? 500.0 : 12.345,
        25.0,
        100.0,
        300.0,
        2.5,
        8.2,
        12.345,
        nowIso,
        nowIso,
        nowIso,
        '[]',
        '[]',
        k.del,
        k.pool ? 'vm_pool' : 'all',
        JSON.stringify(['vm-01']),
        k.pool,
        k.ep,
        JSON.stringify([]),
      )
    }

    // 17. backup_records
    db.prepare(`
      INSERT INTO backup_records (id, created_at, kind, status, file_path, file_name, size_bytes, sha256, db_bytes, includes_json, error, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'bak_mock_1',
      nowIso,
      'scheduled',
      'ok',
      '/opt/vm2api/data/backups/mock.tar.gz',
      'mock.tar.gz',
      3_000_000_000,
      sha256('mock-bak'),
      4_000_000_000,
      '{"db":true,"vms":5}',
      null,
      'big backup >2GiB',
    )

    // 18. cluster_nodes (3-level self-FK chain inserted OUT OF ORDER!) & 19. cluster_node_direct_links
    const insNode = db.prepare(`
      INSERT INTO cluster_nodes (
        id, label, host, port, username, auth_type, password, private_key, passphrase,
        host_key_alg, host_key_sha256, jump_node_id, created_at, updated_at, platform
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    insNode.run(
      'node_leaf',
      'Leaf Node',
      '10.10.0.3',
      22,
      'root',
      'key',
      null,
      '---KEY---',
      null,
      'ssh-ed25519',
      sha256('leaf'),
      null,
      nowIso,
      nowIso,
      'linux',
    )
    insNode.run(
      'node_mid',
      'Mid Jump',
      '10.10.0.2',
      22,
      'root',
      'key',
      null,
      '---KEY---',
      null,
      'ssh-ed25519',
      sha256('mid'),
      null,
      nowIso,
      nowIso,
      'linux',
    )
    insNode.run(
      'node_root',
      'Root Bastion',
      '10.10.0.1',
      2222,
      'ops',
      'password',
      'enc:pw',
      null,
      null,
      'ssh-ed25519',
      sha256('root'),
      null,
      nowIso,
      nowIso,
      'linux',
    )
    db.prepare('UPDATE cluster_nodes SET jump_node_id = ? WHERE id = ?').run('node_root', 'node_mid')
    db.prepare('UPDATE cluster_nodes SET jump_node_id = ? WHERE id = ?').run('node_mid', 'node_leaf')

    const insLink = db.prepare(
      'INSERT INTO cluster_node_direct_links (node_id, address, port, token, cert_sha256, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    insLink.run('node_mid', '10.10.0.2', 9443, 'tok_mid', sha256('cert_mid'), nowIso)
    insLink.run('node_leaf', '10.10.0.3', 9443, 'tok_leaf', sha256('cert_leaf'), nowIso)

    // 20. crag_shop_orders (ALL 4 statuses + integer slot_limit + 'unlimited' + UUIDv4 + 64-hex SHA256)
    const insOrder = db.prepare(`
      INSERT INTO crag_shop_orders (
        order_id, owner, request_id, sku, payment_method, reserved_at, status, created_at, term, amount_minor,
        slot_limit, purchase_json, expected_amount_minor, months, subtotal_minor, discount_minor, remaining,
        renewable, activation_vm_id, activation_fingerprint, activation_phase, activation_next_at, activation_deadline,
        activation_attempts, dispatch_state, closed_at, redemption_sha256, device_host,
        activation_error_code, activation_error_recovery, activation_request_id
      ) VALUES (${Array(31).fill('?').join(', ')})
    `)
    const nowSec = Math.floor(nowMs / 1000)
    insOrder.run(
      'ord_reserved',
      'panel:u_alice',
      'req-ord-1',
      'pro',
      'wxpay',
      nowSec - 300,
      'reserved',
      null,
      null,
      null,
      null,
      '{"sku":"pro"}',
      9900,
      1,
      9900,
      0,
      9900,
      1,
      null,
      null,
      'waiting',
      null,
      null,
      0,
      'unsent',
      null,
      null,
      sha256('host1'),
      null,
      null,
      null,
    )
    insOrder.run(
      'ord_pending',
      'device:tok_dev_1',
      'req-ord-2',
      'pro',
      'alipay',
      nowSec - 200,
      'pending',
      nowSec - 190,
      '1m',
      9900,
      5n,
      '{"sku":"pro","slots":5}',
      9900,
      1,
      9900,
      0,
      9900,
      1,
      'vm-01',
      sha256('fp1'),
      'waiting',
      nowSec + 60,
      nowSec + 3600,
      1,
      'submitted',
      null,
      null,
      sha256('host1'),
      'rate_limited_upstream',
      'not_activated',
      '11111111-2222-4333-8444-555555555555',
    )
    insOrder.run(
      'ord_paid',
      'panel:u_alice',
      'req-ord-3',
      'enterprise',
      'wxpay',
      nowSec - 100,
      'paid',
      nowSec - 95,
      '3m',
      29700,
      'unlimited',
      '{"sku":"enterprise"}',
      29700,
      3,
      30000,
      300,
      0,
      1,
      'vm-02',
      sha256('fp2'),
      'redeemed',
      nowSec + 120,
      nowSec + 7200,
      2,
      'submitted',
      null,
      sha256('redemption_code_3'),
      sha256('host1'),
      null,
      null,
      'aaaaaaaa-bbbb-4ccc-9ddd-eeeeeeeeeeee',
    )
    insOrder.run(
      'ord_fulfilled',
      'panel:u_bob',
      'req-ord-4',
      'renewal',
      'alipay',
      nowSec - 50,
      'fulfilled',
      nowSec - 40,
      '1y',
      99900,
      20n,
      '{"sku":"renewal"}',
      99900,
      12,
      99900,
      0,
      0,
      0,
      null,
      null,
      'active',
      null,
      null,
      3,
      'submitted',
      nowSec - 10,
      sha256('redemption_code_4'),
      sha256('host2'),
      null,
      null,
      '12345678-9abc-4def-a012-3456789abcde',
    )

    // 21. jev_usage_events, 22. jev_usage_meta (already seeded id=1), 23. jev_usage_totals
    const insJevEvt = db.prepare(`
      INSERT INTO jev_usage_events (
        id, created_at, request_id, provider, model, key_fingerprint, http_status, outcome, duration_ms,
        input_tokens, output_tokens, estimated_cost_nano_usd, input_nano_usd_per_token, output_nano_usd_per_token, pricing_basis
      ) VALUES (${Array(15).fill('?').join(', ')})
    `)
    for (let i = 1; i <= 20; i += 1) {
      insJevEvt.run(
        `jev_${i}`,
        new Date(nowMs - i * 60_000).toISOString(),
        `req_mock_${i}`,
        'google',
        'gemini-2.5-flash',
        `kfp_${i % 3}`,
        200,
        'ok',
        180 + i * 5,
        1000 * i,
        200 * i,
        5_000_000_000 * i,
        150,
        600,
        'catalog', // BIGINT nano-USD > 2^31-1!
      )
    }
    const insJevTot = db.prepare(`
      INSERT INTO jev_usage_totals (period, requests, successful, input_tokens, output_tokens, unknown_usage_requests, estimated_cost_nano_usd, unknown_cost_requests)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    insJevTot.run(nowIso.slice(0, 10), 20, 20, 210_000, 42_000, 0, 1_050_000_000_000, 0)

    // 24. redeem_codes (often empty in prod!)
    const insRedeem = db.prepare(`
      INSERT INTO redeem_codes (code, type, value, status, used_by, used_at, notes, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    insRedeem.run(
      'MOCK-CODE-001',
      'balance',
      50.0,
      'unused',
      null,
      null,
      'promo',
      new Date(nowMs + 30 * dayMs).toISOString(),
      nowIso,
    )
    insRedeem.run('MOCK-CODE-002', 'balance', 100.25, 'used', 'u_alice', nowIso, 'redeemed', null, nowIso)
    insRedeem.run('MOCK-CODE-003', 'balance', 20.0, 'unused', null, null, 'emoji 🎁', null, nowIso)

    // 25. refusal_device_blocks, 26. risk_device_aliases, 27. refusal_guards, 28. refusal_session_blocks
    const insDevBlock = db.prepare(`
      INSERT INTO refusal_device_blocks (
        device_id, first_seen_at, last_seen_at, hit_count, source_request_id, fingerprint, reason,
        subject_kind, identity_value, session_id, violations, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    insDevBlock.run(
      'dev_block_1',
      nowIso,
      nowIso,
      7,
      'req_mock_1',
      sha256('rf1'),
      'policy',
      'device',
      'dev-id-1',
      'sess_1',
      3,
      new Date(nowMs + dayMs).toISOString(),
    )
    insDevBlock.run(
      'dev_block_2',
      nowIso,
      nowIso,
      2,
      'req_mock_2',
      sha256('rf2'),
      'abuse',
      'ip',
      '203.0.113.9',
      null,
      1,
      null,
    )

    const insAlias = db.prepare('INSERT INTO risk_device_aliases (alias_key, device_key) VALUES (?, ?)')
    insAlias.run('alias_1', 'dev_block_1')
    insAlias.run('alias_2', 'dev_block_1')
    insAlias.run('alias_3', 'dev_block_2')

    const insGuard = db.prepare(`
      INSERT INTO refusal_guards (fingerprint, model, first_seen_at, last_seen_at, hit_count, source_request_id, error_message, preview, expires_at, signature)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    insGuard.run(
      sha256('guard_1'),
      'claude-sonnet-4-5',
      nowIso,
      nowIso,
      12,
      'req_mock_3',
      'refusal',
      'preview text',
      new Date(nowMs + dayMs).toISOString(),
      'sig_1',
    )
    insGuard.run(
      sha256('guard_2'),
      'claude-opus-4-5',
      nowIso,
      nowIso,
      4,
      'req_mock_4',
      'safety',
      '中文预览',
      null,
      'sig_2',
    )

    const insSessBlock = db.prepare(`
      INSERT INTO refusal_session_blocks (session_id, first_seen_at, last_seen_at, hit_count, source_request_id, account_id, model, preview, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    insSessBlock.run(
      'sess_blocked_1',
      nowIso,
      nowIso,
      5,
      'req_mock_5',
      'acct_1',
      'claude-sonnet-4-5',
      'blocked preview',
      'repeated_refusal',
    )
    insSessBlock.run(
      'sess_blocked_2',
      nowIso,
      nowIso,
      1,
      'req_mock_6',
      'acct_2',
      'gpt-5.4',
      'blocked preview 2',
      'policy',
    )

    // 29. sticky_sessions (BIGINT bound_at / expires_at)
    const insSticky = db.prepare(`
      INSERT INTO sticky_sessions (key, account_id, vm_id, session_id, bound_at, expires_at, hits, device_id, generation, slot_index)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (let i = 1; i <= 10; i += 1) {
      insSticky.run(
        `sticky_${i}`,
        `acct_${(i % 5) + 1}`,
        `vm-0${(i % 5) + 1}`,
        `sess_${i}`,
        nowMs - 60_000,
        nowMs + 3_600_000,
        i * 3,
        `dev_${i}`,
        i,
        i % 4,
      )
    }

    // 30. thinking_signature_owners (BIGINT created_at) & gemini_environment_owners
    const insThink = db.prepare('INSERT INTO thinking_signature_owners (key, account_id, created_at) VALUES (?, ?, ?)')
    for (let i = 1; i <= 25; i += 1) {
      insThink.run(sha256(`thinking_sig_${i}`).slice(0, 32), `acct_${(i % 5) + 1}`, nowMs - i * 1000)
    }
    const insGemOwner = db.prepare(
      'INSERT INTO gemini_environment_owners (env_id, owner_user_id, created_at) VALUES (?, ?, ?)',
    )
    insGemOwner.run('gemini-alice-1', 'u_alice', nowIso)
    insGemOwner.run('gemini-alice-2', 'u_alice', nowIso)

    // 30b. Unified scheduler center tables (071_scheduler_center)
    const insSchedPool = db.prepare(`
      INSERT INTO scheduler_pools (
        id, slug, name, description, enabled, provider_scope, plan_tags_json,
        pool_role, system_prompt_mode, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    insSchedPool.run(
      'pool_alpha',
      'alpha-pool',
      'AlphaPool',
      'Primary Anthropic pool',
      1,
      'anthropic',
      '["max_20x"]',
      'primary',
      'official',
      nowIso,
      nowIso,
    )
    insSchedPool.run(
      'pool_google',
      'google-pool',
      'GooglePool',
      'Google Gemini pool',
      1,
      'google',
      '["gemini_ultra"]',
      'standard',
      'passthrough',
      nowIso,
      nowIso,
    )

    const insSchedMember = db.prepare(`
      INSERT INTO scheduler_pool_members (
        pool_id, node_type, node_id, enabled, member_role, weight_tier_override, sub_weight_override,
        member_order, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    insSchedMember.run('pool_alpha', 'claude_vm', 'vm-01', 1, 'active', 8, 20, 0, nowIso, nowIso)
    insSchedMember.run('pool_google', 'gemini_env', 'gemini-alice-1', 1, 'active', 7, 10, 0, nowIso, nowIso)

    const insKeyPoolBinding = db.prepare(
      'INSERT INTO api_key_pool_bindings (api_key_id, pool_id, is_default, created_at) VALUES (?, ?, ?, ?)',
    )
    insKeyPoolBinding.run('key_alice_1', 'pool_alpha', 1, nowIso)

    const insSchedSticky = db.prepare(`
      INSERT INTO scheduler_sticky_bindings (
        scope_kind, pool_id, model_family, identity_id, node_type, node_id, machine_id,
        stood_in, bound_at_ms, last_seen_ms, expires_at_ms, hits, generation
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    insSchedSticky.run(
      'machine',
      'pool_alpha',
      'claude',
      'mach_mock_1',
      'claude_vm',
      'vm-01',
      'mach_mock_1',
      0,
      nowMs - 60_000,
      nowMs,
      nowMs + 604_800_000,
      5,
      1,
    )
    insSchedSticky.run(
      'session',
      'pool_alpha',
      'claude',
      '11111111-1111-4111-8111-111111111111',
      'claude_vm',
      'vm-01',
      'mach_mock_1',
      0,
      nowMs - 30_000,
      nowMs,
      nowMs + 86_400_000,
      2,
      1,
    )

    const insSchedPenalty = db.prepare(`
      INSERT INTO scheduler_node_penalties (
        node_type, node_id, model_scope, reason, cooldown_until_ms, ladder_step, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    insSchedPenalty.run('claude_vm', 'vm-02', 'claude-sonnet-4-5', 'rate_limit_429', nowMs + 120_000, 1, nowIso)

    // 31. usage_logs, 32. request_attempts, 33. request_log_debug
    const insUsage = db.prepare(`
      INSERT INTO usage_logs (
        id, request_id, created_at, log_mode, method, path, protocol, model, stream, status, duration_ms,
        api_key_kind, api_key_id, vm_id, account_id, workspace, input_tokens, output_tokens, error_code, error_message,
        user_agent, ip_address, has_tools, via, cache_read_tokens, cache_creation_tokens, attempt_count, final_state,
        final_account_id, cache_creation_5m_tokens, cache_creation_1h_tokens, requested_model, upstream_model,
        model_mismatch, first_token_ms, stop_reason, input_cost, output_cost, cache_read_cost, cache_creation_cost,
        total_cost, pricing_model, api_key_presented, user_id, group_id, actual_cost, rate_multiplier, service_tier,
        speed, long_context, session_id, reasoning_effort, outbound_session_id, intercept, vm_owner_user_id,
        web_search_requests, web_search_cost, price_source, price_version, inbound_device_id, image_model, image_usage,
        image_input_tokens, image_output_tokens, image_cost, first_byte_ms, generation_ms, jev_state,
        upstream_service_tier, usage_account_id, upstream_status, upstream_400_message
      ) VALUES (${Array(72).fill('?').join(', ')})
    `)
    const insAttempt = db.prepare(`
      INSERT INTO request_attempts (
        request_id, attempt_no, vm_id, account_id, model, selection_reason, started_at, completed_at,
        upstream_status, error_scope, action, cooldown_until, downstream_committed, terminal_state,
        usage_json, wait_ms, ttft_ms, latency_ms, queue_wait_ms, scheduling_ms
      ) VALUES (${Array(20).fill('?').join(', ')})
    `)
    const insDebug = db.prepare('INSERT INTO request_log_debug (request_id, ts, record_json) VALUES (?, ?, ?)')

    const models = ['claude-sonnet-4-5', 'claude-opus-4-5', 'gpt-5.4', 'gpt-image-1']
    const protocols = ['anthropic.messages', 'openai.chat', 'openai.responses', 'openai.images']
    const userIds = ['u_admin', 'u_alice', 'u_bob']
    const keyIds = ['key_admin_1', 'key_alice_1', 'key_bob_api']

    for (let i = 1; i <= usageCount; i += 1) {
      // Spread across last 10 days to populate both hourly and multi-day buckets
      const offsetMs = Math.floor(((i - 1) / Math.max(1, usageCount)) * 10 * dayMs) + (i % 60) * 1000
      const ts = new Date(nowMs - offsetMs).toISOString()
      const mIdx = i % models.length
      const model = models[mIdx]
      const proto = protocols[mIdx]
      const uIdx = i % userIds.length
      const userId = userIds[uIdx]
      const keyId = keyIds[uIdx]
      const vmId = `vm-0${(i % 4) + 1}`
      const acctId = `acct_${(i % 5) + 1}`
      const reqId = `req_mock_${String(i).padStart(5, '0')}`
      const isErr = i % 17 === 0
      const isUp400 = i % 29 === 0
      const isUnpriced = i % 37 === 0
      const status = isUp400 ? 400 : isErr ? 502 : 200
      const inTok = 800 + (i % 50) * 100
      const outTok = 150 + (i % 30) * 40
      const crTok = i % 3 === 0 ? 4000 : 0
      const ccTok = i % 4 === 0 ? 1200 : 0
      const cost = isUnpriced ? null : Math.round((inTok * 3e-6 + outTok * 1.5e-5 + crTok * 3e-7) * 1e6) / 1e6
      const mult = uIdx === 1 ? 1.25 : 1.0
      const actualCost = cost == null ? null : Math.round(cost * mult * 1e6) / 1e6
      const errMsg = i === 17 ? nulBlob('upstream err\x00with nul') : isErr ? 'upstream_timeout' : null

      insUsage.run(
        `log_mock_${String(i).padStart(5, '0')}`,
        reqId,
        ts,
        i <= 40 ? 'debug' : 'normal',
        'POST',
        proto === 'anthropic.messages' ? '/v1/messages' : '/v1/responses',
        proto,
        model,
        i % 2,
        status,
        220 + (i % 1500),
        'managed',
        keyId,
        vmId,
        acctId,
        null,
        inTok,
        outTok,
        isErr ? 'upstream_error' : null,
        errMsg,
        'mock-client/1.0',
        `192.0.2.${(i % 200) + 1}`,
        i % 3 === 0 ? 1 : 0,
        mIdx === 2 ? 'api' : 'rust-kernel',
        crTok,
        ccTok,
        i % 7 === 0 ? 2 : 1,
        isErr ? 'failed' : 'completed',
        acctId,
        ccTok ? Math.floor(ccTok / 2) : null,
        ccTok ? Math.ceil(ccTok / 2) : null,
        model,
        model,
        0,
        85 + (i % 300),
        isErr ? null : 'end_turn',
        cost ? cost * 0.4 : null,
        cost ? cost * 0.4 : null,
        cost ? cost * 0.1 : null,
        cost ? cost * 0.1 : null,
        cost,
        isUnpriced ? null : model,
        null,
        userId,
        uIdx === 1 ? 3 : 1,
        actualCost,
        mult,
        'standard',
        i % 10 === 0 ? 'fast' : null,
        i % 15 === 0 ? 1 : 0,
        `client_sess_${i % 25}`,
        i % 5 === 0 ? 'high' : null,
        `out_sess_${i % 25}`,
        null,
        vmId === 'vm-02' ? 'u_alice' : vmId === 'vm-04' ? 'u_bob' : null,
        i % 11 === 0 ? 2 : 0,
        i % 11 === 0 ? 0.02 : null,
        'catalog',
        'v1',
        `in_dev_${i % 10}`,
        proto === 'openai.images' ? 'gpt-image-1' : null,
        proto === 'openai.images' ? '{"input_tokens":50,"output_tokens":100}' : null,
        proto === 'openai.images' ? 50 : 0,
        proto === 'openai.images' ? 100 : 0,
        proto === 'openai.images' ? 0.04 : null,
        60 + (i % 200),
        150 + (i % 1200),
        null,
        'default',
        acctId,
        isUp400 ? 400 : status,
        isUp400 ? 'invalid_request_error: bad tool' : null,
      )

      const attempts = i % 7 === 0 ? 2 : 1
      for (let a = 1; a <= attempts; a += 1) {
        insAttempt.run(
          reqId,
          a,
          vmId,
          acctId,
          model,
          a === 1 ? 'sticky' : 'failover',
          ts,
          ts,
          a < attempts ? 429 : status,
          a < attempts ? 'account' : null,
          a < attempts ? 'failover' : 'serve',
          a < attempts ? nowMs + 60_000 : null,
          a === attempts ? 1 : 0,
          a === attempts ? 'done' : 'retry',
          JSON.stringify({ input_tokens: inTok, output_tokens: outTok }),
          10,
          80,
          220,
          5,
          3,
        )
      }

      if (i <= 40) {
        if (i === 1) {
          // 1.5 MiB oversized debug payload to exercise byte-budget chunking + TOAST compression
          const bigPad = 'X'.repeat(1_500_000)
          insDebug.run(reqId, ts, JSON.stringify({ request_id: reqId, pad: bigPad, note: 'large_blob_test' }))
        } else if (i === 2) {
          insDebug.run(reqId, ts, nulBlob(`{"request_id":"${reqId}","body":"nul\x00sanitized_debug"}`))
        } else {
          insDebug.run(
            reqId,
            ts,
            JSON.stringify({ request_id: reqId, model, headers: { 'x-test': 'ok' }, emoji: '🔥' }),
          )
        }
      }
    }

    db.exec('COMMIT')

    // Gather exact counts across all tables
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_legacy' ORDER BY name",
      )
      .all()
      .map((r) => r.name)
    const tableCounts = {}
    let totalRows = 0
    for (const t of tables) {
      const c = Number(db.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get().c)
      tableCounts[t] = c
      totalRows += c
    }

    return { sqlitePath: outPath, tableCounts, totalRows, nulEmbeddedCount }
  } finally {
    db.close()
  }
}

function isCliEntry() {
  if (!process.argv[1]) return false
  return (
    path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
  )
}

if (isCliEntry()) {
  const { values } = parseArgs({
    options: {
      out: { type: 'string', default: path.join(process.cwd(), 'data', 'mock-kin.db') },
      'usage-count': { type: 'string', default: '400' },
      json: { type: 'boolean', default: false },
    },
  })
  const res = seedMockSqlite({
    outPath: values.out,
    usageCount: Math.max(20, Number.parseInt(values['usage-count'] || '400', 10) || 400),
  })
  if (values.json) {
    console.log(JSON.stringify(res, null, 2))
  } else {
    const emptyTables = Object.entries(res.tableCounts)
      .filter(([, c]) => c === 0)
      .map(([t]) => t)
    console.log(
      `Seeded ${res.totalRows} rows across ${Object.keys(res.tableCounts).length} tables (${emptyTables.length} empty) -> ${res.sqlitePath}`,
    )
  }
}
