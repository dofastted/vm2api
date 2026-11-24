/**
 * SQLite-to-PostgreSQL SQL dialect compatibility layer.
 *
 * Keeps all 23 existing repository modules as a single source of truth (SSOT)
 * across both SQLite (isolated unit tests / legacy mode) and PostgreSQL
 * (production). Translations are deterministic and LRU-cached.
 */

const CACHE_MAX = 1024
const translateCache = new Map()

const SERIAL_PK_TABLES = new Set([
  'groups',
  'account_allocations',
  'redeem_codes',
  'request_attempts',
  'scheduler_outbox',
  'auth_cache_invalidation_outbox',
])

const NOOP_PRAGMAS =
  /^\s*PRAGMA\s+(journal_mode|synchronous|busy_timeout|foreign_keys|wal_checkpoint|optimize|query_only|cache_size|temp_store)\b/i
const READ_SYNC_PRAGMA = /^\s*PRAGMA\s+synchronous\s*;?\s*$/i
const TABLE_INFO_PRAGMA = /^\s*PRAGMA\s+table_info\s*\(\s*["'`]?([a-zA-Z_][a-zA-Z0-9_]*)["'`]?\s*\)\s*;?\s*$/i
const SQLITE_MASTER_TABLES = /^\s*SELECT\s+name\s+FROM\s+sqlite_master\s+WHERE\s+type\s*=\s*'table'\s*;?\s*$/i

/**
 * Scan SQL outside single-quoted strings, double-quoted identifiers, and comments.
 * Invokes `onText(segment)` for code segments and preserves literals/comments verbatim.
 */
function mapOutsideLiterals(sql, transformCode) {
  let out = ''
  let codeStart = 0
  let i = 0
  const n = sql.length

  const flushCode = (end) => {
    if (end > codeStart) {
      out += transformCode(sql.slice(codeStart, end))
    }
  }

  while (i < n) {
    const ch = sql[i]
    const next = sql[i + 1]

    // Single-quoted string literal ('...' with '' escapes)
    if (ch === "'") {
      flushCode(i)
      const start = i
      i += 1
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2
            continue
          }
          i += 1
          break
        }
        i += 1
      }
      out += sql.slice(start, i)
      codeStart = i
      continue
    }

    // Double-quoted identifier ("..." with "" escapes)
    if (ch === '"') {
      flushCode(i)
      const start = i
      i += 1
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            i += 2
            continue
          }
          i += 1
          break
        }
        i += 1
      }
      out += sql.slice(start, i)
      codeStart = i
      continue
    }

    // Line comment (-- ... \n)
    if (ch === '-' && next === '-') {
      flushCode(i)
      const start = i
      i += 2
      while (i < n && sql[i] !== '\n') i += 1
      out += sql.slice(start, i)
      codeStart = i
      continue
    }

    // Block comment (/* ... */)
    if (ch === '/' && next === '*') {
      flushCode(i)
      const start = i
      i += 2
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1
      if (i < n) i += 2
      out += sql.slice(start, i)
      codeStart = i
      continue
    }

    i += 1
  }

  flushCode(n)
  return out
}

/** Find matching closing parenthesis starting from index of '('. */
function findMatchingParen(sql, openIdx) {
  let depth = 0
  let i = openIdx
  const n = sql.length
  while (i < n) {
    const ch = sql[i]
    const next = sql[i + 1]
    if (ch === "'") {
      i += 1
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2
            continue
          }
          i += 1
          break
        }
        i += 1
      }
      continue
    }
    if (ch === '"') {
      i += 1
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            i += 2
            continue
          }
          i += 1
          break
        }
        i += 1
      }
      continue
    }
    if (ch === '-' && next === '-') {
      while (i < n && sql[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1
      if (i < n) i += 2
      continue
    }
    if (ch === '(') depth += 1
    else if (ch === ')') {
      depth -= 1
      if (depth === 0) return i
    }
    i += 1
  }
  return -1
}

/** Split a function argument list at top-level commas (respecting strings & parens). */
function splitTopLevelArgs(inner) {
  const args = []
  let depth = 0
  let start = 0
  let i = 0
  const n = inner.length
  while (i < n) {
    const ch = inner[i]
    if (ch === "'") {
      i += 1
      while (i < n) {
        if (inner[i] === "'") {
          if (inner[i + 1] === "'") {
            i += 2
            continue
          }
          i += 1
          break
        }
        i += 1
      }
      continue
    }
    if (ch === '"') {
      i += 1
      while (i < n) {
        if (inner[i] === '"') {
          if (inner[i + 1] === '"') {
            i += 2
            continue
          }
          i += 1
          break
        }
        i += 1
      }
      continue
    }
    if (ch === '(') depth += 1
    else if (ch === ')') depth -= 1
    else if (ch === ',' && depth === 0) {
      args.push(inner.slice(start, i).trim())
      start = i + 1
    }
    i += 1
  }
  const tail = inner.slice(start).trim()
  if (tail || args.length) args.push(tail)
  return args
}

