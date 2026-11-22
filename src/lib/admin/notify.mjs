/**
 * Account-pool notifications over email and group robots.
 * Watches the same availability口径 as the overview KPI
 * (has token and cred_status is not 不可用/吊销).
 * Public views expose only presence flags for email passwords, Telegram tokens,
 * WeCom Webhooks, and Feishu/Lark Webhooks and signing secrets.
 */
import { createHmac } from 'node:crypto'
import net from 'node:net'
import tls from 'node:tls'
import { CREDENTIAL_REFRESH_FAIL } from '../pool/availability.mjs'

export const SECRET_KEEP = '__KEEP__'
export const DEFAULT_NOTIFY = Object.freeze({
  enabled: false,
  interval_sec: 60,
  cooldown_sec: 300,
  min_available: 1,
  run_on_start: true,
  // Empty means the link uses this backend's own base_url.
  console_url: '',
  digest_sec: 21600,
  events: Object.freeze({
    pool_empty: true,
    pool_low: true,
    pool_recovered: true,
    digest: true,
    revoked: true,
    invalid: true,
    account_down: false,
    account_up: false,
    vm_down: true,
  }),
  email: Object.freeze({
    enabled: false,
    host: '',
    port: 587,
    secure: false,
    user: '',
    pass: '',
    from: '',
    to: Object.freeze([]),
  }),
  telegram: Object.freeze({
    enabled: false,
    bot_token: '',
    chat_id: '',
  }),
  wecom: Object.freeze({
    enabled: false,
    webhook: '',
    mention_all: false,
  }),
  feishu: Object.freeze({
    enabled: false,
    webhook: '',
    secret: '',
  }),
})

const WECOM_WEBHOOK_BASE = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key='
const WECOM_TEXT_MAX_BYTES = 2048
const FEISHU_WEBHOOK =
  /^https:\/\/(?:open\.feishu\.cn|open\.larksuite\.com)\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9_-]{8,128}$/
const FEISHU_WEBHOOK_FORMAT_ERROR = '请填写飞书或 Lark 群自定义机器人的 HTTPS Webhook 地址'
const FEISHU_TEXT_MAX_BYTES = 3000

const EVENT_TITLES = {
  pool_empty: '账号池无可用账号',
  pool_low: '账号池可用偏低',
  pool_recovered: '账号池已恢复',
  account_down: '账号变为不可用',
  account_up: '账号恢复可用',
  vm_down: 'VM / 节点下线',
  digest: '账号池汇报',
  revoked: '发现新吊销',
  invalid: '发现失效凭证',
  test: '账号池汇报',
}

function asBool(value, fallback) {
  if (value == null) return fallback
  if (typeof value === 'boolean') return value
  const s = String(value).trim().toLowerCase()
  if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true
  if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false
  return fallback
}

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

function isSecretKeep(value) {
  const s = String(value ?? '').trim()
  return !s || s === SECRET_KEEP || s === '••••' || /^•+$/.test(s)
}

export function validateNotifyRoutingPatch(body) {
  const webhook = body?.notify?.feishu?.webhook
  if (isSecretKeep(webhook) || (typeof webhook === 'string' && FEISHU_WEBHOOK.test(webhook.trim()))) return
  throw Object.assign(new TypeError(FEISHU_WEBHOOK_FORMAT_ERROR), { code: 'invalid_feishu_webhook' })
}

function normalizeEmails(input) {
  const raw = Array.isArray(input) ? input : String(input || '').split(/[,;\s]+/)
  const out = []
  const seen = new Set()
  for (const item of raw) {
    const email = String(item || '').trim()
    if (!email || !email.includes('@') || seen.has(email.toLowerCase())) continue
    seen.add(email.toLowerCase())
    out.push(email.slice(0, 200))
  }
  return out
}

export function normalizeNotifyConfig(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const emailSrc = src.email && typeof src.email === 'object' ? src.email : {}
  const tgSrc = src.telegram && typeof src.telegram === 'object' ? src.telegram : {}
  const wecomSrc = src.wecom && typeof src.wecom === 'object' ? src.wecom : {}
  const feishuSrc = src.feishu && typeof src.feishu === 'object' ? src.feishu : {}
  const evSrc = src.events && typeof src.events === 'object' ? src.events : {}
  const port = clampInt(emailSrc.port, 1, 65535, DEFAULT_NOTIFY.email.port)
  return {
    enabled: asBool(src.enabled, false),
    interval_sec: clampInt(src.interval_sec, 15, 86400, DEFAULT_NOTIFY.interval_sec),
    cooldown_sec: clampInt(src.cooldown_sec, 30, 86400, DEFAULT_NOTIFY.cooldown_sec),
    digest_sec: clampInt(src.digest_sec, 300, 86400, DEFAULT_NOTIFY.digest_sec),
    min_available: clampInt(src.min_available, 1, 1000, DEFAULT_NOTIFY.min_available),
    run_on_start: asBool(src.run_on_start, true),
    console_url:
      String(src.console_url || DEFAULT_NOTIFY.console_url)
        .trim()
        .slice(0, 200) || DEFAULT_NOTIFY.console_url,
    events: {
      pool_empty: asBool(evSrc.pool_empty, true),
      pool_low: asBool(evSrc.pool_low, true),
      pool_recovered: asBool(evSrc.pool_recovered, true),
      digest: asBool(evSrc.digest, true),
      revoked: asBool(evSrc.revoked, true),
      invalid: asBool(evSrc.invalid, true),
      account_down: asBool(evSrc.account_down, false),
      account_up: asBool(evSrc.account_up, false),
      vm_down: asBool(evSrc.vm_down, true),
    },
    email: {
      enabled: asBool(emailSrc.enabled, false),
      host: String(emailSrc.host || '')
        .trim()
        .slice(0, 200),
      port,
      secure: asBool(emailSrc.secure, port === 465),
      user: String(emailSrc.user || '')
        .trim()
        .slice(0, 200),
      pass: String(emailSrc.pass || ''),
      from: String(emailSrc.from || emailSrc.user || '')
        .trim()
        .slice(0, 200),
      to: normalizeEmails(emailSrc.to),
    },
    telegram: {
      enabled: asBool(tgSrc.enabled, false),
      bot_token: String(tgSrc.bot_token || '').trim(),
      chat_id: String(tgSrc.chat_id || '')
        .trim()
        .slice(0, 80),
    },
    wecom: {
      enabled: asBool(wecomSrc.enabled, false),
      webhook: String(wecomSrc.webhook || '')
        .trim()
        .slice(0, 500),
      mention_all: asBool(wecomSrc.mention_all, false),
    },
    feishu: {
      enabled: asBool(feishuSrc.enabled, false),
      webhook: String(feishuSrc.webhook || '')
        .trim()
        .slice(0, 500),
      secret: String(feishuSrc.secret || '').trim(),
    },
  }
}

