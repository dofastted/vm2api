import type { Vm } from '@/types/panel-vm'
import { describe, expect, it } from 'vitest'
import {
  geminiAccountStatus,
  geminiAuthorizationLabel,
  geminiHostBlocker,
  geminiInferenceErrorLabel,
  geminiInferenceLabel,
} from './gemini-account-status'
import {
  accountStatus,
  accountUsable,
  credentialStatus,
  fleetCounts,
  poolStatus,
  vmCredDead,
} from './vm-status'

type Environment = NonNullable<Vm['gemini']>
type Inference = NonNullable<Environment['last_inference']>

const candidate: Environment = {
  id: 'gemini-01',
  name: 'Gemini',
  proxy_id: 'proxy-01',
  auth_state: 'authorized',
  auth_method: 'oauth',
  runtime_ready: false,
  billing_ready: false,
  proxy_ready: true,
  kernel_version: '0.3.0',
  created_at: null,
  updated_at: null,
  models_discovered: true,
  models: ['gemini-2.5-pro'],
  account: null,
}

function evidence(
  state: Inference['state'],
  error_code: string | null = null
): Inference {
  return {
    state,
    model: candidate.models[0],
    started_at: '2026-11-22T09:00:00Z',
    finished_at: state === 'running' ? null : '2026-11-22T09:00:05Z',
    error_code,
  }
}

function slot(gemini: Environment): Vm {
  return {
    id: gemini.id,
    gemini,
    has_token: gemini.auth_state === 'authorized',
  }
}

