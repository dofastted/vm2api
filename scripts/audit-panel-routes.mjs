#!/usr/bin/env node
// Local-only smoke audit: real built UI, synthetic identity, explicit API failures.
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { resolve, join, extname } from 'node:path'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    dist: { type: 'string', default: 'web/dist' },
    playwright: { type: 'string', default: 'playwright' },
    channel: { type: 'string' },
    output: { type: 'string', default: 'panel-route-audit.json' },
  },
})
const { chromium } = createRequire(import.meta.url)(values.playwright)
const dist = resolve(values.dist)
if (!existsSync(join(dist, 'index.html'))) throw new Error('Build web/dist before running the audit')
const views = [
  'overview',
  'cluster',
  'vm',
  'import',
  'specs',
  'billing',
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
]
const tabs = [
  'sticky',
  'pool',
  'quota',
  'openai',
  'logs',
  'protocol',
  'redaction',
  'init',
  'health',
  'notify',
  'telemetry',
  'socks5',
  'backup',
  'about',
]
const routes = [
  '/',
  ...views.map((v) => `/${v}`),
  ...tabs.map((t) => `/settings/${t}`),
  '/vm/audit-fixture',
  '/login',
  '/welcome',
]
const targetSpecs = [
  { path: '/risk', chunk: 'risk', marker: '入站请求' },
  { path: '/logs?error_class=request&kind=error', chunk: 'logs', marker: '逐条请求记录' },
  { path: '/settings/sticky', chunk: '_tab', marker: 'CONTROLLED unavailable data /api/panel/routing' },
  { path: '/vm/audit-fixture', chunk: '_id', marker: 'CONTROLLED unavailable data /api/panel/vms/audit-fixture' },
]
const rootError = /Oops! Something went wrong|页面资源加载失败|页面请求失败|页面出现异常/
const server = createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname
  const file = pathname === '/cc' || pathname === '/' ? join(dist, 'index.html') : resolve(dist, `.${pathname}`)
  if (!file.startsWith(`${dist}/`) || !existsSync(file)) {
    res.writeHead(404)
    res.end()
    return
  }
  const mime = {
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.html': 'text/html',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
  }
  res.setHeader('Content-Type', mime[extname(file)] || 'application/octet-stream')
  res.end(readFileSync(file))
})
let browser
const results = []
try {
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const origin = `http://127.0.0.1:${server.address().port}`
  browser = await chromium.launch({ headless: true, ...(values.channel ? { channel: values.channel } : {}) })
  async function session(guest = false) {
    const context = await browser.newContext()
    if (!guest)
      await context.addInitScript(() => localStorage.setItem('kin_console_token', 'synthetic-local-audit-token'))
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url())
      if (url.origin !== origin) return route.abort('blockedbyclient')
      if (!url.pathname.startsWith('/api/')) return route.continue()
      const me = url.pathname === '/api/panel/me'
      return route.fulfill({
        status: me ? 200 : 503,
        contentType: 'application/json',
        body: JSON.stringify(
          me
            ? { user: 'audit', role: 'admin', views, capabilities: [] }
            : { error: { message: `CONTROLLED unavailable data ${url.pathname}` } },
        ),
      })
    })
    return context
  }
  for (const path of routes) {
    const context = await session(['/login', '/welcome'].includes(path))
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(`${origin}/cc#${path}`)
    await page.waitForTimeout(1600)
    const body = await page.locator('body').innerText()
    const expected =
      path === '/' ? '/overview' : path === '/anthropic' ? '/api' : path === '/settings' ? '/settings/sticky' : path
    const checks = {
      correctRoute: new URL(page.url()).hash === `#${expected}`,
      contentPresent: body.trim().length > 40,
      noRootError: !rootError.test(body) && !body.includes('Oops! Page Not Found!'),
      noUncaughtError: errors.length === 0,
    }
    results.push({ kind: 'baseline', path, checks, errors })
    await context.close()
  }
  for (const target of targetSpecs)
    for (const mode of ['delay', 'fail-once']) {
      const context = await session()
      const page = await context.newPage()
      const transitions = []
      await page.exposeFunction('auditUi', (state) => transitions.push(state))
      await page.addInitScript(() => {
        let previous = ''
        new MutationObserver(() => {
          const text = document.body?.innerText || ''
          const state = text.includes('Oops! Something went wrong')
            ? 'old-500'
            : text.includes('正在加载页面')
              ? 'pending'
              : text.includes('页面资源加载失败')
                ? 'resource-error'
                : 'content'
          if (state !== previous) {
            previous = state
            window.auditUi(state)
          }
        }).observe(document, { childList: true, subtree: true })
      })
      let chunkRequests = 0
      await page.route(`**/assets/${target.chunk}-*.js`, async (route) => {
        chunkRequests++
        if (mode === 'delay') await new Promise((r) => setTimeout(r, 2000))
        if (mode === 'fail-once' && chunkRequests === 1) return route.abort('failed')
        return route.continue()
      })
      await page.goto(`${origin}/cc#/api`)
      await page.waitForTimeout(1200)
      await page.evaluate((path) => {
        location.hash = path
      }, target.path)
      await page.waitForTimeout(4500)
      const body = await page.locator('body').innerText()
      const checks = {
        injected: chunkRequests > 0,
        noOld500: !transitions.includes('old-500'),
        correctFeedback: transitions.includes(mode === 'delay' ? 'pending' : 'resource-error'),
        correctRoute: new URL(page.url()).hash === `#${target.path}`,
        targetContainerPresent: (await page.locator('main').innerText()).includes(target.marker),
        noRootError: !rootError.test(body),
      }
      results.push({ kind: mode, path: target.path, chunkRequests, transitions, checks })
      await context.close()
    }
  const failures = results.filter((r) => Object.values(r.checks).some((v) => !v))
  writeFileSync(
    values.output,
    JSON.stringify(
      {
        scope: 'Local synthetic API-error and route-loading audit; not a business acceptance test',
        results,
        failures: failures.length,
      },
      null,
      2,
    ),
  )
  console.log(`${results.length} cases; ${failures.length} failures; ${values.output}`)
  if (failures.length) process.exitCode = 1
} finally {
  await browser?.close()
  await new Promise((r) => server.close(r))
}