export function mergeNotifyConfig(previous = {}, patch = {}) {
  const prev = normalizeNotifyConfig(previous)
  const nextSrc = patch && typeof patch === 'object' ? patch : {}
  const emailPatch = nextSrc.email && typeof nextSrc.email === 'object' ? nextSrc.email : {}
  const tgPatch = nextSrc.telegram && typeof nextSrc.telegram === 'object' ? nextSrc.telegram : {}
  const wecomPatch = nextSrc.wecom && typeof nextSrc.wecom === 'object' ? nextSrc.wecom : {}
  const feishuPatch = nextSrc.feishu && typeof nextSrc.feishu === 'object' ? nextSrc.feishu : {}
  const merged = normalizeNotifyConfig({
    ...prev,
    ...nextSrc,
    events: { ...prev.events, ...(nextSrc.events || {}) },
    email: { ...prev.email, ...emailPatch },
    telegram: { ...prev.telegram, ...tgPatch },
    wecom: { ...prev.wecom, ...wecomPatch },
    feishu: { ...prev.feishu, ...feishuPatch },
  })
  if (isSecretKeep(emailPatch.pass)) merged.email.pass = prev.email.pass
  if (isSecretKeep(tgPatch.bot_token)) merged.telegram.bot_token = prev.telegram.bot_token
  if (isSecretKeep(wecomPatch.webhook)) merged.wecom.webhook = prev.wecom.webhook
  if (isSecretKeep(feishuPatch.webhook)) merged.feishu.webhook = prev.feishu.webhook
  if (feishuPatch.clear_secret === true) merged.feishu.secret = ''
  else if (isSecretKeep(feishuPatch.secret)) merged.feishu.secret = prev.feishu.secret
  return merged
}

export function publicNotifyConfig(raw = {}) {
  const cfg = normalizeNotifyConfig(raw)
  return {
    ...cfg,
    email: {
      ...cfg.email,
      pass: '',
      pass_set: !!cfg.email.pass,
    },
    telegram: {
      ...cfg.telegram,
      bot_token: '',
      bot_token_set: !!cfg.telegram.bot_token,
    },
    wecom: {
      ...cfg.wecom,
      webhook: '',
      webhook_set: !!cfg.wecom.webhook,
    },
    feishu: {
      enabled: cfg.feishu.enabled,
      webhook: '',
      webhook_set: !!cfg.feishu.webhook,
      secret: '',
      secret_set: !!cfg.feishu.secret,
    },
  }
}

export function publicRoutingNotify(routing = {}) {
  return {
    ...routing,
    notify: publicNotifyConfig(routing?.notify),
  }
}

function shanghaiDayStartMs(now = Date.now()) {
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(now))
  return Date.parse(`${day}T00:00:00+08:00`)
}

function isShanghaiToday(iso, now = Date.now()) {
  const t = Date.parse(iso || '')
  if (!Number.isFinite(t)) return false
  return t >= shanghaiDayStartMs(now)
}

function vmOnline(v) {
  const s = String(v?.status || '').toLowerCase()
  if (s === 'stopped' || s === 'dead' || s === 'disabled') return false
  if (!v?.has_token) return false
  return !!(v.active || s === 'running' || s === 'ok' || !s)
}

function classifyAccount(v = {}, now = Date.now()) {
  const av = v.availability || {}
  const cred = v.cred_status || {}
  const hasToken = !!v.has_token
  const key = hasToken ? String(av.key || cred.key || 'ok') : 'none'
  const gated = key === 'quota' || key === 'cool' || key === 'warn' || key === 'caution'
  const dead = key === 'none' || key === 'bad'
  const off = key === 'off'
  const usable = av.usable != null ? !!av.usable : hasToken && !dead && !off
  const reason = String(av.reason || cred.reason || '')
  const status = av.text || cred.text || (hasToken ? '可用' : '无凭证')
  const blob = [reason, status, v.schedule_disabled_reason, v.worker_credential?.last_error].filter(Boolean).join(' ')
  const revoked = hasToken && !usable && (CREDENTIAL_REFRESH_FAIL.test(blob) || /吊销|revoke/i.test(blob))
  const invalid = hasToken && !usable && !revoked && !off
  const probedAt = av.probed_at || v.last_probe?.at || v.refreshed_at || null
  return {
    id: v.id,
    email: v.email || null,
    has_token: hasToken,
    usable,
    online: vmOnline(v),
    revoked,
    invalid,
    limited: gated || key === 'quota' || key === 'warn',
    warned: key === 'caution' || key === 'cool',
    today_revoked: revoked && isShanghaiToday(probedAt, now),
    today_invalid: invalid && isShanghaiToday(probedAt, now),
    today_unavailable: hasToken && !usable && isShanghaiToday(probedAt, now),
    status,
    key,
    reason: reason || null,
  }
}

