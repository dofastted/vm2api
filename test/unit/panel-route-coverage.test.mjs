import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const serverSrc = [
  fs.readFileSync(path.join(root, 'src/lib/admin/panel-routes.mjs'), 'utf8'),
  fs.readFileSync(path.join(root, 'src/server.mjs'), 'utf8'),
].join('\n')

function serverPanelHandlers(src) {
  const handlers = []
  const exact = /req\.method === '(GET|POST|PUT|PATCH|DELETE)' && p === '(\/api\/panel\/[^']+)'/g
  let match
  while ((match = exact.exec(src))) {
    const method = match[1]
    const pathName = match[2]
    handlers.push({ method, matchPath: (p) => p === pathName })
  }
  const regex = /req\.method === '(GET|POST|PUT|PATCH|DELETE)' && \/\^(\\\/api\\\/panel\\\/.+?)\$\/\.test\(p\)/g
  while ((match = regex.exec(src))) {
    try {
      const method = match[1]
      const re = new RegExp('^' + match[2].replace(/\\\//g, '/') + '$')
      handlers.push({ method, matchPath: (p) => re.test(p) })
    } catch {}
  }
  return handlers
}

/** Panel routes the kin-console web UI calls. Sourced from the UI, asserted against the server only. */
const PANEL_ROUTE_SAMPLES = [
  ['POST', '/api/panel/login'],
  ['POST', '/api/panel/logout'],
  ['GET', '/api/panel/dashboard'],
  ['GET', '/api/panel/database/metrics'],
  ['GET', '/api/panel/version'],
  ['GET', '/api/panel/changelog'],
  ['POST', '/api/panel/update'],
  ['GET', '/api/panel/vms'],
  ['GET', '/api/panel/vms/vm-01'],
  ['PATCH', '/api/panel/vms/vm-01'],
  ['DELETE', '/api/panel/vms/vm-01'],
  ['POST', '/api/panel/vms/vm-01/schedulable'],
  ['POST', '/api/panel/vms/vm-01/cooldown/clear'],
  ['POST', '/api/panel/vms/vm-01/circuit/reset'],
  ['POST', '/api/panel/vms/vm-01/reload'],
  ['POST', '/api/panel/vms/vm-01/collect-identity'],
  ['POST', '/api/panel/vms/vm-01/probe'],
  ['POST', '/api/panel/vms/vm-01/test-chat'],
  ['GET', '/api/panel/vms/vm-01/seed-settings'],
  ['PUT', '/api/panel/vms/vm-01/seed-settings'],
  ['GET', '/api/panel/vms/vm-01/official-cc-bootstrap'],
  ['POST', '/api/panel/vms/vm-01/official-cc-bootstrap'],
  ['POST', '/api/panel/vms/vm-01/reconcile-fingerprint'],
  ['POST', '/api/panel/vms/vm-01/oauth/generate-auth-url'],
  ['POST', '/api/panel/vms/vm-01/oauth/exchange-code'],
  ['POST', '/api/panel/vms/vm-01/oauth/to-setup-token'],
  ['POST', '/api/panel/vms/vm-01/oauth/refresh'],
  ['GET', '/api/panel/vms/vm-01/oauth/credential'],
  ['PUT', '/api/panel/vms/vm-01/oauth/credential'],
  ['POST', '/api/panel/vms/vm-01/start'],
  ['POST', '/api/panel/vms/vm-01/stop'],
  ['POST', '/api/panel/vms/vm-01/activate'],
  ['POST', '/api/panel/vms/vm-01/reset'],
  ['POST', '/api/panel/vms/vm-01/reset-fingerprint'],
  ['POST', '/api/panel/vms/vm-01/allocate-proxy'],
  ['POST', '/api/panel/vms/create'],
  ['POST', '/api/panel/vms/import'],
  ['POST', '/api/panel/vms/fleet-update'],
  ['GET', '/api/panel/wrap-cli'],
  ['POST', '/api/panel/wrap-cli/sync'],
  ['POST', '/api/panel/wrap-cli/make'],
  ['POST', '/api/panel/wrap-cli/kernel'],
  ['POST', '/api/panel/wrap-cli/kernel/release'],

  ['POST', '/api/panel/vms/vm-01/wrap-cli/promote'],
  ['POST', '/api/panel/vms/vm-01/wrap-cli/repair'],

  ['POST', '/api/panel/vms/slot-policy'],
  ['POST', '/api/panel/probe'],
  ['GET', '/api/panel/health-probe'],
  ['POST', '/api/panel/health-probe'],
  ['GET', '/api/panel/usage-probe'],
  ['POST', '/api/panel/usage-probe'],
  ['GET', '/api/panel/routing'],
  ['PUT', '/api/panel/routing'],
  ['GET', '/api/panel/distill'],
  ['PUT', '/api/panel/distill'],
  ['GET', '/api/panel/model-policy'],
  ['PUT', '/api/panel/model-policy'],
  ['POST', '/api/panel/model-policy/reset'],
  ['POST', '/api/panel/model-policy/sync-worker'],
  ['GET', '/api/panel/notify'],
  ['POST', '/api/panel/notify/check'],
  ['POST', '/api/panel/notify/test'],
  ['GET', '/api/panel/api-keys'],
  ['POST', '/api/panel/api-keys'],
  ['PATCH', '/api/panel/api-keys/k1'],
  ['DELETE', '/api/panel/api-keys/k1'],
  ['POST', '/api/panel/api-keys/k1/reset-quota'],
  ['POST', '/api/panel/api-keys/k1/reveal'],
  ['POST', '/api/panel/api-keys/k1/rotate'],
  ['GET', '/api/panel/api-endpoints'],
  ['POST', '/api/panel/api-endpoints'],
  ['PATCH', '/api/panel/api-endpoints/e1'],
  ['DELETE', '/api/panel/api-endpoints/e1'],
  ['POST', '/api/panel/api-endpoints/e1/fetch-models'],
  ['POST', '/api/panel/api-endpoints/e1/keys'],
  ['DELETE', '/api/panel/api-endpoints/e1/keys/k1'],
  ['GET', '/api/panel/proxies'],
  ['POST', '/api/panel/proxies/import'],
  ['POST', '/api/panel/proxies/probe'],
  ['POST', '/api/panel/proxies/geo'],
  ['PUT', '/api/panel/proxies/config'],
  ['POST', '/api/panel/proxies/p1/probe'],
  ['POST', '/api/panel/proxies/p1/geo'],
  ['POST', '/api/panel/proxies/p1/enable'],
  ['POST', '/api/panel/proxies/p1/disable'],
  ['POST', '/api/panel/proxies/p1/bind'],
  ['POST', '/api/panel/proxies/p1/unbind'],
  ['POST', '/api/panel/concurrent-test'],
  ['POST', '/api/panel/model-policy/sync-codex'],
  ['GET', '/api/panel/concurrent-test/job-1'],
  ['POST', '/api/panel/concurrent-test/job-1/cancel'],
  ['GET', '/api/panel/concurrent-test-reports'],
  ['GET', '/api/panel/concurrent-test-reports/2026-08-25/r.md'],
  ['POST', '/api/panel/probe-test'],
  ['GET', '/api/panel/probe-test'],
  ['GET', '/api/panel/probe-test/job-1'],
  ['POST', '/api/panel/probe-test/job-1/cancel'],
]

test('panel route samples all have server handlers', () => {
  const handlers = serverPanelHandlers(serverSrc)
  assert.ok(handlers.length > 50, `expected panel handlers, got ${handlers.length}`)
  const missing = []
  for (const [method, sample] of PANEL_ROUTE_SAMPLES) {
    const ok = handlers.some((handler) => handler.method === method && handler.matchPath(sample))
    if (!ok) missing.push(`${method} ${sample}`)
  }
  assert.deepEqual(missing, [])
})

test('ACL schedule POSTs still have handlers', () => {
  assert.match(serverSrc, /cooldown\\\/clear/)
  assert.match(serverSrc, /clearVmCooldown/)
  assert.match(serverSrc, /\/schedulable\$/)
})

test('settings save imports public routing notify helpers', () => {
  const routes = fs.readFileSync(path.join(root, 'src/lib/admin/panel-routes.mjs'), 'utf8')
  assert.match(
    routes,
    /import\s*\{[^}]*publicNotifyConfig[^}]*publicRoutingNotify[^}]*\}\s*from\s*['"]\.\/notify\.mjs['"]/,
  )
})
