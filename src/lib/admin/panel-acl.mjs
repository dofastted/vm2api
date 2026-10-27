/**
 * Panel RBAC.
 *
 *   admin  — full console + user management
 *   super  — overview / cluster / logs / statistics + VM page (schedule only)
 *   user   — tenant: vm / proxies / keys / billing / logs / statistics (owner-scoped)
 */

export const PANEL_VIEWS = [
  'overview',
  'cluster',
  'vm',
  'import',
  'specs',
  'proxies',
  'models',
  'risk',
  'system',
  'keys',
  'api',
  'anthropic',
  'logs',
  'statistics',
  'database',
  'settings',
  'users',
  'wrap',
  'billing',
]

const ROLE_VIEWS = {
  user: ['vm', 'proxies', 'keys', 'billing', 'logs', 'statistics'],
  super: ['overview', 'cluster', 'logs', 'statistics', 'vm'],
  admin: PANEL_VIEWS.slice(),
}

const ROLE_CAPS = {
  user: [
    'panel.read',
    'vm.read',
    'vm.schedule',
    'vm.credential_write',
    'vm.create',
    'vm.delete_owned',
    'proxy.write',
    'keys.write',
    'billing.read',
  ],
  super: ['panel.read', 'vm.read', 'vm.schedule'],
  admin: ['*'],
}

export function normalizePanelRole(role) {
  const r = String(role || '')
    .trim()
    .toLowerCase()
  if (r === 'admin' || r === 'super' || r === 'user') return r
  return 'user'
}

export function viewsForRole(role) {
  return (ROLE_VIEWS[normalizePanelRole(role)] || ROLE_VIEWS.user).slice()
}

export function capabilitiesForRole(role) {
  return (ROLE_CAPS[normalizePanelRole(role)] || ROLE_CAPS.user).slice()
}

export function hasCapability(role, cap) {
  const caps = capabilitiesForRole(role)
  return caps.includes('*') || caps.includes(cap)
}

export function canViewPage(role, view) {
  return viewsForRole(role).includes(view)
}

export function panelIdentity(req) {
  if (req?.apiKeyKind === 'master') {
    return { user: 'master', role: 'admin', source: 'master_key' }
  }
  return {
    user: req?.panelUser || null,
    role: normalizePanelRole(req?.panelRole || 'user'),
    source: 'session',
  }
}

const USER_EXACT_GET = new Set([
  '/api/panel/me',
  '/api/panel/onboarding',
  '/api/panel/vms',
  '/api/panel/vms/create-options',
  '/api/panel/pool/stream',
  '/api/panel/proxies',
  '/api/panel/proxies/config',
  '/api/panel/api-keys',
  '/api/panel/request-logs',
  '/api/panel/request-logs/export',
  '/api/panel/request-logs/stats',
  '/api/panel/billing',
  '/api/panel/test-schedule/default',
  '/api/panel/test-models',
])

const USER_EXACT_POST = new Set([
  '/api/panel/vms/create',
  '/api/panel/vms/import',
  '/api/panel/proxies/import',
  '/api/panel/test-schedule/sync',
])

const USER_VM_DENIED = new Set([
  'fleet-status',
  'fleet-update',
  'create-options',
  'reconcile-fingerprints',
  'official-cc-bootstrap',
  'wrap-cli',
  'reset-fingerprint',
  'reconcile-fingerprint',
  'seed-settings',
  'owner',
])

function isRequestLogPath(path) {
  return (
    path === '/api/panel/request-logs' ||
    path === '/api/panel/request-logs/export' ||
    path === '/api/panel/request-logs/stats' ||
    /^\/api\/panel\/request-logs\/[^/]+$/.test(path) ||
    /^\/api\/panel\/request-logs\/[^/]+\/attempts$/.test(path)
  )
}

/** Scrolling log page + statistics: read-only, owner-scoped server-side for `user`. */
const LOG_STATS_GET = new Set([
  '/api/panel/usage-logs',
  '/api/panel/usage-logs/summary',
  '/api/panel/usage-logs/filter-options',
  '/api/panel/usage-logs/session-suggestions',
  '/api/panel/usage-logs/active-sessions',
  '/api/panel/usage-logs/overview',
  '/api/panel/statistics',
  '/api/panel/statistics/leaderboard',
])

function isSuperVmRead(path) {
  if (path === '/api/panel/vms/fleet-status' || path === '/api/panel/vms/create-options') return false
  return /^\/api\/panel\/vms\/[^/]+(?:\/claude-subscription)?$/.test(path)
}

function isSuperSchedule(method, path) {
  if (method !== 'POST') return false
  return (
    /^\/api\/panel\/vms\/[^/]+\/schedulable$/.test(path) ||
    /^\/api\/panel\/vms\/[^/]+\/cooldown\/clear$/.test(path) ||
    /^\/api\/panel\/vms\/[^/]+\/circuit\/reset$/.test(path)
  )
}