export function summarizePoolAvailability(vms = [], now = Date.now(), extras = {}) {
  const accounts = (vms || []).map((v) => classifyAccount(v, now))
  const withToken = accounts.filter((a) => a.has_token)
  const available = accounts.filter((a) => a.usable)
  const unavailable = withToken.filter((a) => !a.usable)
  const today = extras.today && typeof extras.today === 'object' ? extras.today : {}
  const billing = extras.billing && typeof extras.billing === 'object' ? extras.billing : {}
  const todayCost = Number(today.total_cost ?? billing.today?.total_cost ?? 0)
  const todayReq = Number(today.requests ?? billing.today?.requests ?? 0)
  const todayTok = Number(
    today.tokens ??
      (Number(today.input_tokens || 0) + Number(today.output_tokens || 0) ||
        Number(billing.today?.input_tokens || 0) + Number(billing.today?.output_tokens || 0)),
  )
  return {
    at: new Date(now).toISOString(),
    total: accounts.length,
    with_token: withToken.length,
    available: available.length,
    unavailable: unavailable.length,
    online: accounts.filter((a) => a.online).length,
    revoked: accounts.filter((a) => a.revoked).length,
    invalid: accounts.filter((a) => a.invalid).length,
    today_revoked: accounts.filter((a) => a.today_revoked).length,
    today_invalid: accounts.filter((a) => a.today_invalid).length,
    today_unavailable: accounts.filter((a) => a.today_unavailable).length,
    limited: accounts.filter((a) => a.limited).length,
    warned: accounts.filter((a) => a.warned).length,
    no_token: accounts.filter((a) => !a.has_token).length,
    today: {
      requests: todayReq,
      tokens: todayTok,
      cost: todayCost,
      errors: Number(today.errors || 0),
      status_429: Number(today.status_429 || 0),
      status_529: Number(today.status_529 || 0),
      sla: today.sla == null ? null : Number(today.sla),
    },
    accounts,
  }
}

function accountMap(snap) {
  const out = new Map()
  for (const row of snap?.accounts || []) out.set(row.id, row)
  return out
}

export function detectPoolNotifyEvents(prev, next, cfg = DEFAULT_NOTIFY) {
  if (!next) return []
  const events = []
  const min = Number(cfg.min_available || 1)
  const ev = cfg.events || DEFAULT_NOTIFY.events
  const prevAvail = prev?.available
  const nextAvail = next.available
  const withToken = next.with_token

  if (ev.pool_empty && withToken > 0 && nextAvail === 0 && prevAvail !== 0) {
    events.push({
      type: 'pool_empty',
      title: EVENT_TITLES.pool_empty,
      available: nextAvail,
      with_token: withToken,
    })
  }
  if (ev.pool_low && nextAvail > 0 && nextAvail < min && (prevAvail == null || prevAvail >= min || prevAvail === 0)) {
    events.push({
      type: 'pool_low',
      title: EVENT_TITLES.pool_low,
      available: nextAvail,
      min_available: min,
      with_token: withToken,
    })
  }
  if (ev.pool_recovered && prev) {
    const wasBad = prevAvail === 0 || prevAvail < min
    const nowOk = nextAvail > 0 && nextAvail >= min
    if (wasBad && nowOk) {
      events.push({
        type: 'pool_recovered',
        title: EVENT_TITLES.pool_recovered,
        available: nextAvail,
        with_token: withToken,
      })
    }
  }

  if (ev.vm_down) {
    const previousVms = new Map((prev?.vms || []).map((vm) => [vm.id, vm]))
    for (const vm of next.vms || []) {
      if (vm.online !== false) continue
      const old = previousVms.get(vm.id)
      // Existing stopped slots at startup are not new outages. A failed node
      // link or terminal kernel fault is actionable even on the first check.
      if (old?.online === true || (!old && ['node_offline', 'kernel_faulted'].includes(vm.reason))) {
        events.push({ type: 'vm_down', title: EVENT_TITLES.vm_down, ...vm })
      }
    }
  }

  const before = accountMap(prev)
  const after = accountMap(next)
  if (ev.account_down) {
    for (const row of after.values()) {
      if (!row.has_token || row.usable) continue
      const old = before.get(row.id)
      if (!old || old.usable) {
        events.push({
          type: 'account_down',
          title: EVENT_TITLES.account_down,
          id: row.id,
          email: row.email,
          status: row.status,
        })
      }
    }
  }
  if (ev.account_up) {
    for (const row of after.values()) {
      if (!row.usable) continue
      const old = before.get(row.id)
      if (old && old.has_token && !old.usable) {
        events.push({
          type: 'account_up',
          title: EVENT_TITLES.account_up,
          id: row.id,
          email: row.email,
          status: row.status,
        })
      }
    }
  }
  if (prev && ev.revoked) {
    const added = [...after.values()].filter((row) => row.revoked && !before.get(row.id)?.revoked)
    if (added.length) {
      events.push({
        type: 'revoked',
        title: EVENT_TITLES.revoked,
        count: added.length,
        ids: added.map((row) => row.id),
      })
    }
  }
  if (prev && ev.invalid) {
    const added = [...after.values()].filter((row) => row.invalid && !before.get(row.id)?.invalid)
    if (added.length) {
      events.push({
        type: 'invalid',
        title: EVENT_TITLES.invalid,
        count: added.length,
        ids: added.map((row) => row.id),
      })
    }
  }
  return events
}

