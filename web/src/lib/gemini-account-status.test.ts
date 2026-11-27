import type { Vm } from '@/types/panel-vm'
import { describe, expect, it } from 'vitest'
import { geminiSlot } from '@/features/vm/gemini-slot'
import {
  DEFAULT_GEMINI_TEST_PROMPT,
  defaultGeminiTestModel,
  geminiAccountStatus,
  geminiAuthorizationLabel,
  geminiEligibilityNotice,
  geminiHostBlocker,
  geminiInferenceErrorAction,
  geminiInferenceErrorLabel,
  geminiInferenceLabel,
  groupGeminiModels,
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
    expect(
      geminiHostBlocker(candidate, {
        available: true,
        payload_state: 'installed',
        oauth_runtime_issue: 'gemini_sandbox_apparmor_restricted',
      })
    ).toBe('宿主 AppArmor 限制了 Gemini 沙箱')
    expect(
      geminiHostBlocker(candidate, {
        available: true,
        payload_state: 'installed',
        oauth_runtime_issue: 'gemini_sandbox_unavailable',
      })
    ).toBe('宿主非特权沙箱（bwrap）不可用')
    expect(
      geminiInferenceErrorLabel('gemini_sandbox_apparmor_restricted')
    ).toBe('宿主 AppArmor 限制了 Gemini 沙箱')
    expect(
      geminiInferenceErrorAction('gemini_sandbox_apparmor_restricted')
    ).toContain('prepare-gemini')
    expect(geminiInferenceErrorLabel('gemini_sandbox_unavailable')).toBe(
      '宿主非特权沙箱不可用'
    )
    expect(geminiInferenceErrorAction('gemini_sandbox_unavailable')).toContain(
      'bubblewrap'
    )
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
      'Google 403：地区或账号受限'
    )
    expect(
      geminiInferenceErrorLabel('gemini_account_verification_required')
    ).toBe('Google 账号需先完成浏览器验证')
    expect(geminiInferenceErrorLabel('gemini_account_ineligible')).toBe(
      'Google 账号不符合资格或可能已停用'
    )
    expect(geminiInferenceErrorLabel('license_required')).toBe(
      '未绑定 CRAGGemini 订阅席位'
    )
    expect(geminiInferenceErrorLabel('gemini_native_worker_unavailable')).toBe(
      '宿主运行环境故障'
    )
    expect(geminiInferenceErrorLabel('gemini_authorization_unavailable')).toBe(
      '宿主运行环境故障'
    )
    expect(geminiInferenceErrorLabel('gemini_inference_failed')).toBe(
      '上游推理失败（502）'
    )
    expect(geminiInferenceErrorLabel('gemini_upstream_unavailable')).toBe(
      '上游服务暂时不可用（503）'
    )
    expect(geminiInferenceErrorLabel('gemini_pool_overloaded')).toBe(
      '号池高负载（全部账号不可调度）'
    )
    expect(geminiInferenceErrorLabel('raw upstream failure or secret')).toBe(
      '未知原因'
    )
    expect(geminiInferenceErrorLabel(null)).toBe('未知原因')

    // 502 persisted unschedulable state projects to unschedulable schedule_state and accurate error text.
    const parked502 = geminiSlot({
      ...candidate,
      unschedulable: {
        reason: 'upstream_502',
        detail: '502 bad gateway',
        at: '2026-11-26T12:00:00Z',
        upstream_status: 502,
      },
    })
    expect(parked502.schedule_state).toBe('unschedulable')
    expect(parked502.unschedulable_reason).toBe('upstream_502')
    expect(parked502.unschedulable_text).toBe('上游 502 异常 · 已暂停调度')
    expect(parked502.unschedulable_detail).toMatchObject({
      message: '502 bad gateway',
      upstream_status: 502,
    })
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

  it('defaults test prompt to hello and selects Gemini 4 neon when available', () => {
    expect(DEFAULT_GEMINI_TEST_PROMPT).toBe('hello')
    expect(
      defaultGeminiTestModel([
        'gemini-3-flash',
        'gemini-4-neon-high',
        'gemini-3.8-flash-high',
      ])
    ).toBe('gemini-4-neon-high')
    expect(
      defaultGeminiTestModel([
        'gemini-4-neon-high',
        'gemini-4-neon',
        'gemini-3-flash',
      ])
    ).toBe('gemini-4-neon')
    expect(
      defaultGeminiTestModel(['gemini-3-flash', 'gemini-4-neon-medium'])
    ).toBe('gemini-4-neon-medium')
    expect(defaultGeminiTestModel(['gemini-3-flash', 'gemini-2.5-pro'])).toBe(
      'gemini-3-flash'
    )
    expect(defaultGeminiTestModel([])).toBe('')
  })

  it('provides actionable remediation copy for upstream errors and validates Google verification links', () => {
    expect(
      geminiInferenceErrorAction('gemini_account_verification_required')
    ).toContain('验证链接')
    expect(geminiInferenceErrorAction('gemini_location_unsupported')).toContain(
      '实际对话'
    )
    expect(geminiInferenceErrorAction('gemini_location_unsupported')).toContain(
      '代理'
    )
    expect(geminiInferenceErrorAction('gemini_account_ineligible')).toContain(
      'TOS_VIOLATION'
    )
    expect(geminiInferenceErrorAction('gemini_account_ineligible')).toContain(
      '申诉'
    )
    expect(geminiInferenceErrorAction('gemini_quota_exhausted')).toContain(
      '配额'
    )
    expect(geminiInferenceErrorAction('gemini_oauth_required')).toContain(
      '重新完成官方 Google 授权'
    )
    expect(geminiInferenceErrorAction('gemini_proxy_error')).toContain('SOCKS5')
    expect(geminiInferenceErrorAction('gemini_inference_failed')).toContain(
      '刷新'
    )
    expect(
      geminiInferenceErrorAction('gemini_native_worker_unavailable')
    ).toContain('Gemini 维护')
    expect(
      geminiInferenceErrorAction('gemini_authorization_unavailable')
    ).toContain('授权进程')
    expect(geminiInferenceErrorAction('license_unconfigured')).toContain(
      '订阅 CRAG'
    )
    expect(geminiInferenceErrorAction('license_unconfigured')).not.toContain(
      '设置 → CRAG 订阅'
    )
    expect(geminiInferenceErrorAction('unknown_raw_code')).toBeNull()

    const validUrl =
      'https://accounts.google.com/v3/signin/continue?plt=abc&sarp=1'
    expect(
      geminiEligibilityNotice({
        eligibility: 'verification_required',
        validation_url: validUrl,
      })
    ).toMatchObject({
      label: expect.stringContaining('VALIDATION_REQUIRED'),
      validationUrl: validUrl,
    })
    expect(
      geminiEligibilityNotice({
        eligibility: 'verification_required',
        validation_url: 'https://evil.example/phish',
      })?.validationUrl
    ).toBeNull()
    expect(
      geminiEligibilityNotice({
        eligibility: 'client_unsupported',
      })
    ).toMatchObject({
      label: expect.stringContaining('UNSUPPORTED_CLIENT'),
      action: expect.stringContaining('设置 → Gemini 维护'),
      validationUrl: null,
      advisory: false,
    })
    expect(geminiInferenceErrorLabel('gemini_client_unsupported')).toContain(
      'UNSUPPORTED_CLIENT'
    )
    expect(geminiInferenceErrorAction('gemini_client_unsupported')).toContain(
      'UNSUPPORTED_CLIENT'
    )
    expect(geminiEligibilityNotice({ eligibility: null })).toBeNull()

    const stale = {
      eligibility: 'verification_required',
      checked_at: '2026-11-24T01:00:00Z',
    }
    const run = (state: 'completed' | 'failed', finished_at: string) => ({
      state,
      finished_at,
    })
    // 验证后重新推理成功：旧资格结论不再提示。
    expect(
      geminiEligibilityNotice(stale, run('completed', '2026-11-24T02:00:00Z'))
    ).toBeNull()
    // 推理早于这次账号检查，或推理失败：仍要提示。
    expect(
      geminiEligibilityNotice(stale, run('completed', '2026-11-24T00:00:00Z'))
    ).not.toBeNull()
    expect(
      geminiEligibilityNotice(stale, run('failed', '2026-11-24T02:00:00Z'))
    ).not.toBeNull()
    // 账号没有检查时间戳（面板的 checked_at 无兜底，缺字段就下发 null）时，
    // 无法证明这次推理比资格结论更新，必须保留提示——否则后端仍按
    // eligibility 冷却该账号，面板却不再显示验证入口。
    expect(
      geminiEligibilityNotice(
        { eligibility: 'verification_required' },
        run('completed', '2026-11-24T02:00:00Z')
      )
    ).not.toBeNull()
    expect(
      geminiEligibilityNotice(
        { eligibility: 'verification_required', checked_at: null },
        run('completed', '2026-11-24T02:00:00Z')
      )
    ).not.toBeNull()
    expect(
      geminiEligibilityNotice(
        { eligibility: 'verification_required', checked_at: 'not-a-date' },
        run('completed', '2026-11-24T02:00:00Z')
      )
    ).not.toBeNull()
  })

  it('groups Antigravity models into Google Gemini vs ag- prefixed Anthropic and OpenAI', () => {
    const groups = groupGeminiModels(
      [
        'claude-sonnet-4-6-high',
        'gemini-4-neon',
        'gemini-4-argon',
        'gpt-oss-120b-medium',
      ],
      [
        {
          id: 'claude-sonnet-4-6-high',
          provider: 'anthropic',
          quota_group: '3p',
        },
        { id: 'gemini-4-neon', provider: 'google', quota_group: 'gemini' },
        {
          id: 'gemini-4-argon',
          provider: 'google',
          quota_group: 'gemini-argon-wtu',
        },
        { id: 'gpt-oss-120b-medium', provider: 'openai', quota_group: '3p' },
      ]
    )
    expect(groups.map((g) => g.provider)).toEqual([
      'google',
      'anthropic',
      'openai',
    ])
    expect(groups[0].models.map((m) => m.publicId)).toEqual([
      'gemini-4-neon',
      'gemini-4-argon',
    ])
    expect(groups[1].models[0]).toMatchObject({
      rawId: 'claude-sonnet-4-6-high',
      publicId: 'ag-claude-sonnet-4-6-high',
      quotaGroup: '3p',
    })
    expect(groups[2].models[0]).toMatchObject({
      rawId: 'gpt-oss-120b-medium',
      publicId: 'ag-gpt-oss-120b-medium',
      quotaGroup: '3p',
    })
  })
})

