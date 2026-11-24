// 蓝绿迁移护栏：判断新镜像带来的 SQLite 迁移是不是「只加不改」，是的话允许照常蓝绿。
//
// 蓝绿重叠期间，新颜色以 standby 启动时就会执行迁移，旧颜色还在用同一个库服务。
// 只有满足下面条件，旧代码才不受影响，迁移也不会长时间占住写锁：
//   - CREATE TABLE（不能是 AS SELECT）
//   - ALTER TABLE … ADD COLUMN：默认值是常量；NOT NULL 必须带非 NULL 默认值；
//     不带 PRIMARY KEY / UNIQUE / CHECK / REFERENCES / GENERATED / COLLATE（SQLite 加这类列无法执行、要重写，或会在蓝绿重叠期拦住旧颜色写入）
//   - CREATE INDEX：建在本批新建的表上，或建在行数不超过上限的已有表上；
//     UNIQUE 索引只允许建在本批新建的表上
// 其余语句（DROP、RENAME、UPDATE/INSERT/DELETE、触发器、视图、PRAGMA 等）一律视为不安全。
// PostgreSQL 部署不走快速通道：迁移执行器没有 lock_timeout，ADD COLUMN 要等 ACCESS EXCLUSIVE 锁，
// 会排在长查询后面并把旧颜色的请求一起堵住。
//
// bg-deploy.sh 把本文件经 stdin 交给新镜像的一次性容器执行（同一份 compose 配置，能看到同一个库）：
//   BG_MIGRATION_GUARD_CLI=1 node --input-type=module - <新增迁移文件名...>
// 输出一行 JSON；退出码 0 = 只加不改，3 = 需要停机重启，1 = 检查本身出错。

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const DEFAULT_INDEX_MAX_ROWS = 100000

const IDENT = String.raw`(?:"(?:[^"]|"")+"|\x60[^\x60]+\x60|\[[^\]]+\]|[A-Za-z_][\w$]*)`
const QNAME = String.raw`(?:${IDENT}\s*\.\s*)?${IDENT}`

/** 去掉引号和 schema 前缀，统一小写 */
export function normalizeIdent(raw) {
  const last = String(raw)
    .trim()
    .match(new RegExp(`${IDENT}$`))?.[0]
  if (!last) return String(raw).trim().toLowerCase()
  const unquoted =
    last.startsWith('"') || last.startsWith('`') || last.startsWith('[') ? last.slice(1, -1).replace(/""/g, '"') : last
  return unquoted.toLowerCase()
}

/** 去注释、按分号拆语句（跳过引号内的分号和注释符） */
export function splitStatements(sql) {
  const out = []
  let cur = ''
  let i = 0
  const s = String(sql)
  while (i < s.length) {
    const c = s[i]
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1
      while (j < s.length) {
        if (s[j] === c) {
          if (s[j + 1] === c) {
            j += 2
            continue
          }
          break
        }
        j++
      }
      cur += s.slice(i, j + 1)
      i = j + 1
      continue
    }
    if (c === '-' && s[i + 1] === '-') {
      const nl = s.indexOf('\n', i)
      i = nl === -1 ? s.length : nl
      cur += ' '
      continue
    }
    if (c === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2)
      i = end === -1 ? s.length : end + 2
      cur += ' '
      continue
    }
    if (c === ';') {
      if (cur.trim()) out.push(cur.trim().replace(/\s+/g, ' '))
      cur = ''
      i++
      continue
    }
    cur += c
    i++
  }
  if (cur.trim()) out.push(cur.trim().replace(/\s+/g, ' '))
  return out
}

const RE_CREATE_TABLE = new RegExp(String.raw`^CREATE TABLE (?:IF NOT EXISTS )?(${QNAME}) ?\(`, 'i')
const RE_ADD_COLUMN = new RegExp(
  String.raw`^ALTER TABLE (${QNAME}) ADD (?:COLUMN )?(?:IF NOT EXISTS )?(${IDENT})(?: (.*))?$`,
  'i',
)
const RE_CREATE_INDEX = new RegExp(
  String.raw`^CREATE (UNIQUE )?INDEX (?:IF NOT EXISTS )?${QNAME} ON (${QNAME}) ?\(`,
  'i',
)
const RE_LITERAL_DEFAULT = /\bDEFAULT\s+(?:'(?:[^']|'')*'|[+-]?\d+(?:\.\d+)?|NULL|TRUE|FALSE)(?=\s|$)/i