function shanghaiClock(iso) {
  try {
    return new Date(iso || Date.now()).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
  } catch {
    return String(iso || '')
  }
}

function accountLine(a) {
  return `${a.id}${a.email ? ' ' + a.email : ''} ${a.status}`
}

function todayIssueAccounts(snap) {
  const rows = (snap?.accounts || []).filter((a) => a.today_unavailable || a.today_invalid || a.today_revoked)
  const rank = (a) => (a.today_revoked ? 0 : a.today_invalid ? 1 : 2)
  return rows.slice().sort((a, b) => rank(a) - rank(b) || String(a.id || '').localeCompare(String(b.id || '')))
}

function fmtUsd(n) {
  const x = Number(n || 0)
  return `$${x.toFixed(2)}`
}

function fmtTok(n) {
  const x = Number(n || 0)
  if (x >= 1_000_000) return `${(x / 1_000_000).toFixed(1)}m`
  if (x >= 1000) return `${(x / 1000).toFixed(1)}k`
  return String(Math.round(x))
}

export function formatNotifyMessage(event, snap, cfg = DEFAULT_NOTIFY, baseUrl = '') {
  const title = event?.title || EVENT_TITLES[event?.type] || '账号池汇报'
  const lines = [`【KIN】${title}`]
  const summary = []
  if (snap) {
    lines.push('')
    lines.push(
      `凭证 ${snap.with_token ?? 0} · 可用 ${snap.available ?? 0} · 在线 ${snap.online ?? 0} · 不可用 ${snap.unavailable ?? 0}`,
    )
    summary.push(
      `吊销 ${snap.revoked ?? 0} · 今日吊销 ${snap.today_revoked ?? 0} · 失效 ${snap.invalid ?? 0} · 今日失效 ${snap.today_invalid ?? 0}`,
    )
    if (snap.limited || 0 || snap.warned || 0 || snap.no_token || 0) {
      summary.push(
        `限制 ${snap.limited || 0} · 警告 ${snap.warned || 0} · 无凭证 ${snap.no_token || 0} · 槽 ${snap.total ?? 0}`,
      )
    } else {
      summary.push(`槽 ${snap.total ?? 0}`)
    }
    const today = snap.today || {}
    summary.push(`今日 ${fmtUsd(today.cost)} · ${today.requests || 0} req · ${fmtTok(today.tokens)} tok`)
    const sla = today.sla == null ? '' : ` · SLA ${(Number(today.sla) * 100).toFixed(1)}%`
    summary.push(`错误 ${today.errors || 0} · 429 ${today.status_429 || 0} · 529 ${today.status_529 || 0}${sla}`)
    lines.push(...summary)
  }
  const details = []
  if (event?.type === 'pool_low' && event.min_available) {
    details.push(`阈值 ${event.min_available}`)
  }
  if (event?.id) {
    details.push(`${event.id}${event.email ? ' ' + event.email : ''} ${event.status || ''}`.trim())
  }
  if (event?.type === 'vm_down') {
    details.push(`节点 ${event.node_id || '本机'}`)
    details.push(`原因 ${event.reason}${event.detail ? ': ' + event.detail : ''}`)
    details.push('该 VM 当前不可连通，已退出调度。')
  }
  if (event?.ids?.length) {
    details.push(`新增 ${event.count || event.ids.length} 个`)
  }
  lines.push(...details)
  const todayIssues = todayIssueAccounts(snap)
  const preview = todayIssues.slice(0, 5)
  const issues = preview.map((row) => `· ${accountLine(row)}`)
  if (issues.length) {
    lines.push('')
    lines.push('今日不可用 / 失效')
    const more = todayIssues.length - preview.length
    if (more > 0) issues.push(`· 另有 ${more} 个`)
    lines.push(...issues)
  }
  const time = snap?.at ? shanghaiClock(snap.at) : ''
  if (snap?.at) {
    lines.push('')
    lines.push(time)
  }
  const url = String(cfg.console_url || baseUrl || '').replace(/\/$/, '')
  const consoleLink = url ? `${url}/#/cluster` : ''
  if (consoleLink) lines.push(consoleLink)
  return {
    title,
    text: lines.join('\n'),
    subject: `KIN · ${title}`,
    eventType: event?.type,
    details,
    issues,
    metrics: snap
      ? [
          ['可用', snap.available ?? 0],
          ['在线', snap.online ?? 0],
          ['不可用', snap.unavailable ?? 0],
        ]
      : [],
    pool: snap && {
      with_token: snap.with_token ?? 0,
      total: snap.total ?? 0,
      limited: snap.limited,
      warned: snap.warned,
      no_token: snap.no_token,
      revoked: snap.revoked,
      today_revoked: snap.today_revoked,
      invalid: snap.invalid,
      today_invalid: snap.today_invalid,
    },
    today: snap?.today,
    time,
    consoleLink,
  }
}

export function emailCredentialsReady(cfg) {
  const email = cfg?.email || {}
  return !!(email.host && email.to?.length)
}

export function telegramCredentialsReady(cfg) {
  const tg = cfg?.telegram || {}
  return !!(tg.bot_token && tg.chat_id)
}

export function wecomCredentialsReady(cfg) {
  return !!wecomWebhookUrl(cfg?.wecom?.webhook)
}

export function emailChannelReady(cfg) {
  return !!(cfg?.email?.enabled && emailCredentialsReady(cfg))
}

export function telegramChannelReady(cfg) {
  return !!(cfg?.telegram?.enabled && telegramCredentialsReady(cfg))
}