/** Rewrite calls to `fnName(...)` using a custom replacer(args) -> string | null. */
function rewriteFunctionCalls(sql, fnName, replacer) {
  const regex = new RegExp(`\\b${fnName}\\s*\\(`, 'gi')
  let result = ''
  let lastIdx = 0
  let i = 0
  const n = sql.length

  while (i < n) {
    const ch = sql[i]
    const next = sql[i + 1]
    if (ch === "'") {
      i += 1
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2
            continue
          }
          i += 1
          break
        }
        i += 1
      }
      continue
    }
    if (ch === '"') {
      i += 1
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            i += 2
            continue
          }
          i += 1
          break
        }
        i += 1
      }
      continue
    }
    if (ch === '-' && next === '-') {
      while (i < n && sql[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1
      if (i < n) i += 2
      continue
    }

    regex.lastIndex = i
    const match = regex.exec(sql)
    if (match && match.index === i) {
      const openIdx = i + match[0].length - 1
      const closeIdx = findMatchingParen(sql, openIdx)
      if (closeIdx > openIdx) {
        const inner = sql.slice(openIdx + 1, closeIdx)
        const args = splitTopLevelArgs(inner)
        const replacement = replacer(args, inner)
        if (replacement != null) {
          result += sql.slice(lastIdx, i) + replacement
          lastIdx = closeIdx + 1
          i = closeIdx + 1
          continue
        }
      }
    }
    i += 1
  }

  result += sql.slice(lastIdx)
  return result
}

function replacePositionalPlaceholders(sql) {
  let idx = 0
  return mapOutsideLiterals(sql, (seg) => seg.replace(/\?/g, () => `$${++idx}`))
}

function rewriteInsertOrIgnore(sql) {
  if (!/^\s*INSERT\s+OR\s+IGNORE\s+INTO\b/i.test(sql)) return sql
  let rewritten = sql.replace(/^\s*INSERT\s+OR\s+IGNORE\s+INTO\b/i, 'INSERT INTO')
  if (!/\bON\s+CONFLICT\b/i.test(rewritten)) {
    const trimmed = rewritten.trimEnd()
    const hasSemi = trimmed.endsWith(';')
    const body = hasSemi ? trimmed.slice(0, -1).trimEnd() : trimmed
    rewritten = `${body} ON CONFLICT DO NOTHING${hasSemi ? ';' : ''}`
  }
  return rewritten
}

function rewriteStrftime(sql) {
  if (!/\bstrftime\s*\(/i.test(sql)) return sql
  return rewriteFunctionCalls(sql, 'strftime', (args) => {
    if (args.length < 2) return null
    const fmt = args[0].trim()
    const expr = args[1].trim()
    const mod = args[2] ? args[2].trim() : null

    if (expr.toLowerCase() === "'now'") {
      return `to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
    }

    if (fmt === "'%Y-%m-%dT%H:00'" && !mod) {
      return `(substr(${expr}, 1, 13) || ':00')`
    }
    if (fmt === "'%Y-%m-%dT%H:%M'" && !mod) {
      return `substr(${expr}, 1, 16)`
    }
    if (fmt === "'%Y-%m-%d'" && !mod) {
      return `substr(${expr}, 1, 10)`
    }
    if (fmt === "'%Y-%m-%d'" && mod) {
      const m = mod.match(/^'([+-]?\d+)\s+(hours?|minutes?|days?)'$/i)
      if (m) {
        const amount = m[1]
        const unit = m[2].toLowerCase()
        if (amount === '+8' && unit.startsWith('hour')) {
          return `to_char((${expr})::timestamptz AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD')`
        }
        return `to_char(((${expr})::timestamptz AT TIME ZONE 'UTC') + interval '${amount} ${unit}', 'YYYY-MM-DD')`
      }
    }
    return null
  })
}