describe('gemini_native_config_invalid status copy', () => {
  it('renders dedicated label and alignment action', () => {
    expect(geminiInferenceErrorLabel('gemini_native_config_invalid')).toBe(
      'CRAGGemini 配置被载荷拒绝'
    )
    expect(
      geminiInferenceErrorAction('gemini_native_config_invalid')
    ).toContain('对齐宿主脚本与签名载荷版本')
  })

  it('aligns CRAGGemini license mismatch, sync pending, and invalid guidance with real UI actions', () => {
    expect(geminiInferenceErrorLabel('license_payload_key_mismatch')).toBe(
      'CRAGGemini 许可与当前载荷版本不匹配'
    )
    expect(
      geminiInferenceErrorAction('license_payload_key_mismatch')
    ).toContain('重新绑定 CRAG 席位')
    expect(geminiInferenceErrorLabel('gemini_subscription_sync_pending')).toBe(
      'CRAGGemini 宿主订阅同步中'
    )
    expect(
      geminiInferenceErrorAction('gemini_subscription_sync_pending')
    ).toContain('继续同步订阅')
    expect(geminiInferenceErrorAction('license_invalid')).toContain(
      '重新绑定 CRAG 席位'
    )
    expect(geminiInferenceErrorAction('license_invalid')).not.toContain(
      '释放后重新绑定'
    )
    expect(
      geminiAccountStatus({
        ...candidate,
        crag_license: {
          product: 'craggemini',
          status: 'invalid',
          valid: false,
          code: 'license_payload_key_mismatch',
        },
      })
    ).toMatchObject({
      group: 'unschedulable',
      blocker: 'CRAGGemini 许可与当前载荷版本不匹配',
    })
  })
})
