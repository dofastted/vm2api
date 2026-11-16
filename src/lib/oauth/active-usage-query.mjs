import path from 'node:path'
import { canOfficialUsage, credentialModeOfVm } from './credential-mode.mjs'
import {
  probeVmUsage,
  isOfficialUsageRateLimited,
  usageErrorText,
  usageProbeBackoffRemainingMs,
} from './crs-usage-probe.mjs'
import { getUsageCache } from './usage-cache.mjs'
import { isCodexVm, vmHasClaudeCredential } from '../vm/vm-registry.mjs'

function failure(status, code, message) {
  return { status, body: { ok: false, error: { code, message } } }
}

/** Explicit user action: fresh official usage, no model request or cached-success fallback. */
export function createActiveUsageQuery({ probe = probeVmUsage } = {}) {
  const flights = new Map()
  return async function query({ projectRoot, vm, accountQuota }) {
    if (!vm) return failure(404, 'vm_not_found', '槽位不存在')
    if (isCodexVm(vm)) return failure(400, 'unsupported_platform', '请使用 GPT 额度查询')
    if (!vmHasClaudeCredential(vm)) return failure(400, 'no_oauth_token', '请先导入账号凭证')
    if (!canOfficialUsage(credentialModeOfVm(vm))) {
      return failure(400, 'usage_scope_required', '当前凭证不支持官方额度查询，请导入完整 OAuth')
    }
    const accountId = vm.claude?.account_uuid || vm.id
    const key = `${projectRoot}:${vm.id}:${accountId}`
    if (flights.has(key)) return await flights.get(key)
    const pending = (async () => {
      const account = await accountQuota.ensure({ account_id: accountId, vm_id: vm.id })
      const backoff = usageProbeBackoffRemainingMs(account.unified)
      if (backoff > 0) {
        return failure(429, 'usage_rate_limited', `官方额度查询限流，请约 ${Math.ceil(backoff / 1000)} 秒后重试`)
      }
      const exec = { vmId: vm.id, homeDir: path.join(projectRoot, 'vms', vm.id, 'cli-home'), oauth: vm.claude, vm }
      let result
      try {
        result = await probe({ exec, vm, includeFable: false, timeoutMs: 30_000 })
      } catch {
        return failure(502, 'usage_query_failed', '官方额度查询失败，请稍后重试')
      }
      if (isOfficialUsageRateLimited(result)) {
        await accountQuota.ingestOAuthUsage(accountId, result)
        return failure(429, 'usage_rate_limited', '官方额度查询限流，请稍后重试')
      }
      if (!result.ok || !('usage_status' in result) || result.usage_status !== 200 || result.limits_present !== true) {
        const message =
          'usage_scope_missing' in result && result.usage_scope_missing
            ? '当前凭证缺少额度查询权限，请重新导入完整 OAuth'
            : usageErrorText(result) || '官方接口未返回完整额度数据'
        return failure(502, 'usage_query_failed', message)
      }
      await accountQuota.ingestOAuthUsage(accountId, result)
      getUsageCache().clear(accountId)
      return {
        status: 200,
        body: {
          ok: true,
          data: {
            vm_id: vm.id,
            source: 'official-cc-usage',
            probed_at: result.probed_at,
            five_hour: result.five_hour,
            seven_day: result.seven_day,
            seven_day_oi: result.seven_day_oi,
          },
        },
      }
    })()
    flights.set(key, pending)
    try {
      return await pending
    } finally {
      flights.delete(key)
    }
  }
}

export const queryActiveUsage = createActiveUsageQuery()
