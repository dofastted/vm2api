/**
 * Commit an imported OAuth / API-key / setup-token grant onto a slot.
 * Reloads the active slot service (and eager Rust kernel when routing says so)
 * before the slot-service credential import; official CC bootstrap is scheduled after persist.
 */
import fs from 'node:fs'
import path from 'node:path'
import { atomicWriteJson, withVmLock } from '../vm/vm-file.mjs'
import { getVm, persistAccountTier, isCodexVm } from '../vm/vm-registry.mjs'
import { isSlotProxyDesynced } from '../vm/vm-runtime.mjs'
import { reloadSlotReady } from '../vm/slot-runtime.mjs'
import { resolveImportProxy } from '../vm/proxy-resolve.mjs'
import { collectSlotIdentity } from '../vm/guest-identity.mjs'
import { importWorkerCredential } from '../transport/go-worker-client.mjs'
import { credentialModeFromOauth, canOfficialCc } from './credential-mode.mjs'
import { resolveAuthScheme } from './auth-scheme.mjs'
import { flattenOauthIdentity } from './oauth-identity.mjs'
import { persistOauthToVm, writeWorkerCredentialFile } from './oauth-credentials.mjs'
import {
  officialCcUidGid,
  scheduleOfficialCcBootstrap,
  materializeOfficialClaudeCredentials,
} from './official-cc-bootstrap.mjs'
import { normalizeTiers } from '../pool/quota-tiers.mjs'