export function wecomChannelReady(cfg) {
  return !!(cfg?.wecom?.enabled && wecomCredentialsReady(cfg))
}

export function notifyChannelsReady(cfg) {
  const ready = Object.fromEntries(
    Object.entries(NOTIFY_CHANNELS).map(([channel, adapter]) => [channel, adapter.ready(cfg)]),
  )
  return { ...ready, any: Object.values(ready).some(Boolean) }
}

function smtpExpectOk(reply, allowed) {
  if (!allowed.has(reply.code)) {
    const hint =
      String(reply.text || '')
        .split(/\r?\n/)
        .filter(Boolean)
        .pop() || `smtp_${reply.code}`
    throw new Error(hint.slice(0, 180))
  }
}

function smtpRead(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = ''
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('smtp_timeout'))
    }, timeoutMs)
    const onData = (chunk) => {
      buf += chunk.toString('utf8')
      const lines = buf.split(/\r?\n/).filter((line) => line.length)
      const last = lines[lines.length - 1]
      if (last && /^\d{3} /.test(last)) {
        cleanup()
        resolve({ code: Number(last.slice(0, 3)), text: buf })
      }
    }
    const onErr = (err) => {
      cleanup()
      reject(err)
    }
    const cleanup = () => {
      clearTimeout(timer)
      socket.off('data', onData)
      socket.off('error', onErr)
    }
    socket.on('data', onData)
    socket.on('error', onErr)
  })
}

function smtpWrite(socket, line) {
  socket.write(line.endsWith('\r\n') ? line : `${line}\r\n`)
}

function connectSmtp({ host, port, secure, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('smtp_connect_timeout'))
    }, timeoutMs)
    const onReady = () => {
      clearTimeout(timer)
      resolve(socket)
    }
    const socket = secure
      ? tls.connect({ host, port, servername: host }, onReady)
      : net.connect({ host, port }, onReady)
    socket.setTimeout(timeoutMs, () => {
      socket.destroy()
      reject(new Error('smtp_socket_timeout'))
    })
    socket.once('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

function upgradeStartTls(socket, { host, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('smtp_starttls_timeout'))
    }, timeoutMs)
    const secure = tls.connect({ socket, servername: host }, () => {
      clearTimeout(timer)
      resolve(secure)
    })
    secure.once('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

function encodeAddress(value) {
  const s = String(value || '').trim()
  const m = s.match(/^(.+?)\s*<([^>]+)>$/)
  if (m) return `<${m[2].trim()}>`
  return `<${s}>`
}

export async function sendEmailNotify(cfg, message, opts = {}) {
  const email = cfg?.email || {}
  if (!emailCredentialsReady(cfg)) throw new Error('email_not_configured')
  const timeoutMs = Number(opts.timeoutMs || 20000)
  const connect = opts.connect || connectSmtp
  const from = email.from || email.user
  if (!from) throw new Error('email_from_missing')
  let socket = await connect({
    host: email.host,
    port: email.port,
    secure: !!email.secure,
    timeoutMs,
  })
  const talk = async (line, allowed) => {
    if (line != null) smtpWrite(socket, line)
    const reply = await smtpRead(socket, timeoutMs)
    smtpExpectOk(reply, allowed)
    return reply
  }
  try {
    await talk(null, new Set([220]))
    const ehlo = await talk(`EHLO kin-gateway`, new Set([250]))
    if (!email.secure && /STARTTLS/i.test(ehlo.text)) {
      await talk('STARTTLS', new Set([220]))
      socket = await (opts.upgradeTls || upgradeStartTls)(socket, { host: email.host, timeoutMs })
      await talk('EHLO kin-gateway', new Set([250]))
    }
    if (email.user) {
      await talk('AUTH LOGIN', new Set([334]))
      await talk(Buffer.from(email.user, 'utf8').toString('base64'), new Set([334]))
      await talk(Buffer.from(email.pass || '', 'utf8').toString('base64'), new Set([235]))
    }
    await talk(`MAIL FROM:${encodeAddress(from)}`, new Set([250]))
    for (const to of email.to) {
      await talk(`RCPT TO:${encodeAddress(to)}`, new Set([250, 251]))
    }
    await talk('DATA', new Set([354]))
    const stamp = new Date().toUTCString()
    const body = [
      `From: ${from}`,
      `To: ${email.to.join(', ')}`,
      `Subject: =?UTF-8?B?${Buffer.from(message.subject || message.title || 'KIN', 'utf8').toString('base64')}?=`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      `Date: ${stamp}`,
      '',
      String(message.text || ''),
      '.',
    ].join('\r\n')
    await talk(body, new Set([250]))
    await talk('QUIT', new Set([221, 250])).catch(() => {})
    return { ok: true, channel: 'email', to: email.to.slice() }
  } finally {
    try {
      socket.end()
    } catch {}
    try {
      socket.destroy()
    } catch {}
  }
}

function redactTelegramError(text, token) {
  return String(text || 'telegram_failed')
    .split(token)
    .join('***')
    .slice(0, 180)
}

export async function sendTelegramNotify(cfg, message, opts = {}) {
  const tg = cfg?.telegram || {}
  if (!telegramCredentialsReady(cfg)) throw new Error('telegram_not_configured')
  const url = `https://api.telegram.org/bot${tg.bot_token}/sendMessage`
  const fetchFn = opts.fetch || globalThis.fetch
  if (typeof fetchFn !== 'function') throw new Error('telegram_fetch_missing')
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: tg.chat_id,
      text: String(message.text || message.title || 'KIN'),
      disable_web_page_preview: true,
    }),
    signal: opts.signal,
  })
  const raw = await res.text().catch(() => '')
  let data = {}
  try {
    data = raw ? JSON.parse(raw) : {}
  } catch {
    data = { description: raw }
  }
  if (!res.ok || data.ok === false) {
    throw new Error(redactTelegramError(data.description || `telegram_http_${res.status}`, tg.bot_token))
  }
  return { ok: true, channel: 'telegram', chat_id: tg.chat_id }
}