function userVmPathAllowed(method, path) {
  const m = path.match(/^\/api\/panel\/vms\/([^/]+)(?:\/(.*))?$/)
  if (!m) return false
  const id = m[1]
  const rest = m[2] || ''
  const head = rest.split('/')[0] || ''
  if (USER_VM_DENIED.has(id) || USER_VM_DENIED.has(head) || rest.startsWith('wrap-cli')) return false
  if (method === 'GET') {
    if (!rest) return true
    if (rest === 'oauth/credential' || rest === 'package') return false
    return (
      rest === 'test-schedule' ||
      rest === 'claude-subscription' ||
      rest.startsWith('oauth/') ||
      rest === 'probe' ||
      rest === 'count-tokens' ||
      rest === 'test-chat' ||
      rest === 'diagnose' ||
      rest === 'official-cc-bootstrap'
    )
  }
  if (method === 'POST') {
    if (id === 'create' || id === 'import' || id === 'package') return true
    if (!rest) return false
    if (head === 'official-cc-bootstrap' || head === 'wrap-cli' || head === 'reset-fingerprint') return false
    if (head === 'owner') return false
    return (
      rest === 'schedulable' ||
      rest === 'cooldown/clear' ||
      rest === 'circuit/reset' ||
      rest === 'probe' ||
      rest === 'test-chat' ||
      rest === 'count-tokens' ||
      rest === 'start' ||
      rest === 'stop' ||
      rest === 'recover' ||
      rest === 'openai-quota/refresh' ||
      rest === 'openai-quota/reset' ||
      rest === 'claude-reset/query' ||
      rest === 'claude-reset/redeem' ||
      rest === 'claude-subscription' ||
      rest.startsWith('oauth/')
    )
  }
  if (method === 'PUT') return rest === 'test-schedule' || rest === 'oauth/credential' || rest === 'claude-subscription'
  if (method === 'DELETE') return rest === 'test-schedule' || rest === 'claude-subscription'
  return false
}

function userProxyPathAllowed(method, path) {
  if (path === '/api/panel/proxies' && (method === 'GET' || method === 'POST')) return true
  if (path === '/api/panel/proxies/import' && method === 'POST') return true
  if (path === '/api/panel/proxies/config') return method === 'GET'
  if (path === '/api/panel/proxies/probe') return false
  if (/^\/api\/panel\/proxies\/[^/]+$/.test(path))
    return method === 'GET' || method === 'PATCH' || method === 'PUT' || method === 'DELETE'
  if (/^\/api\/panel\/proxies\/[^/]+\/reveal$/.test(path) && method === 'POST') return true
  return false
}

function userKeyPathAllowed(method, path) {
  if (path === '/api/panel/api-keys') return method === 'GET' || method === 'POST'
  if (/^\/api\/panel\/api-keys\/[^/]+$/.test(path)) return method === 'GET' || method === 'PATCH' || method === 'DELETE'
  if (/^\/api\/panel\/api-keys\/[^/]+\/reveal$/.test(path) && method === 'POST') return true
  if (/^\/api\/panel\/api-keys\/[^/]+\/stats$/.test(path) && method === 'GET') return true
  if (/^\/api\/panel\/api-keys\/[^/]+\/reset-quota$/.test(path) && method === 'POST') return true
  // The handler already 404s keys the tenant does not own (denyIfUserMissesKey).
  if (/^\/api\/panel\/api-keys\/[^/]+\/rotate$/.test(path) && method === 'POST') return true
  return false
}

function isUserAllowed(method, path) {
  const m = String(method || 'GET').toUpperCase()
  const p = String(path || '')
  if (m === 'GET' && (USER_EXACT_GET.has(p) || isRequestLogPath(p) || LOG_STATS_GET.has(p))) return true
  if (m === 'PUT' && p === '/api/panel/onboarding') return true
  if (m === 'POST' && USER_EXACT_POST.has(p)) return true
  if (p.startsWith('/api/panel/vms')) return userVmPathAllowed(m, p)
  if (p.startsWith('/api/panel/proxies')) return userProxyPathAllowed(m, p)
  if (p.startsWith('/api/panel/api-keys')) return userKeyPathAllowed(m, p)
  return false
}

export function authorizePanelRoute(method, path, role) {
  const r = normalizePanelRole(role)
  if (r === 'admin') return { ok: true, role: r }
  const m = String(method || 'GET').toUpperCase()
  const p = String(path || '')

  if (p === '/api/panel/test-schedule/default' && m === 'PUT') {
    return { ok: false, role: r, code: 'forbidden', message: '当前权限无法执行此操作' }
  }

  if (r === 'user' && isUserAllowed(m, p)) return { ok: true, role: r }
  if (p === '/api/panel/onboarding' && (m === 'GET' || m === 'PUT')) return { ok: true, role: r }
  if (
    r === 'super' &&
    m === 'GET' &&
    (p === '/api/panel/dashboard' ||
      p === '/api/panel/usage' ||
      p === '/api/panel/vms' ||
      p === '/api/panel/pool/stream' ||
      p === '/api/panel/cluster/nodes' ||
      p === '/api/panel/cluster/local' ||
      p === '/api/panel/test-models' ||
      isRequestLogPath(p) ||
      LOG_STATS_GET.has(p))
  ) {
    return { ok: true, role: r }
  }
  if (r === 'super' && m === 'GET' && isSuperVmRead(p)) return { ok: true, role: r }
  if (r === 'super' && isSuperSchedule(m, p)) return { ok: true, role: r }

  return {
    ok: false,
    role: r,
    code: 'forbidden',
    message: '当前权限无法执行此操作',
  }
}

export function mePayload(req) {
  const ident = panelIdentity(req)
  return {
    user: ident.user,
    role: ident.role,
    views: viewsForRole(ident.role),
    capabilities: capabilitiesForRole(ident.role),
    vm_create_quota: Number(req?.panelVmCreateQuota) || 0,
  }
}