export function createImportCommit(ctx) {
  function routing() {
    return typeof ctx.getRoutingConfig === 'function' ? ctx.getRoutingConfig() : ctx.routingConfig
  }

  function rebindOauthAccount(vm) {
    const uuid = vm?.claude?.account_uuid
    if (!uuid || !vm?.id) return
    ctx.accountQuota.rebindToVm(uuid, vm.id, { email: vm.claude?.email || null })
  }

  function requireSlotProxy(existing, body = {}) {
    const resolved = resolveImportProxy({
      vm: existing,
      proxyPool: ctx.proxyPool,
      overrideUrl: body.proxy_url || null,
    })
    const allowProxyBypass = process.env.KIN_CRS_MOCK === '1' && body.require_proxy === false
    if (!resolved.ok && !allowProxyBypass) {
      const message =
        resolved.reason === 'proxy_unavailable'
          ? '虚拟机 SOCKS5 不可用，请先更换或探测代理再转换凭证'
          : '虚拟机未绑定 SOCKS5，请先分配代理再转换凭证'
      return { ok: false, status: 400, message, resolved }
    }
    return { ok: true, proxyUrl: resolved.proxyUrl, resolved }
  }

  function importedCredentialFromOauth(oauth, existing) {
    const mode = credentialModeFromOauth(oauth)
    const auth_scheme = resolveAuthScheme({
      mode,
      auth_scheme: oauth.auth_scheme || oauth.authScheme,
      extra: oauth.extra,
    })
    const identity = flattenOauthIdentity(oauth)
    if (mode === 'apikey') {
      const apiKey = String(oauth.api_key || oauth.apiKey || oauth.access_token || oauth.accessToken || '').trim()
      return {
        type: 'apikey',
        mode: 'apikey',
        api_key: apiKey,
        access_token: apiKey,
        refresh_token: null,
        expires_at: null,
        base_url: oauth.base_url || oauth.baseUrl || 'https://api.anthropic.com',
        email: identity.email || existing.claude?.email || null,
        account_uuid: identity.account_uuid || existing.claude?.account_uuid || null,
        org_uuid: identity.org_uuid || existing.claude?.org_uuid || null,
        scopes: [],
        auth_scheme,
      }
    }
    return {
      type: mode,
      mode,
      access_token: oauth.access_token || oauth.accessToken,
      refresh_token: oauth.refresh_token || oauth.refreshToken || null,
      expires_at:
        oauth.expires_at ||
        oauth.expiresAt ||
        (oauth.expires_in ? Math.floor(Date.now() / 1000) + Number(oauth.expires_in) : null),
      email: identity.email || existing.claude?.email || null,
      account_uuid: identity.account_uuid || existing.claude?.account_uuid || null,
      org_uuid: identity.org_uuid || existing.claude?.org_uuid || null,
      scopes: Array.isArray(oauth.scopes)
        ? oauth.scopes
        : String(oauth.scope || '')
            .split(/\s+/)
            .filter(Boolean),
      auth_scheme,
    }
  }

  function officialCcStatsHandler(vmId, accountUuid = null) {
    return (stats) => {
      const accountId = accountUuid || getVm(ctx.cfg.paths.project, vmId)?.claude?.account_uuid || vmId
      if (stats?.five_hour || stats?.seven_day || stats?.seven_day_oi || stats?.extra_usage) {
        try {
          ctx.accountQuota.ingestOAuthUsage(accountId, { usage_status: 200, ok: true, ...stats })
        } catch {}
      }
      if ((stats?.account_tier === 'pro' || stats?.account_tier === 'max') && stats?.limits_present === true) {
        const source = 'usage'
        try {
          ctx.accountQuota.setAccountTier(accountId, stats.account_tier, { source })
        } catch {}
        try {
          persistAccountTier(ctx.cfg.paths.project, vmId, stats.account_tier, { source })
        } catch {}
        try {
          const vm = getVm(ctx.cfg.paths.project, vmId)
          if (vm && !vm.policy?.concurrencyOverride) {
            const routingConfig = routing()
            const next = Number(
              normalizeTiers(routingConfig.tiers, routingConfig.quota, routingConfig.concurrency)[stats.account_tier]
                ?.max_concurrency ?? 2,
            )
            if (Number(vm.policy?.maxConcurrency) !== next) {
              ctx.applyVmConcurrency(vmId, next, { override: false })
            }
          }
        } catch {}
      }
    }
  }

  async function commitImportedOauth({ vmId, vmPath, existing, oauth, source, name, skipOfficialCc = false }) {
    const importedCredential = importedCredentialFromOauth(oauth, existing)
    const workerExec = {
      vmId,
      vm: existing,
      homeDir: path.join(ctx.cfg.paths.project, 'vms', vmId, 'cli-home'),
    }
    if (process.env.KIN_CRS_MOCK !== '1') {
      const socket = existing.runtime?.worker_socket
      const needReload = !socket || !fs.existsSync(socket) || isSlotProxyDesynced(existing, ctx.cfg.paths.project)
      if (needReload) {
        const boot = await reloadSlotReady(existing, ctx.cfg.paths.project, { routing: routing() })
        if (!boot.ok) {
          return { ok: false, status: 502, error: { code: 'worker_start_failed', message: boot.error } }
        }
        existing.runtime = boot.runtime
        existing.status = 'running'
        existing.schedulable = true
        existing.schedule_disabled_reason = null
        atomicWriteJson(vmPath, existing, { mode: 0o600 })
        workerExec.vm = existing
      }
    }
    let workerImport = null
    for (let attempt = 0; attempt < 30; attempt++) {
      workerImport = await importWorkerCredential(workerExec, importedCredential)
      if (workerImport.ok) break
      if (process.env.KIN_CRS_MOCK === '1') break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (!workerImport.ok) {
      return {
        ok: false,
        status: workerImport.status || 502,
        error: {
          type: 'worker_error',
          code: 'worker_credential_import_failed',
          message: workerImport.error?.message || 'Go slot worker rejected credential import',
        },
      }
    }
    await withVmLock(vmPath, () => {
      persistOauthToVm(
        vmPath,
        {
          ...importedCredential,
          source: source || oauth.source || 'sessionKey-cookie-auth',
          mode: importedCredential.mode || credentialModeFromOauth(oauth),
          type: importedCredential.type || importedCredential.mode,
        },
        { acceptLiveGrant: true },
      )
      try {
        const accountId = importedCredential.account_uuid || existing.claude?.account_uuid || vmId
        ctx.accountQuota.clearGrantRevokeLeftover(accountId)
        ctx.poolScheduler?.clearAuthCooldownFor?.(vmId, accountId)
        ctx.poolScheduler?.clearGrantRevokeCooldownFor?.(vmId, accountId)
      } catch {}
      try {
        rebindOauthAccount({ ...existing, ...JSON.parse(fs.readFileSync(vmPath, 'utf8')), id: vmId })
      } catch {}
      const refreshed = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
      existing.claude = refreshed.claude || existing.claude
      existing.schedulable = refreshed.schedulable
      existing.schedule_disabled_reason = refreshed.schedule_disabled_reason
      existing.status = refreshed.status
      if (name) existing.name = name
      existing.updated_at = new Date().toISOString()
      atomicWriteJson(vmPath, existing, { mode: 0o600 })
    })
    try {
      writeWorkerCredentialFile(workerExec.homeDir, importedCredential)
    } catch {}
    try {
      const ids = officialCcUidGid(vmId)
      materializeOfficialClaudeCredentials(workerExec.homeDir, ids)
    } catch {}
    const mode = importedCredential.mode || credentialModeFromOauth(oauth)
    const skipCc = skipOfficialCc || isCodexVm(existing) || !canOfficialCc(mode)
    const routingConfig = routing()
    const officialCc = skipCc
      ? {
          scheduled: false,
          reason: isCodexVm(existing) ? 'gpt_slot' : skipOfficialCc ? 'credential_edit' : 'credential_mode_unsupported',
        }
      : scheduleOfficialCcBootstrap({
          vmId,
          projectRoot: ctx.cfg.paths.project,
          force: true,
          collectIdentity: collectSlotIdentity,
          onStats: officialCcStatsHandler(vmId, existing.claude?.account_uuid),
          routingFile: ctx.routingConfigPath,
          config: routingConfig.official_cc,
          credentialMode: mode,
          incomingOauth: {
            account_uuid: importedCredential.account_uuid,
            email: importedCredential.email,
          },
        })
    return { ok: true, existing, official_cc_bootstrap: officialCc }
  }

  return {
    commitImportedOauth,
    requireSlotProxy,
    importedCredentialFromOauth,
    officialCcStatsHandler,
    rebindOauthAccount,
  }
}