// Accepts the full robot URL copied from WeCom or just its key.
export function wecomWebhookUrl(value) {
  const s = String(value || '').trim()
  if (!s) return ''
  if (/^[A-Za-z0-9-]{8,128}$/.test(s)) return WECOM_WEBHOOK_BASE + s
  let url
  try {
    url = new URL(s)
  } catch {
    return ''
  }
  if (url.protocol !== 'https:' || !url.searchParams.get('key')) return ''
  return url.toString()
}

function redactWecomError(text, cfg) {
  let out = String(text || 'wecom_failed')
  const url = wecomWebhookUrl(cfg?.wecom?.webhook)
  const key = url ? new URL(url).searchParams.get('key') : ''
  for (const secret of [cfg?.wecom?.webhook, url, key]) {
    if (secret) out = out.split(secret).join('***')
  }
  return out.slice(0, 180)
}

function truncateUtf8(text, maxBytes) {
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= maxBytes) return text
  const suffix = '\n…'
  let cut = buf.subarray(0, maxBytes - Buffer.byteLength(suffix)).toString('utf8')
  if (cut.endsWith('\uFFFD')) cut = cut.slice(0, -1)
  return cut + suffix
}

export async function sendWecomNotify(cfg, message, opts = {}) {
  const wecom = cfg?.wecom || {}
  const url = wecomWebhookUrl(wecom.webhook)
  if (!url) throw new Error('wecom_not_configured')
  const fetchFn = opts.fetch || globalThis.fetch
  if (typeof fetchFn !== 'function') throw new Error('wecom_fetch_missing')
  const text = { content: truncateUtf8(String(message.text || message.title || 'KIN'), WECOM_TEXT_MAX_BYTES) }
  if (wecom.mention_all) text.mentioned_list = ['@all']
  let res
  try {
    res = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ msgtype: 'text', text }),
      signal: opts.signal,
    })
  } catch (err) {
    throw new Error(redactWecomError(err?.message || err, cfg))
  }
  const raw = await res.text().catch(() => '')
  let data = {}
  try {
    data = raw ? JSON.parse(raw) : {}
  } catch {
    data = { errmsg: raw }
  }
  if (!res.ok || (data.errcode != null && Number(data.errcode) !== 0)) {
    const reason =
      data.errcode != null ? `wecom_${data.errcode} ${data.errmsg || ''}`.trim() : `wecom_http_${res.status}`
    throw new Error(redactWecomError(reason, cfg))
  }
  return { ok: true, channel: 'wecom' }
}

const FEISHU_EVENT_COLORS = {
  pool_empty: 'red',
  vm_down: 'red',
  revoked: 'red',
  invalid: 'orange',
  pool_low: 'orange',
  account_down: 'orange',
  pool_recovered: 'green',
  account_up: 'green',
}

function feishuSummaryTable(cells) {
  const columns = cells.map(([label], index) => ({
    name: `value_${index}`,
    display_name: label,
    data_type: 'text',
    width: index === 0 ? '34%' : '33%',
    horizontal_align: 'center',
  }))
  return {
    tag: 'table',
    page_size: 1,
    row_height: 'low',
    header_style: { bold: true, text_align: 'center' },
    columns,
    rows: [Object.fromEntries(columns.map(({ name }, index) => [name, String(cells[index][1])]))],
  }
}

function feishuCard(message) {
  const plainText = (content) => ({ tag: 'plain_text', content })
  const paragraph = (content) => ({ tag: 'div', text: plainText(content) })
  const textBlock = (lines) => paragraph(truncateUtf8(lines.join('\n'), FEISHU_TEXT_MAX_BYTES))
  const elements = []
  const section = (title, ...content) => {
    if (elements.length) elements.push({ tag: 'hr' })
    elements.push({ tag: 'markdown', content: `**${title}**` }, ...content)
  }
  if (message.eventType === 'test') {
    elements.push(paragraph('飞书群机器人已收到 VM2API 的测试通知。'))
  } else {
    if (message.details?.length) section('事件详情', textBlock(message.details))
    if (message.metrics?.length) {
      if (elements.length) elements.push({ tag: 'hr' })
      elements.push({
        tag: 'column_set',
        flex_mode: 'none',
        columns: message.metrics.map(([label, count]) => ({
          tag: 'column',
          width: 'weighted',
          weight: 1,
          elements: [{ tag: 'markdown', content: `**${Number(count) || 0}**\n${label}` }],
        })),
      })
    }
    if (message.pool) {
      const pool = message.pool
      elements.push(paragraph(`已配置凭证 ${pool.with_token} / ${pool.total} 个槽位`))
      const flags = [
        ['限额', pool.limited],
        ['告警', pool.warned],
        ['无凭证', pool.no_token],
        ['吊销', pool.revoked],
        ['今日吊销', pool.today_revoked],
        ['失效', pool.invalid],
        ['今日失效', pool.today_invalid],
      ].filter(([, count]) => Number(count) > 0)
      if (flags.length) elements.push(paragraph(flags.map(([label, count]) => `${label} ${count}`).join(' · ')))
    }
    if (message.today) {
      const today = message.today
      section(
        '今日用量',
        feishuSummaryTable([
          ['请求量', Number(today.requests || 0).toLocaleString('zh-CN')],
          ['Token', fmtTok(today.tokens)],
          ['费用', fmtUsd(today.cost)],
        ]),
      )
      section(
        '今日请求健康',
        feishuSummaryTable([
          ['SLA', today.sla == null ? '—' : `${(Number(today.sla) * 100).toFixed(1)}%`],
          ['失败请求', today.errors || 0],
          ['429 / 529', `${today.status_429 || 0} / ${today.status_529 || 0}`],
        ]),
      )
    }
    if (message.issues?.length) {
      section('今日不可用 / 失效', textBlock(message.issues))
    }
  }
  if (!elements.length) elements.push(textBlock([String(message.text || message.title || 'VM2API')]))
  if (message.eventType !== 'test' && (message.time || message.consoleLink)) elements.push({ tag: 'hr' })
  if (message.time) elements.push(paragraph(`${message.time} · 北京时间`))
  if (/^https?:\/\//i.test(message.consoleLink || '')) {
    elements.push({
      tag: 'button',
      type: 'default',
      text: plainText('打开集群控制台'),
      behaviors: [{ type: 'open_url', default_url: message.consoleLink }],
    })
  }
  return {
    schema: '2.0',
    header: {
      template: FEISHU_EVENT_COLORS[message.eventType] || 'blue',
      title: plainText(truncateUtf8(String(message.title || 'VM2API 通知'), 180)),
      subtitle: plainText('VM2API · 通知'),
    },
    body: { direction: 'vertical', padding: '12px 16px 12px 16px', elements },
  }
}