/**
 * 给一条语句分类。
 * @returns {{ kind: 'create_table' | 'add_column' | 'create_index', table: string, unique?: boolean } | { kind: 'unsafe', reason: string }}
 */
export function classifyStatement(stmt) {
  const s = String(stmt).trim().replace(/\s+/g, ' ')
  let m = s.match(RE_CREATE_TABLE)
  if (m) {
    if (/\bAS\s+SELECT\b/i.test(s)) return { kind: 'unsafe', reason: 'CREATE TABLE … AS SELECT' }
    return { kind: 'create_table', table: normalizeIdent(m[1]) }
  }
  m = s.match(RE_ADD_COLUMN)
  if (m) {
    const def = m[3] || ''
    if (/^(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN)$/i.test(m[2]))
      return { kind: 'unsafe', reason: `ADD ${m[2].toUpperCase()}` }
    const defNoStrings = def.replace(/'(?:[^']|'')*'/g, "''")
    const bad = defNoStrings.match(/\b(PRIMARY|UNIQUE|CHECK|REFERENCES|GENERATED|COLLATE|AS)\b/i)
    if (bad) return { kind: 'unsafe', reason: `ADD COLUMN with ${bad[1].toUpperCase()}` }
    const hasDefault = /\bDEFAULT\b/i.test(defNoStrings)
    if (hasDefault && !RE_LITERAL_DEFAULT.test(def))
      return { kind: 'unsafe', reason: 'ADD COLUMN with non-constant DEFAULT' }
    if (/\bNOT\s+NULL\b/i.test(defNoStrings)) {
      if (!hasDefault) return { kind: 'unsafe', reason: 'ADD COLUMN NOT NULL without DEFAULT' }
      if (/\bDEFAULT\s+NULL(?=\s|$)/i.test(defNoStrings))
        return { kind: 'unsafe', reason: 'ADD COLUMN NOT NULL with DEFAULT NULL' }
    }
    return { kind: 'add_column', table: normalizeIdent(m[1]) }
  }
  m = s.match(RE_CREATE_INDEX)
  if (m) return { kind: 'create_index', table: normalizeIdent(m[2]), unique: !!m[1] }
  return { kind: 'unsafe', reason: `statement not allowed: ${s.slice(0, 80)}` }
}

/**
 * 判断一批迁移是否只加不改。
 * @param {{ engine: 'sqlite' | 'postgres', files: { name: string, sql: string }[], rowCount?: (table: string, limit: number) => number, tableExists?: (table: string) => boolean, indexMaxRows?: number }} opts
 */
export function checkAdditive({
  engine,
  files,
  rowCount = () => Infinity,
  tableExists = () => true,
  indexMaxRows = DEFAULT_INDEX_MAX_ROWS,
}) {
  if (!Number.isSafeInteger(indexMaxRows) || !Number.isSafeInteger(indexMaxRows + 1) || indexMaxRows < 0) {
    throw new RangeError(`invalid indexMaxRows: ${indexMaxRows}`)
  }
  if (engine !== 'sqlite') {
    return {
      additive: false,
      engine,
      reasons: ['postgres deployments always restart: the migration runner sets no lock_timeout'],
      files: [],
    }
  }
  const created = new Set()
  const counted = new Map()
  const reasons = []
  const report = []
  for (const file of files) {
    const fileReasons = []
    for (const stmt of splitStatements(file.sql)) {
      const c = classifyStatement(stmt)
      if (c.kind === 'unsafe') {
        fileReasons.push(c.reason)
        continue
      }
      if (c.kind === 'create_table') {
        if (!created.has(c.table) && !tableExists(c.table)) created.add(c.table)
        continue
      }
      if (c.kind === 'add_column') continue
      // CREATE INDEX：本批新建的表直接放行；已有表不能建 UNIQUE，普通索引按行数上限放行
      if (created.has(c.table)) continue
      if (c.unique) {
        fileReasons.push(`UNIQUE INDEX on existing table ${c.table}`)
        continue
      }
      if (!counted.has(c.table)) counted.set(c.table, rowCount(c.table, indexMaxRows))
      const n = counted.get(c.table)
      if (!(n <= indexMaxRows)) fileReasons.push(`INDEX on ${c.table} with more than ${indexMaxRows} rows`)
    }
    report.push({ name: file.name, additive: fileReasons.length === 0, reasons: fileReasons })
    for (const r of fileReasons) reasons.push(`${file.name}: ${r}`)
  }
  return { additive: reasons.length === 0, engine, reasons, files: report }
}

