#!/usr/bin/env node
// Billing contract audit: web consumers vs backend producers, cost basis per aggregation,
// and (optional) usage_logs data checks.
//   node scripts/audit-billing-contract.mjs [path/to/kin.db] [--json]
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const args = process.argv.slice(2)
const asJson = args.includes('--json')
const dbPath = args.find((a) => !a.startsWith('--'))

function walk(dir, exts, skip = /node_modules|dist|\.test\.|routeTree\.gen/) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (skip.test(p)) continue
    const st = statSync(p)
    if (st.isDirectory()) out.push(...walk(p, exts, skip))
    else if (exts.some((e) => p.endsWith(e))) out.push(p)
  }
  return out
}
const rel = (p) => relative(ROOT, p)

// Billing-shaped identifiers: *_cost, *_usd, cost/tokens families, window buckets, pricing meta.
const FIELD_RE =
  /\b([a-z][a-z0-9]*(?:_[a-z0-9]+)*_(?:cost|usd)|(?:today|window_5h|window_7d)_[a-z0-9_]+|tokens_(?:in|out)|pricing_[a-z_]+|service_tier|rate_multiplier|actual_cost|total_cost|cost_usd)\b/g

function collect(files) {
  const map = new Map()
  for (const f of files) {
    const lines = readFileSync(f, 'utf8').split('\n')
    lines.forEach((line, i) => {
      for (const m of line.matchAll(FIELD_RE)) {
        const k = m[1]
        if (!map.has(k)) map.set(k, [])
        map.get(k).push(`${rel(f)}:${i + 1}`)
      }
    })
  }
  return map
}

const PAGE_DIRS = [
  'web/src/features/overview',
  'web/src/features/vm',
  'web/src/features/billing',
  'web/src/lib',
  'web/src/types',
]
const webFiles = PAGE_DIRS.flatMap((d) => walk(join(ROOT, d), ['.ts', '.tsx']))
const srcFiles = walk(join(ROOT, 'src/lib'), ['.mjs'])
const web = collect(webFiles)
const src = collect(srcFiles)

// 1) consumed by web, never produced by backend -> stale/legacy param
const stale = [...web.keys()].filter((k) => !src.has(k)).sort()
// 2) produced by panel payload builders, never read by these pages
const PAYLOAD_FILES = /panel-api\.mjs|usage-logs-repo\.mjs/
const unused = [...src.entries()]
  .filter(([k, locs]) => locs.some((l) => PAYLOAD_FILES.test(l)) && !web.has(k))
  .map(([k]) => k)
  .sort()