describe('Gemini account presentation', () => {
  it('separates credential provenance from model discovery and host verification', () => {
    const imported: Environment = { ...candidate, oauth_imported: true }
    const apiKey: Environment = { ...candidate, auth_method: 'api_key' }
    expect(geminiAuthorizationLabel(imported)).toBe('已导入 OAuth 凭证')
    expect(geminiAuthorizationLabel(candidate)).toBe('已完成官方 Google 授权')
    expect(geminiAuthorizationLabel(apiKey)).toBe('已配置 API Key')
    expect(geminiAccountStatus(imported)).toMatchObject({
      blocker: '需完成官方 Google 授权',
      group: 'unschedulable',
      modelsLabel: '已发现 1 个模型',
    })
    expect(vmCredDead(slot(imported))).toBe(false)
    for (const environment of [candidate, apiKey]) {
      expect(geminiAccountStatus(environment)).toMatchObject({
        blocker: null,
        group: 'pending',
        tone: { cls: 'none', text: '待验证' },
        modelsLabel: '已发现 1 个模型',
      })
      expect(geminiInferenceLabel(environment)).toBe('尚无宿主推理记录')
      expect(accountUsable(slot(environment))).toBe(false)
    }
  })

  it('does not mistake undiscovered account model metadata for callable models', () => {
    expect(
      geminiAccountStatus({ ...candidate, models_discovered: false })
    ).toMatchObject({
      group: 'unschedulable',
      modelsLabel: '尚未拉取模型',
    })
    expect(geminiAccountStatus({ ...candidate, models: [] })).toMatchObject({
      group: 'unschedulable',
      modelsLabel: '未发现可调用模型',
    })
    expect(
      geminiAccountStatus({ ...candidate, proxy_ready: false })
    ).toMatchObject({
      group: 'unschedulable',
      blocker: '绑定代理不可用',
    })
    expect(
      geminiAccountStatus({
        ...candidate,
        crag_license: {
          product: 'craggemini',
          status: 'unlicensed',
          valid: false,
          code: 'license_required',
        },
      })
    ).toMatchObject({
      group: 'unschedulable',
      blocker: '未绑定 CRAGGemini 订阅席位',
    })
    expect(
      geminiAccountStatus({
        ...candidate,
        crag_license: {
          product: 'craggemini',
          status: 'valid',
          valid: true,
          seat: 1,
        },
      })
    ).toMatchObject({
      group: 'pending',
      blocker: null,
    })
  })

  it('shows known host blockers without treating them as credential failures', () => {
    expect(
      geminiHostBlocker(candidate, {
        available: true,
        payload_state: 'install_on_create',
      })
    ).toBe('宿主尚未安装签名载荷')
    expect(
      geminiHostBlocker(candidate, {
        available: true,
        payload_state: 'awaiting_redemption',
      })
    ).toBe('请先兑换 CRAGGemini 内核')
    expect(
      geminiHostBlocker(
        candidate,
        { available: true, payload_state: 'invalid' },
        '载荷校验失败'
      )
    ).toBe('载荷校验失败')
    const inventory = {
      available: true,
      payload_state: 'installed',
      oauth_runtime_issue: 'gemini_egress_unavailable',
    }
    const hostBlocker = geminiHostBlocker(candidate, inventory)
    expect(geminiAccountStatus(candidate, hostBlocker)).toMatchObject({
      blocker: '宿主缺少可用的 kin-egress',
      group: 'unschedulable',
    })
    expect(geminiHostBlocker({ auth_method: 'api_key' }, inventory)).toBeNull()
    const blocked = { ...slot(candidate), unschedulable_text: hostBlocker }
    expect(vmCredDead(blocked)).toBe(false)
    expect(credentialStatus(blocked).text).toBe('已完成官方 Google 授权')
  })

  it.each([
    ['running', 'pending', '宿主推理进行中'],
    ['completed', 'host_verified', '上次宿主推理成功'],
    ['failed', 'host_failed', '上次宿主推理失败'],
    ['cancelled', 'pending', '上次宿主推理已取消'],
  ] as const)(
    'projects %s as %s with scoped evidence',
    (state, group, text) => {
      const last_inference = evidence(state)
      const environment = { ...candidate, last_inference }
      expect(geminiAccountStatus(environment)).toMatchObject({
        group,
        inference: { text },
        lastInference: last_inference,
      })
      expect(geminiInferenceLabel(environment)).toBe(text)
    }
  )

  it('does not mistake a failed host request for an invalidated credential', () => {
    const failed = slot({
      ...candidate,
      auth_method: 'api_key',
      last_inference: evidence('failed', 'gemini_api_key_invalid'),
    })
    expect(credentialStatus(failed)).toMatchObject({
      cls: 'none',
      text: '已配置 API Key',
    })
    expect(accountStatus(failed)).toMatchObject({
      cls: 'caution',
      text: '上次宿主推理失败',
    })
    expect(vmCredDead(failed)).toBe(false)
    expect(
      vmCredDead(slot({ ...candidate, auth_state: 'reauth_required' }))
    ).toBe(true)
    expect(geminiInferenceErrorLabel('gemini_location_unsupported')).toBe(
      'Google 地区资格受限'
    )
    expect(
      geminiInferenceErrorLabel('gemini_account_verification_required')
    ).toBe('Google 账号需先完成浏览器验证')
    expect(geminiInferenceErrorLabel('gemini_account_ineligible')).toBe(
      'Google 账号不符合 Antigravity 资格'
    )
    expect(geminiInferenceErrorLabel('license_required')).toBe(
      '未绑定 CRAGGemini 订阅席位'
    )
    expect(geminiInferenceErrorLabel('gemini_native_worker_unavailable')).toBe(
      '宿主运行环境故障'
    )
    expect(geminiInferenceErrorLabel('gemini_inference_failed')).toBe(
      '未知原因'
    )
    expect(geminiInferenceErrorLabel('raw upstream failure or secret')).toBe(
      '未知原因'
    )
    expect(geminiInferenceErrorLabel(null)).toBe('未知原因')
  })

  it('uses only current inventory evidence after a rebind or restart', () => {
    const verified = slot({
      ...candidate,
      last_inference: evidence('completed'),
    })
    const rebound: Environment = {
      ...candidate,
      proxy_id: 'proxy-02',
      last_inference: null,
    }
    expect(poolStatus(verified).text).toBe('上次宿主推理成功')
    expect(poolStatus(slot(rebound))).toMatchObject({
      cls: 'none',
      text: '待验证',
    })
    expect(geminiInferenceLabel(rebound)).toBe('尚无宿主推理记录')
    expect(accountUsable(verified)).toBe(false)
    const claude: Vm = { id: 'vm-01', has_token: true }
    const codex: Vm = { id: 'vm-02', platform: 'openai', has_token: true }
    expect(fleetCounts([claude, codex, verified, slot(rebound)])).toMatchObject(
      {
        all: 4,
        pool: 2,
        host_verified: 1,
        pending: 1,
        bad: 0,
      }
    )
    expect([claude, codex].map(accountUsable)).toEqual([true, true])
  })
})