async function sendFeishuNotify(cfg, message, opts = {}) {
  const { webhook, secret } = cfg?.feishu || {}
  if (!webhook) throw new Error('飞书 Webhook 未配置')
  if (!FEISHU_WEBHOOK.test(webhook)) throw new Error(FEISHU_WEBHOOK_FORMAT_ERROR)
  const payload = {
    msg_type: 'interactive',
    card: feishuCard(message),
  }
  if (secret) {
    const timestamp = String(Math.floor(Date.now() / 1000))
    payload.timestamp = timestamp
    payload.sign = createHmac('sha256', `${timestamp}\n${secret}`).digest('base64')
  }

  const fetchFn = opts.fetch || globalThis.fetch
  const timeout = AbortSignal.timeout(10_000)
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout
  let response
  let raw
  try {
    signal.throwIfAborted()
    response = await fetchFn(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
      redirect: 'error',
      signal,
    })
    if (response.ok) raw = await response.text()
  } catch (error) {
    opts.signal?.throwIfAborted()
    if (error?.name === 'AbortError' && !timeout.aborted) throw error
    const code = error?.cause?.code ?? error?.code ?? ''
    if (timeout.aborted || error?.name === 'TimeoutError' || ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) {
      throw new Error('飞书 / Lark Webhook 请求超时')
    }
    if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) throw new Error('飞书 / Lark Webhook DNS 解析失败')
    if (/^(?:ERR_TLS_|ERR_SSL_|CERT_|DEPTH_ZERO_|SELF_SIGNED_|UNABLE_TO_)/.test(code)) {
      throw new Error('飞书 / Lark Webhook TLS 校验失败')
    }
    throw new Error('飞书 / Lark Webhook 连接失败')
  }
  if (!response.ok) throw new Error(`飞书 / Lark Webhook HTTP ${response.status}`)
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error('飞书 Webhook 返回了无效响应')
  }
  const code = data?.code ?? data?.StatusCode
  if (code === 0) return { ok: true, channel: 'feishu' }
  if (code === 19021) throw new Error('飞书签名校验失败，请检查机器人签名密钥')
  if (code === 19022) throw new Error('飞书机器人拒绝请求，请检查 IP 白名单')
  if (code === 19024) throw new Error('飞书机器人拒绝请求，请检查关键词设置')
  if (Number.isInteger(code)) throw new Error(`飞书 Webhook 错误码 ${code}`)
  throw new Error('飞书 Webhook 返回了无效响应')
}

const NOTIFY_CHANNELS = Object.freeze({
  email: { ready: emailChannelReady, send: sendEmailNotify },
  telegram: { ready: telegramChannelReady, send: sendTelegramNotify },
  wecom: { ready: wecomChannelReady, send: sendWecomNotify },
  feishu: {
    ready: (cfg) => !!(cfg?.feishu?.enabled && FEISHU_WEBHOOK.test(cfg.feishu.webhook)),
    send: sendFeishuNotify,
  },
})

export function isNotifyChannel(channel) {
  return Object.hasOwn(NOTIFY_CHANNELS, channel)
}

export async function dispatchNotify(cfg, message, opts = {}) {
  opts.signal?.throwIfAborted()
  const ready = notifyChannelsReady(cfg)
  if (!ready.any) return { ok: false, error: 'no_channel', results: [] }
  const results = []
  for (const [channel, { send }] of Object.entries(NOTIFY_CHANNELS)) {
    if (!ready[channel] || (opts.channels && !opts.channels.includes(channel))) continue
    try {
      results.push(await send(cfg, message, opts))
    } catch (err) {
      opts.signal?.throwIfAborted()
      if (err?.name === 'AbortError') throw err
      results.push({ ok: false, channel, error: String(err?.message || err).slice(0, 180) })
    }
  }
  return {
    ok: results.some((row) => row.ok),
    results,
  }
}

export async function sendNotifyTest(cfg, channel, extra = {}) {
  const want = String(channel || '').toLowerCase()
  const message = formatNotifyMessage(
    {
      type: 'test',
      title: extra.title || (want === 'feishu' ? '飞书通知测试' : EVENT_TITLES.test),
    },
    extra.snapshot || {
      at: new Date().toISOString(),
      available: extra.available ?? 0,
      with_token: extra.with_token ?? 0,
      total: extra.total ?? 0,
      accounts: extra.accounts || [],
    },
    cfg,
    extra.baseUrl,
  )
  if (isNotifyChannel(want)) return NOTIFY_CHANNELS[want].send(cfg, message, extra)
  return dispatchNotify(cfg, message, extra)
}