function envGetFile(name, file) {
  if (!fs.existsSync(file)) return ''
  const prefix = `${name}=`
  let found = ''
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.startsWith(prefix)) found = line.slice(prefix.length)
  }
  return found.replace(/['"\r]/g, '')
}

export async function resolveEngine(root, env = process.env) {
  const configPath = path.join(root, 'src/lib/db/pg/config.mjs')
  if (!fs.existsSync(configPath)) return 'sqlite' // 1.4.192 之前只有 SQLite
  const { resolveDbDriver } = await import(pathToFileURL(configPath).href)
  const rawDriver = env.VM2API_DB_DRIVER || 'auto'
  const envFile = path.join(root, '.env')
  // 与 scripts/docker-entrypoint.sh 的旧 SQLite 升级回退保持一致：
  // 已有 data/kin.db 且 env/.env 都未显式配置 PG 时，保持 SQLite（忽略 compose 默认的 DATABASE_HOST）
  if (
    rawDriver === 'auto' &&
    fs.existsSync(path.join(root, 'data/kin.db')) &&
    !env.DATABASE_URL &&
    !env.VM2API_DATABASE_URL &&
    !envGetFile('VM2API_DB_DRIVER', envFile) &&
    !envGetFile('DATABASE_URL', envFile) &&
    !envGetFile('VM2API_DATABASE_URL', envFile)
  ) {
    return resolveDbDriver({ env: { ...env, VM2API_DB_DRIVER: 'sqlite' } })
  }
  return resolveDbDriver({ env })
}

function parseIndexMaxRows(raw) {
  if (raw === undefined || raw === '') return DEFAULT_INDEX_MAX_ROWS
  if (String(raw).trim() === '') throw new Error(`invalid BG_MIGRATION_INDEX_MAX_ROWS: ${raw}`)
  const n = Number(raw)
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(n + 1) || n < 0) {
    throw new Error(`invalid BG_MIGRATION_INDEX_MAX_ROWS: ${raw}`)
  }
  return n
}

async function main() {
  const root = process.env.BG_PROJECT_ROOT || '/opt/vm2api'
  const sqliteDir = path.join(root, 'src/lib/db/migrations')
  const indexMaxRows = parseIndexMaxRows(process.env.BG_MIGRATION_INDEX_MAX_ROWS)
  const engine = await resolveEngine(root)
  const names = process.argv.slice(2).filter((n) => /^\d+.*\.sql$/.test(n))
  // 只看本部署实际会执行的目录；另一种引擎的迁移不会跑
  const files = names
    .filter((n) => fs.existsSync(path.join(sqliteDir, n)))
    .map((name) => ({ name, sql: fs.readFileSync(path.join(sqliteDir, name), 'utf8') }))
  const { DatabaseSync } = await import('node:sqlite')
  let db = null
  const getDb = () => {
    if (!db) {
      const dataDir = process.env.KIN_DATA_DIR || path.join(root, 'data')
      const dbPath = process.env.KIN_DB_PATH || path.join(dataDir, 'kin.db')
      if (!fs.existsSync(dbPath)) throw new Error(`sqlite database not found: ${dbPath}`)
      db = new DatabaseSync(dbPath, { readOnly: true })
    }
    return db
  }
  const lookupTable = (table) =>
    getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND lower(name) = ?").get(table)
  const tableExists = (table) => Boolean(lookupTable(table))
  const rowCount = (table, limit) => {
    const row = lookupTable(table)
    if (!row) return 0
    const q = `SELECT COUNT(*) AS n FROM (SELECT 1 FROM "${row.name.replace(/"/g, '""')}" LIMIT ${limit + 1})`
    return Number(getDb().prepare(q).get().n)
  }
  try {
    if (engine === 'sqlite' && files.length > 0) getDb()
    const verdict = checkAdditive({ engine, files, rowCount, tableExists, indexMaxRows })
    verdict.ignored = names.filter((n) => !files.some((f) => f.name === n))
    process.stdout.write(`${JSON.stringify(verdict)}\n`)
    process.exitCode = verdict.additive ? 0 : 3
  } finally {
    db?.close()
  }
}

if (process.env.BG_MIGRATION_GUARD_CLI === '1') {
  main().catch((e) => {
    process.stdout.write(`${JSON.stringify({ additive: false, error: String(e?.message || e) })}\n`)
    process.exitCode = 1
  })
}