// 3) cost basis per aggregation SQL (total_cost = official list price, actual_cost = rate-multiplied)
const repo = readFileSync(join(ROOT, 'src/lib/db/repos/usage-logs-repo.mjs'), 'utf8')
const basis = []
const methodRe = /^ {2}(_?[a-zA-Z]+)\([^)]*\)\s*\{/gm
const starts = [...repo.matchAll(methodRe)].map((m) => ({ name: m[1], at: m.index }))
starts.forEach((s, i) => {
  const body = repo.slice(s.at, starts[i + 1]?.at ?? repo.length)
  if (!/SUM\(/.test(body)) return
  const usesActual = /SUM\(COALESCE\(actual_cost/.test(body) || /SUM\(actual_cost/.test(body)
  const usesTotal = /SUM\(total_cost\)/.test(body)
  if (usesActual || usesTotal)
    basis.push({ method: s.name, basis: usesActual && usesTotal ? 'mixed' : usesActual ? 'actual_cost' : 'total_cost' })
})
const API_OF = {
  ownerBilling: '/api/panel/billing (Overview 分拆 Claude/GPT, 计费页)',
  billingStats: '/api/panel/dashboard, /vms, /vms/:id, /usage (今日/总计/5h/7d)',
  costByAccount: '同上 (按账号)',
  costByModel: '/api/panel/vms/:id billing.by_model',
  aggregate: '/api/panel/usage 趋势图',
  totals: 'ops 总览',
}

const strip = readFileSync(join(ROOT, 'web/src/features/overview/billing-strip.tsx'), 'utf8')
const stripUsesActual = /item\.cost_usd/.test(strip)

// 4) backfill must re-price with the stored tier/speed and never touch deliberately unpriced rows
const bf = repo.match(/backfillMissingCosts[\s\S]*?SELECT([\s\S]*?)FROM usage_logs([\s\S]*?)LIMIT/)
const backfillLosesContext = !bf || !/service_tier/.test(bf[1]) || !/speed/.test(bf[1])
const backfillRepricesUnpriced = !bf || !/pricing_model IS NULL/.test(bf[2])

// 5) optional DB checks
let db = null
if (dbPath) {
  if (!existsSync(dbPath)) {
    console.error(`db not found: ${dbPath}`)
    process.exit(2)
  }
  const { DatabaseSync } = await import('node:sqlite')
  const d = new DatabaseSync(dbPath, { readOnly: true })
  const colNames = d
    .prepare("SELECT name FROM pragma_table_info('usage_logs')")
    .all()
    .map((r) => r.name)
  const q = (sql) => d.prepare(sql).all()
  db = {
    has_service_tier_col: colNames.includes('service_tier'),
    has_speed_col: colNames.includes('speed'),
    unpriced_rows: q("SELECT COUNT(*) n FROM usage_logs WHERE pricing_model = 'unpriced'")[0],
    band_distribution: colNames.includes('service_tier')
      ? q(`SELECT service_tier, speed, long_context, COUNT(*) n, ROUND(SUM(COALESCE(total_cost,0)),4) cost
          FROM usage_logs GROUP BY 1, 2, 3 ORDER BY 4 DESC LIMIT 30`)
      : null,
    totals: q(`SELECT COUNT(*) n,
        SUM(total_cost IS NULL) null_total,
        SUM(actual_cost IS NULL AND total_cost IS NOT NULL) null_actual,
        ROUND(SUM(COALESCE(total_cost,0)),4) sum_total,
        ROUND(SUM(COALESCE(actual_cost,total_cost,0)),4) sum_actual,
        SUM(COALESCE(rate_multiplier,1) <> 1) rated_rows
      FROM usage_logs`)[0],
    unpriced_with_tokens: q(`SELECT COALESCE(upstream_model,model,requested_model) m, COUNT(*) n
        FROM usage_logs WHERE (total_cost IS NULL OR total_cost = 0)
          AND COALESCE(input_tokens,0)+COALESCE(output_tokens,0) > 0
        GROUP BY 1 ORDER BY 2 DESC LIMIT 20`),
    pricing_model: q(`SELECT pricing_model, COUNT(*) n, ROUND(SUM(total_cost),4) cost
        FROM usage_logs GROUP BY 1 ORDER BY 2 DESC LIMIT 30`),
    long_context_candidates: q(`SELECT pricing_model, COUNT(*) n FROM usage_logs
        WHERE COALESCE(input_tokens,0)+COALESCE(cache_read_tokens,0)+COALESCE(cache_creation_tokens,0) > 200000
        GROUP BY 1 ORDER BY 2 DESC`),
    total_vs_parts_mismatch: q(`SELECT COUNT(*) n FROM usage_logs WHERE total_cost IS NOT NULL
        AND ABS(total_cost - (COALESCE(input_cost,0)+COALESCE(output_cost,0)+COALESCE(cache_read_cost,0)+COALESCE(cache_creation_cost,0))) > 1e-6`)[0],
  }
}

const report = {
  stale_web_fields: stale.map((k) => ({ field: k, used_at: web.get(k) })),
  unused_backend_fields: unused,
  cost_basis: basis.map((b) => ({ ...b, api: API_OF[b.method] || '' })),
  // Overview mixes the strip's today/total (total_cost) with its Claude/GPT split; flag only if the split reads cost_usd.
  mixed_cost_basis: stripUsesActual,
  backfill_loses_tier_speed: backfillLosesContext,
  backfill_reprices_unpriced: backfillRepricesUnpriced,
  db,
}

if (asJson) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log('== 1. 前端在读、后端已不产出的字段（旧参数） ==')
  if (!stale.length) console.log('  无')
  for (const s of report.stale_web_fields) console.log(`  ${s.field}\n    ${s.used_at.slice(0, 6).join('\n    ')}`)
  console.log('\n== 2. 后端产出、这三类页面没读的字段 ==')
  console.log('  ' + (unused.join(', ') || '无'))
  console.log('\n== 3. 费用口径（total_cost=官方原价, actual_cost=乘倍率） ==')
  for (const b of report.cost_basis) console.log(`  ${b.method.padEnd(16)} ${b.basis.padEnd(12)} ${b.api}`)
  console.log(
    report.mixed_cost_basis
      ? '  !! Overview 计费卡口径不一致：今日/累计是官方价，Claude/GPT 分拆读的是乘倍率的 cost_usd'
      : '  ok: Overview 计费卡统一用官方价（Claude/GPT 分拆读 official_cost_usd）',
  )
  console.log('\n== 4. 补算 ==')
  if (backfillLosesContext) console.log('  !! backfillMissingCosts 不读 service_tier/speed，会按标准价重算')
  if (backfillRepricesUnpriced)
    console.log("  !! backfillMissingCosts 不跳过 pricing_model='unpriced'，刻意不估价的行会被补价")
  if (!backfillLosesContext && !backfillRepricesUnpriced) console.log('  ok')
  if (db) {
    console.log('\n== 5. DB ==')
    console.log(JSON.stringify(db, null, 2))
  } else console.log('\n(未给 DB 路径，跳过数据检查)')
}