export function createNotifyMonitor(opts = {}) {
  let config = normalizeNotifyConfig(opts.config)
  let snapshot = null
  let lastEvents = []
  let lastError = null
  let lastRunAt = 0
  let inflight = null
  let timer = null
  const lastSent = new Map()
  const pendingVmDown = new Map()
  const nowFn = opts.now || (() => Date.now())

  const getConfig = () => config
  const getSnapshot = () => snapshot
  const getStatus = () => ({
    config: publicNotifyConfig(config),
    snapshot,
    last_events: lastEvents,
    last_error: lastError,
    last_run_at: lastRunAt ? new Date(lastRunAt).toISOString() : null,
    channels: notifyChannelsReady(config),
  })

  const allowed = (type, now) => {
    const prev = lastSent.get(type) || 0
    const wait = type === 'digest' ? config.digest_sec : config.cooldown_sec
    return now - prev >= wait * 1000
  }

  const runOnce = async ({ send = true, force = false, digest = false } = {}) => {
    if (inflight) return inflight
    inflight = (async () => {
      const started = nowFn()
      lastRunAt = started
      let deliveryError = null
      let delivered = false
      const poolSnapshot = typeof opts.snapshot === 'function' ? await opts.snapshot() : null
      const prev = snapshot
      const next = poolSnapshot ? { ...poolSnapshot } : null
      if (next && opts.vmSnapshot) {
        const previousVms = new Map((prev?.vms || []).map((vm) => [vm.id, vm]))
        next.vms = (await opts.vmSnapshot()).map((vm) => {
          const old = previousVms.get(vm.id)
          return vm.monitored !== false && vm.online == null && old
            ? { ...vm, online: old.online, reason: old.reason, detail: old.detail }
            : vm
        })
      }
      snapshot = next
      const events = detectPoolNotifyEvents(prev, next, config)
      if (digest || (config.events.digest && (!prev || allowed('digest', started)))) {
        events.push({ type: 'digest', title: EVENT_TITLES.digest })
      }
      const currentVms = new Map((next?.vms || []).map((vm) => [vm.id, vm]))
      for (const [id] of pendingVmDown) {
        if (!config.events.vm_down || !currentVms.has(id) || currentVms.get(id).online !== false)
          pendingVmDown.delete(id)
      }
      for (const event of events) {
        if (event.type === 'vm_down') pendingVmDown.set(event.id, { event, channels: null })
      }
      const deliveries = [
        ...events.filter((event) => event.type !== 'vm_down'),
        ...[...pendingVmDown.values()].map((row) => row.event),
      ]
      lastEvents = events
      const dispatched = []
      const canSend = send && config.enabled && (typeof opts.send === 'function' || notifyChannelsReady(config).any)
      if (canSend) {
        for (const event of deliveries) {
          if (event.type !== 'vm_down' && !force && !digest && !allowed(event.type, started)) continue
          const message = formatNotifyMessage(event, next, config, opts.baseUrl)
          const deliveryOptions = { channels: pendingVmDown.get(event.id)?.channels }
          const sendFn = opts.send || ((msg, _event, extra) => dispatchNotify(config, msg, extra))
          try {
            const result = await sendFn(message, event, deliveryOptions)
            lastSent.set(event.type, started)
            const failedChannels = Array.isArray(result?.results)
              ? result.results.filter((row) => row?.ok === false)
              : []
            if (result?.ok === false || failedChannels.length) {
              deliveryError = String(
                failedChannels.map((row) => row.error || 'notify_delivery_failed').join('; ') ||
                  result?.error ||
                  'notify_delivery_failed',
              ).slice(0, 180)
              if (event.type === 'vm_down' && failedChannels.length) {
                pendingVmDown.get(event.id).channels = failedChannels.map((row) => row.channel)
              }
            } else {
              if (event.type === 'vm_down') pendingVmDown.delete(event.id)
              delivered = true
            }
            dispatched.push({ type: event.type, ok: result?.ok !== false && !failedChannels.length, result })
          } catch (err) {
            if (err?.name === 'AbortError') break
            deliveryError = String(err?.message || err).slice(0, 180)
            dispatched.push({ type: event.type, ok: false, error: deliveryError })
          }
        }
      }
      // A quiet/cooldown-suppressed check is not proof of delivery recovery.
      // Any failure in this batch takes precedence over successful events.
      if (deliveryError !== null) lastError = deliveryError
      else if (delivered) lastError = null
      return { snapshot: next, events, dispatched, prev }
    })().finally(() => {
      inflight = null
    })
    return inflight
  }

  const stop = () => {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  const start = ({ immediate = false } = {}) => {
    stop()
    if (!config.enabled) return { started: false, reason: 'disabled' }
    timer = setInterval(() => {
      runOnce().catch(() => {})
    }, config.interval_sec * 1000)
    if (typeof timer.unref === 'function') timer.unref()
    if (immediate && config.run_on_start) {
      queueMicrotask(() => {
        runOnce().catch(() => {})
      })
    }
    return { started: true, interval_sec: config.interval_sec, run_on_start: config.run_on_start }
  }

  const setConfig = (next, { restart = true } = {}) => {
    config = normalizeNotifyConfig(next)
    if (restart) start({ immediate: false })
    return config
  }

  return {
    getConfig,
    setConfig,
    getSnapshot,
    getStatus,
    runOnce,
    start,
    stop,
  }
}