function rewritePrintf(sql) {
  if (!/\bprintf\s*\(/i.test(sql)) return sql
  return rewriteFunctionCalls(sql, 'printf', (args) => {
    if (args.length !== 2) return null
    const fmt = args[0].trim()
    const expr = args[1].trim()
    const m = fmt.match(/^'%0(\d+)d'$/)
    if (m) {
      return `lpad((${expr})::text, ${Number(m[1])}, '0')`
    }
    return null
  })
}

function rewriteScalarMaxMin(sql) {
  let out = sql
  if (/\bMAX\s*\(/i.test(out)) {
    out = rewriteFunctionCalls(out, 'MAX', (args) => {
      if (args.length === 2) return `GREATEST(${args[0]}, ${args[1]})`
      return null
    })
  }
  if (/\bMIN\s*\(/i.test(out)) {
    out = rewriteFunctionCalls(out, 'MIN', (args) => {
      if (args.length === 2) return `LEAST(${args[0]}, ${args[1]})`
      return null
    })
  }
  return out
}

function rewriteJsonEach(sql) {
  if (!/\bjson_each\s*\(/i.test(sql)) return sql
  return rewriteFunctionCalls(sql, 'json_each', (args) => {
    if (args.length !== 1) return null
    return `jsonb_array_elements_text((${args[0]})::jsonb) AS _je(value)`
  })
}

function rewriteCollateNocase(sql) {
  if (!/\bCOLLATE\s+NOCASE\b/i.test(sql)) return sql
  let out = mapOutsideLiterals(sql, (seg) =>
    seg.replace(/(\b[a-zA-Z_][a-zA-Z0-9_.]*)\s*=\s*(\$\d+)\s+COLLATE\s+NOCASE\b/gi, 'LOWER($1) = LOWER($2)'),
  )
  out = mapOutsideLiterals(out, (seg) => seg.replace(/\s*\bCOLLATE\s+NOCASE\b/gi, ''))
  return out
}

function rewriteIfNull(sql) {
  if (!/\bIFNULL\s*\(/i.test(sql)) return sql
  return mapOutsideLiterals(sql, (seg) => seg.replace(/\bIFNULL\s*\(/gi, 'COALESCE('))
}

function rewriteTransactionStatements(sql) {
  if (/^\s*BEGIN\s+(IMMEDIATE|DEFERRED|EXCLUSIVE)\s*;?\s*$/i.test(sql)) {
    return 'BEGIN'
  }
  return sql
}

function rewriteThinkingOwnersDdl(sql) {
  if (!/\bCREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+thinking_signature_owners\b/i.test(sql)) return sql
  return sql.replace(/\bcreated_at\s+INTEGER\s+NOT\s+NULL\b/i, 'created_at BIGINT NOT NULL')
}

/**
 * Check if SQL is a SQLite-only PRAGMA or metadata query that needs special handling.
 * Returns null for normal SQL, or a descriptor object.
 */
export function inspectSpecialSqliteSql(sql) {
  if (READ_SYNC_PRAGMA.test(sql)) {
    return { kind: 'static', rows: [{ synchronous: 2 }] }
  }
  const tableInfo = sql.match(TABLE_INFO_PRAGMA)
  if (tableInfo) {
    const tbl = tableInfo[1].toLowerCase()
    return {
      kind: 'rewrite',
      sql: `SELECT column_name AS name, data_type AS type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = '${tbl}' ORDER BY ordinal_position`,
    }
  }
  if (SQLITE_MASTER_TABLES.test(sql)) {
    return {
      kind: 'rewrite',
      sql: `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`,
    }
  }
  if (NOOP_PRAGMAS.test(sql)) {
    return { kind: 'noop' }
  }
  return null
}

/**
 * Translate a SQLite SQL statement into PostgreSQL SQL.
 * @param {string} rawSql
 * @param {{ returningId?: boolean }} [opts]
 * @returns {{ sql: string, special: object|null, hasReturningId: boolean }}
 */
export function translateSqliteToPg(rawSql, { returningId = false } = {}) {
  const key = `${returningId ? 'R:' : 'N:'}${rawSql}`
  const cached = translateCache.get(key)
  if (cached) return cached

  const special = inspectSpecialSqliteSql(rawSql)
  if (special?.kind === 'static' || special?.kind === 'noop') {
    const res = { sql: rawSql, special, hasReturningId: false }
    cacheSet(key, res)
    return res
  }

  let sql = special?.kind === 'rewrite' ? special.sql : rawSql
  sql = rewriteTransactionStatements(sql)
  sql = rewriteThinkingOwnersDdl(sql)
  sql = rewriteInsertOrIgnore(sql)
  sql = rewriteIfNull(sql)
  sql = replacePositionalPlaceholders(sql)
  sql = rewriteJsonEach(sql)
  sql = rewriteScalarMaxMin(sql)
  sql = rewriteStrftime(sql)
  sql = rewritePrintf(sql)
  sql = rewriteCollateNocase(sql)

  let hasReturningId = false
  if (
    returningId &&
    /^\s*INSERT\s+INTO\s+["`]?([a-zA-Z_][a-zA-Z0-9_]*)["`]?/i.test(sql) &&
    !/\bRETURNING\b/i.test(sql)
  ) {
    const m = sql.match(/^\s*INSERT\s+INTO\s+["`]?([a-zA-Z_][a-zA-Z0-9_]*)["`]?/i)
    if (m && SERIAL_PK_TABLES.has(m[1].toLowerCase())) {
      const trimmed = sql.trimEnd()
      const hasSemi = trimmed.endsWith(';')
      const body = hasSemi ? trimmed.slice(0, -1).trimEnd() : trimmed
      sql = `${body} RETURNING id${hasSemi ? ';' : ''}`
      hasReturningId = true
    }
  }

  const res = { sql, special: null, hasReturningId }
  cacheSet(key, res)
  return res
}

function cacheSet(key, val) {
  if (translateCache.size >= CACHE_MAX) {
    const oldest = translateCache.keys().next().value
    translateCache.delete(oldest)
  }
  translateCache.set(key, val)
}

/**
 * Sanitize parameters for PostgreSQL UTF-8 TEXT/JSONB compatibility.
 * Strips NUL bytes (\u0000) which PostgreSQL rejects in UTF-8 strings and
 * normalizes `undefined` to `null`.
 */
export function sanitizePgParams(params) {
  if (!Array.isArray(params) || params.length === 0) return []
  return params.map((v) => {
    if (v === undefined) return null
    if (typeof v === 'bigint') return v.toString()
    if (typeof v === 'string' && v.includes('\u0000')) {
      return v.replaceAll('\u0000', '')
    }
    return v
  })
}

/** Detect table names modified by INSERT / UPDATE / DELETE SQL for cache invalidation. */
export function detectMutatedTables(sql) {
  if (typeof sql !== 'string') return []
  const tables = new Set()
  const patterns = [
    /\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+["`]?([a-zA-Z_][a-zA-Z0-9_]*)["`]?/gi,
    /\bUPDATE\s+["`]?([a-zA-Z_][a-zA-Z0-9_]*)["`]?/gi,
    /\bDELETE\s+FROM\s+["`]?([a-zA-Z_][a-zA-Z0-9_]*)["`]?/gi,
  ]
  for (const re of patterns) {
    let m
    while ((m = re.exec(sql)) !== null) {
      tables.add(m[1].toLowerCase())
    }
  }
  return [...tables]
}

/** True when an error is a unique/constraint violation on either SQLite or PostgreSQL. */
export function isUniqueConstraintError(err) {
  if (!err) return false
  const code = String(err.code || err.pgCode || '')
  if (code === '23505' || code.startsWith('SQLITE_CONSTRAINT')) return true
  return /duplicate key value violates unique constraint|UNIQUE constraint failed/i.test(String(err.message || ''))
}

/** True when an error is a PostgreSQL constraint violation (unique, check, fk, not-null). */
export function isConstraintError(err) {
  if (!err) return false
  const code = String(err.code || err.pgCode || '')
  if (/^23(505|503|502|514|000)$/.test(code) || code.startsWith('SQLITE_CONSTRAINT')) return true
  return /violates (unique|check|foreign key|not-null) constraint|constraint failed/i.test(String(err.message || ''))
}

/** Split multi-statement SQL script on top-level semicolons (ignoring strings/comments/$$ blocks). */
export function splitSqlStatements(sql) {
  const statements = []
  let start = 0
  let i = 0
  const n = sql.length
  let dollarTag = null

  while (i < n) {
    const ch = sql[i]
    const next = sql[i + 1]

    if (dollarTag) {
      if (sql.startsWith(dollarTag, i)) {
        i += dollarTag.length
        dollarTag = null
        continue
      }
      i += 1
      continue
    }

    if (ch === "'") {
      i += 1
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2
            continue
          }
          i += 1
          break
        }
        i += 1
      }
      continue
    }

    if (ch === '"') {
      i += 1
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            i += 2
            continue
          }
          i += 1
          break
        }
        i += 1
      }
      continue
    }

    if (ch === '-' && next === '-') {
      while (i < n && sql[i] !== '\n') i += 1
      continue
    }

    if (ch === '/' && next === '*') {
      i += 2
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1
      if (i < n) i += 2
      continue
    }

    if (ch === '$') {
      const m = sql.slice(i).match(/^\$[a-zA-Z_]*\$/)
      if (m) {
        dollarTag = m[0]
        i += dollarTag.length
        continue
      }
    }

    if (ch === ';') {
      const stmt = sql.slice(start, i).trim()
      if (stmt) statements.push(stmt)
      start = i + 1
    }

    i += 1
  }

  const tail = sql.slice(start).trim()
  if (tail) statements.push(tail)
  return statements
}
