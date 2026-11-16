/** Pull the matched word out of a stored block message. */
export function keywordFromBlockMessage(message) {
  const text = String(message || '').trim()
  if (!text) return ''
  const marker = '请求被协议拦截:'
  const at = text.indexOf(marker)
  const rest = (at >= 0 ? text.slice(at + marker.length) : text.slice(text.lastIndexOf(':') + 1)).trim()
  const parts = rest
    .split(':')
    .map((part) => part.trim())
    .filter(Boolean)
  return (parts[parts.length - 1] || rest).slice(0, 40)
}

/** Group block rows by the word that fired, highest count first. */
export function collapseBlockKeywords(rows) {
  const counts = new Map()
  for (const row of rows || []) {
    const keyword = keywordFromBlockMessage(row?.message)
    if (!keyword) continue
    counts.set(keyword, (counts.get(keyword) || 0) + Number(row.count || 0))
  }
  return [...counts.entries()]
    .map(([keyword, count]) => ({ keyword, count }))
    .sort((a, b) => b.count - a.count || a.keyword.localeCompare(b.keyword))
    .slice(0, 20)
}

const BLOCK_LABEL = {
  'hard-regex': '硬正则',
  jev: 'Jev 模型',
  distill: '蒸馏',
  refusal: '拒答缓存',
}

const PASS_LABEL = {
  jev: 'Jev 模型放行',
  regex: '正则未命中',
  'fail-open': '模型故障放行',
  unchecked: '未检查',
  platform: 'OpenAI 平台未接入',
  scope: '账号不在范围',
  'scope-wait': '等待账号判定',
  unknown: '未记录',
}

/** Short JSON stored on usage_logs.intercept. */
export function gateVerdict(fields = {}) {
  return JSON.stringify({
    kind: fields.kind === 'pass' ? 'pass' : 'block',
    by: String(fields.by || '').slice(0, 40),
    keyword: String(fields.keyword || '').slice(0, 40),
    rule: String(fields.rule || '').slice(0, 120),
    ...(fields.route ? { route: fields.route } : {}),
  })
}

function parseVerdict(raw) {
  if (!raw) return null
  try {
    const data = JSON.parse(raw)
    if (!data || (data.kind !== 'block' && data.kind !== 'pass')) return null
    return data
  } catch {
    return null
  }
}

function legacyVerdict(row) {
  if (Number(row?.blocked)) {
    const via = String(row.via || '')
    const by =
      via === 'hard-regex'
        ? 'hard-regex'
        : via === 'jev'
          ? 'jev'
          : via === 'distill-detect'
            ? 'distill'
            : via === 'refusal-guard'
              ? 'refusal'
              : 'hard-regex'
    return { kind: 'block', by, keyword: keywordFromBlockMessage(row.message), rule: '' }
  }
  return { kind: 'pass', by: 'unknown', keyword: '', rule: '' }
}

/** Turn grouped log rows into block rules and pass reasons. */
export function foldInterceptRows(rows) {
  const blocks = new Map()
  const passes = new Map()
  let blocked = 0
  let passed = 0
  const routes = new Map()
  for (const row of rows || []) {
    const count = Number(row?.count || 0)
    if (!count) continue
    const verdict = parseVerdict(row.intercept) || legacyVerdict(row)
    if (verdict.kind === 'pass' && verdict.route && Number(row.hopped)) {
      const { kind, target } = verdict.route
      const routeKey = `${kind}:${target}`
      const route = routes.get(routeKey) || { kind, target, count: 0 }
      route.count += count
      routes.set(routeKey, route)
    }
    const key = `${verdict.kind}:${verdict.by}:${verdict.keyword || ''}:${verdict.rule || ''}`
    const bucket = verdict.kind === 'block' ? blocks : passes
    const prev = bucket.get(key)
    if (prev) prev.count += count
    else {
      const labels = verdict.kind === 'block' ? BLOCK_LABEL : PASS_LABEL
      bucket.set(key, {
        by: verdict.by,
        label: labels[verdict.by] || verdict.by || '其他',
        keyword: verdict.keyword || '',
        rule: verdict.rule || '',
        count,
      })
    }
    if (verdict.kind === 'block') blocked += count
    else passed += count
  }
  const sort = (items) => items.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
  return {
    blocked,
    passed,
    blocks: sort([...blocks.values()]),
    passes: sort([...passes.values()]),
    routes: [...routes.values()].sort(
      (left, right) => right.count - left.count || left.target.localeCompare(right.target),
    ),
  }
}
