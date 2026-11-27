import { useEffect, useRef, useState } from 'react'
import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { VmCircuit } from '@/types/panel-vm'
import { Check, Copy, ExternalLink } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { copyText } from '@/lib/clipboard'
import {
  type GeminiModelCatalogEntry,
  geminiAccountErrorText,
  geminiAuthorizationLabel,
  geminiEligibilityNotice,
  geminiInferenceErrorAction,
  geminiInferenceLabel,
  geminiInferenceErrorLabel,
  geminiUnschedulableLabel,
  groupGeminiModels,
} from '@/lib/gemini-account-status'
import { isGeminiHostIssue } from '@/lib/gemini-recovery'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { WsTerminal } from '@/components/ws-terminal-lazy'
import { GeminiRedeemDialog } from '@/features/billing/gemini-redeem-dialog'
import {
  buildNodePoolsIndex,
  NodePoolBadges,
} from '@/features/pools/node-pool-badges'
import { WeightTierBadge } from '@/features/pools/pool-badges'
import { schedulerPoolsQueryOptions } from '@/features/pools/queries'
import { GeminiMaintenanceLink } from '@/features/settings/gemini-maintenance-link'
import { usersQueryOptions } from '@/features/users/queries'
import { resolveOwnerUsername } from '@/features/vm/vm-owner'
import {
  GEMINI_IMPORT_FORMAT_LABELS,
  type ParsedGeminiImportResult,
  parseGeminiAccountImportText,
  readGeminiAccountImportFile,
} from './gemini-account-import'
import {
  GEMINI_INVENTORY_KEY as QUERY_KEY,
  GEMINI_ROOT as ROOT,
  geminiProxyOptionLabel,
  geminiProxyOptions,
  type GeminiProxy,
  geminiError,
  isGeminiProxy,
  syncGeminiEnvironment,
  useGeminiBusy,
  useGeminiMutation,
} from './gemini-operations'
import { GeminiProxyPanel } from './gemini-proxy-panel'
import { GeminiTestPanel } from './gemini-test-panel'

type QuotaReading = {
  remaining_fraction: number | null
  reset_at: string | null
}

export type GeminiInferenceStatus = {
  state: 'running' | 'completed' | 'failed' | 'cancelled'
  model: string
  started_at: string
  finished_at: string | null
  error_code: string | null
}

export type GeminiCragLicense = {
  product: string
  status: string
  valid: boolean
  seat_required?: boolean
  scope?: string | null
  seat?: number | null
  payload_key_id?: string | null
  sync_pending?: boolean
  expires_at?: number | null
  code?: string | null
  message?: string | null
}

export type GeminiCragSubscription = {
  configured: boolean
  active: boolean
  product: string
  host_id: string | null
  sync_pending: boolean
  version: number | null
  revision: number | null
  issued_at: number | null
  expires_at: number | null
  slot_limit: number | 'unlimited'
  used_slots: number | null
  available_slots: number | null
  reclaim_supported: boolean
}

export type GeminiEnvironmentUsage = {
  today_cost: number
  today_requests: number
  today_tokens: number
  today_input_tokens: number
  today_output_tokens: number
  today_cache_read_tokens: number
  today_cache_creation_tokens: number
  cache_hit_rate: number | null
  window_5h_cost: number
  window_5h_requests: number
  window_5h_tokens: number
  window_7d_cost: number
  window_7d_requests: number
  window_7d_success: number
  window_7d_errors: number
  window_7d_tokens: number
  total_cost: number
  total_tokens: number
  health_24h: Array<[number, number]> | null
}

export type GeminiEnvironmentRestriction = {
  reason: string
  text: string
  until: number | null
}

export type GeminiEnvironmentUnschedulable = {
  reason: string
  detail?: string
  at?: string
  upstream_status?: number
  error_code?: string
}

export type GeminiEnvironment = {
  id: string
  name: string
  proxy_id: string
  owner_user_id?: string | null
  schedulable?: boolean
  schedule_level?: number
  schedule_level_mode?: 'auto' | 'manual'
  unschedulable?: GeminiEnvironmentUnschedulable | null
  unschedulable_reason?: string | null
  unschedulable_detail?: string | null
  unschedulable_at?: string | null
  restriction?: GeminiEnvironmentRestriction | null
  circuit?: VmCircuit | null
  auth_state:
    'unverified' | 'authorizing' | 'authorized' | 'reauth_required' | 'disabled'
  runtime_ready: boolean
  billing_ready: boolean
  proxy_ready?: boolean
  auth_method: 'oauth' | 'api_key'
  oauth_imported?: boolean
  kernel_version: string | null
  max_concurrency?: number
  active_slots?: number
  inflight?: number
  usage?: GeminiEnvironmentUsage | null
  created_at: string | null
  updated_at: string | null
  models: string[]
  models_discovered?: boolean
  last_inference?: GeminiInferenceStatus | null
  crag_license?: GeminiCragLicense | null
  account: {
    state: 'ok' | 'partial' | 'error' | 'reauth_required'
    checked_at: string | null
    data_at?: string | null
    email: string | null
    project_id: string | null
    region: string | null
    plan: string | null
    expires_at: string | null
    eligibility?:
      | 'verification_required'
      | 'location_unsupported'
      | 'client_unsupported'
      | 'ineligible'
      | null
    validation_url?: string | null
    error_code?: string | null
    error_message?: string | null
    http_status?: number | null
    model_catalog?: GeminiModelCatalogEntry[]
    quotas: (QuotaReading & { model: string })[]
    quota_groups?: {
      name: string
      windows: (QuotaReading & { id: string; period: '5h' | 'weekly' })[]
    }[]
    credits: { type: string; amount: string }[]
  } | null
}

export type GeminiInventory = {
  available: boolean
  host_message?: string
  payload_state?:
    | 'installed'
    | 'install_on_create'
    | 'awaiting_redemption'
    | 'not_configured'
    | 'invalid'
    | 'unknown'
  payload_mode?: 'legacy_release' | 'crag_subscription'
  payload_issue?: keyof typeof PAYLOAD_ISSUES | null
  release_activated?: boolean | null
  oauth_runtime_issue?: keyof typeof OAUTH_ISSUES | null
  crag_subscription?: GeminiCragSubscription | null
  environments: GeminiEnvironment[]
}
type Authorization = { url: string; attempt_id: string }

const PAYLOAD_ISSUES = {
  gemini_public_key_missing: '缺少 Gemini 发行公钥。',
  gemini_payload_source_missing: '缺少 Antigravity 签名载荷安装源。',
  gemini_payload_incomplete: 'Antigravity 签名载荷不完整或不可执行。',
  gemini_payload_invalid: 'Gemini 载荷校验失败，请检查宿主服务日志。',
  gemini_payload_not_installed: '请先在宿主机安装签名载荷。',
  gemini_release_not_configured: '缺少 CRAGGemini 发行授权配置。',
  gemini_release_invalid: 'CRAGGemini 发行授权配置无效，请联系部署管理员。',
  gemini_release_payload_mismatch: 'CRAGGemini 发行授权配置与签名载荷不匹配。',
}

const CRAG_LICENSE_SANDBOX_CODES = new Set([
  'gemini_sandbox_apparmor_restricted',
  'gemini_sandbox_unavailable',
])

const OAUTH_ISSUES = {
  gemini_oauth_tools_missing: '宿主缺少 Google 授权所需工具。',
  gemini_egress_unavailable: '宿主缺少可用的 kin-egress。',
  gemini_ipv4_forwarding_unavailable: '宿主 IPv4 转发未就绪。',
  gemini_sandbox_apparmor_restricted:
    '宿主机 AppArmor 限制了非特权 user namespace，导致 Gemini 沙箱无法启动，请前往「设置 → Gemini 维护」修复或在宿主机运行 prepare-gemini。',
  gemini_sandbox_unavailable:
    '宿主机非特权沙箱（bwrap）不可用，无法启动 Gemini 隔离进程。',
}

export function geminiPayloadIssue(inventory?: GeminiInventory) {
  if (inventory?.payload_issue) return PAYLOAD_ISSUES[inventory.payload_issue]
  if (inventory?.payload_state === 'invalid')
    return PAYLOAD_ISSUES.gemini_payload_invalid
  if (inventory?.payload_state === 'not_configured')
    return '缺少签名载荷安装源或发行公钥。'
  if (
    inventory?.available &&
    (!inventory.payload_state || inventory.payload_state === 'unknown')
  )
    return '宿主未报告可识别的载荷状态，请对齐版本。'
  return null
}

export function GeminiStartupStatus({
  inventory,
}: {
  inventory: GeminiInventory
}) {
  if (!inventory.available)
    return (
      <div className='space-y-2'>
        <p role='status' className='text-sm'>
          {inventory.host_message || '未检测到可用的 Gemini 宿主服务。'}
        </p>
        <GeminiMaintenanceLink />
      </div>
    )
  const payloadIssue = geminiPayloadIssue(inventory)
  return (
    <div className='space-y-1 text-sm'>
      {payloadIssue ? <p role='status'>{payloadIssue}</p> : null}
      {inventory.payload_state === 'awaiting_redemption' ? (
        <p role='status'>
          CRAGGemini 内核已安装，等待兑换。请前往{' '}
          <Link to='/crag-subscription' className='text-primary underline'>
            订阅 CRAG
          </Link>{' '}
          兑换当前版本的 CRAGGemini 内核。
        </p>
      ) : null}
      {inventory.payload_state === 'install_on_create' ? (
        <p role='status'>首次创建时自动校验并安装 Gemini 内核和官方 CLI。</p>
      ) : null}
      {inventory.payload_mode === 'crag_subscription' ? (
        inventory.crag_subscription?.active ? (
          <p role='status'>
            CRAGGemini 宿主订阅已激活（席位{' '}
            {inventory.crag_subscription.used_slots ?? 0} /{' '}
            {inventory.crag_subscription.slot_limit === 'unlimited'
              ? '不限'
              : inventory.crag_subscription.slot_limit}
            ，剩余 {inventory.crag_subscription.available_slots ?? '—'}
            {inventory.crag_subscription.expires_at
              ? ` · 到期 ${localTime(new Date(inventory.crag_subscription.expires_at * 1000).toISOString())}`
              : ''}
            ）。
          </p>
        ) : inventory.crag_subscription?.sync_pending ? (
          <p role='status'>
            CRAGGemini
            宿主订阅正在同步上次变更（已兑换记录仍保留），请点击「继续同步订阅」或稍候自动恢复。
          </p>
        ) : (
          <p role='status'>
            CRAGGemini 宿主订阅未激活：OAuth
            环境需先兑换订阅码并绑定席位后方可调度与测试（纯 API Key
            模式无需席位）。
          </p>
        )
      ) : null}
      {inventory.oauth_runtime_issue ? (
        <p role='status'>{OAUTH_ISSUES[inventory.oauth_runtime_issue]}</p>
      ) : null}
      {payloadIssue || inventory.oauth_runtime_issue ? (
        <GeminiMaintenanceLink />
      ) : null}
    </div>
  )
}

const ACCOUNT_LABELS = {
  ok: '已读取',
  partial: '部分数据未返回',
  error: '读取失败，可能显示上次成功的数据',
  reauth_required: '凭据已失效，可能显示上次成功的数据',
}

function localTime(value?: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString()
}

const percent = new Intl.NumberFormat(undefined, {
  style: 'percent',
  maximumFractionDigits: 2,
})

function QuotaRow({
  label,
  reading,
}: {
  label: string
  reading: QuotaReading
}) {
  const remaining = reading.remaining_fraction
  return (
    <li className='grid gap-x-4 gap-y-1 py-2.5 text-sm sm:grid-cols-[minmax(0,1fr)_auto]'>
      <span className='break-all'>{label}</span>
      <span className='tabular-nums'>
        {remaining === null
          ? '未提供比例'
          : `已用 ${percent.format(1 - remaining)} · 剩余 ${percent.format(remaining)}`}
      </span>
      <span className='text-xs text-muted-foreground'>
        重置 {localTime(reading.reset_at)}
      </span>
      {remaining === null ? null : (
        <Progress
          aria-hidden='true'
          className='my-auto h-1.5'
          value={(1 - remaining) * 100}
        />
      )}
    </li>
  )
}

function AntigravityUsage({ environment }: { environment: GeminiEnvironment }) {
  const account = environment.account
  const isOAuth = environment.auth_method === 'oauth'
  const isStale =
    account?.state === 'error' || account?.state === 'reauth_required'
  const groups = isOAuth ? (account?.quota_groups ?? []) : []
  const quotas = isOAuth ? (account?.quotas ?? []) : []
  return (
    <section className='space-y-3 border-b pb-4' aria-label='额度与使用分析'>
      <h3 className='text-base font-semibold'>
        {isOAuth ? 'Antigravity 额度与使用分析' : 'Gemini 使用分析'}
      </h3>
      {isOAuth ? (
        <>
          {isStale ? (
            <p role='status' className='text-sm text-muted-foreground'>
              {ACCOUNT_LABELS[account.state]} · 数据时间{' '}
              {localTime(account.data_at)}
            </p>
          ) : null}
          {groups.length ? (
            <div className='space-y-3'>
              <p className='text-sm text-muted-foreground'>
                上游共享额度，同组模型不重复合计。
              </p>
              {groups.map((group) => (
                <div key={group.windows[0].id} className='space-y-1'>
                  <h4 className='text-sm font-medium break-words'>
                    {group.name}
                  </h4>
                  <ul className='divide-y border-y'>
                    {group.windows.map((window) => (
                      <QuotaRow
                        key={window.id}
                        label={window.period === '5h' ? '5 小时' : '每周'}
                        reading={window}
                      />
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          ) : (
            <p className='text-sm text-muted-foreground'>
              共享额度窗口未提供。
            </p>
          )}
          {quotas.length ? (
            <details open={!groups.length}>
              <summary className='cursor-pointer text-sm font-medium'>
                按模型查看（{quotas.length}）
              </summary>
              <p className='mt-1 text-xs text-muted-foreground'>
                模型读数不与共享窗口叠加。
              </p>
              <ul className='mt-1 divide-y border-y'>
                {quotas.map((quota) => (
                  <QuotaRow
                    key={quota.model}
                    label={quota.model}
                    reading={quota}
                  />
                ))}
              </ul>
            </details>
          ) : null}
          <p className='text-sm break-words'>
            <span className='text-muted-foreground'>
              AI Credits 余额（不等同于费用）：
            </span>
            {account?.credits
              .map((credit) => `${credit.type}: ${credit.amount}`)
              .join('、') || '未提供'}
          </p>
        </>
      ) : (
        <p className='text-sm text-muted-foreground'>
          Gemini API Key 不提供 Antigravity 订阅额度。
        </p>
      )}
      <p className='text-xs text-muted-foreground'>
        {environment.billing_ready
          ? '本地逐回合用量已接入请求日志与计费统计；上方额度窗口仅反映上游订阅余量。'
          : '本地逐回合用量尚不可用；请求数、Token 和费用不从额度变化推算。'}
      </p>
    </section>
  )
}

function GeminiBasicPrefs({
  environment,
  busy,
}: {
  environment: GeminiEnvironment
  busy: boolean
}) {
  const client = useQueryClient()
  const users = useQuery(usersQueryOptions())
  const poolsQ = useQuery({
    ...schedulerPoolsQueryOptions(),
    retry: false,
  })
  const belongingPools = buildNodePoolsIndex(poolsQ.data).get(environment.id)
  const [name, setName] = useState(environment.name || '')
  const [concurrency, setConcurrency] = useState(
    environment.max_concurrency != null
      ? String(environment.max_concurrency)
      : ''
  )
  const [levelMode, setLevelMode] = useState<'auto' | 'manual'>(
    environment.schedule_level_mode === 'manual' ? 'manual' : 'auto'
  )
  const [level, setLevel] = useState<number>(
    typeof environment.schedule_level === 'number' &&
      environment.schedule_level >= 1 &&
      environment.schedule_level <= 10
      ? environment.schedule_level
      : 5
  )

  useEffect(() => {
    setName(environment.name || '')
    setConcurrency(
      environment.max_concurrency != null
        ? String(environment.max_concurrency)
        : ''
    )
    setLevelMode(
      environment.schedule_level_mode === 'manual' ? 'manual' : 'auto'
    )
    setLevel(
      typeof environment.schedule_level === 'number' &&
        environment.schedule_level >= 1 &&
        environment.schedule_level <= 10
        ? environment.schedule_level
        : 5
    )
  }, [
    environment.id,
    environment.name,
    environment.max_concurrency,
    environment.schedule_level,
    environment.schedule_level_mode,
  ])

  const save = useGeminiMutation({
    mutationFn: async () => {
      const payload: Record<string, unknown> = {
        name: name.trim(),
        schedule_level: levelMode === 'manual' ? level : null,
      }
      if (concurrency.trim() !== '') {
        const parsed = Number(concurrency.trim())
        if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 64) {
          throw new Error('并发上限必须为 1 到 64 的整数')
        }
        if (parsed !== environment.max_concurrency) {
          payload.max_concurrency = parsed
        }
      }
      const updated = await api<GeminiEnvironment>(
        `${ROOT}/environments/${encodeURIComponent(environment.id)}/prefs`,
        {
          method: 'PATCH',
          body: JSON.stringify(payload),
        }
      )
      await syncGeminiEnvironment(client, updated)
    },
    onSuccess: () => toast.success('已保存基础与调度配置'),
    onError: (err: Error) => toast.error(err.message),
  })

  const ownerLabel = resolveOwnerUsername(
    environment.owner_user_id,
    users.data?.items
  )

  return (
    <section className='space-y-3 border-b pb-4' aria-label='基础与调度配置'>
      <div className='flex flex-wrap items-baseline justify-between gap-2'>
        <h3 className='text-base font-semibold'>基础与调度配置</h3>
        <span className='text-xs text-muted-foreground'>
          属主：{ownerLabel}
        </span>
      </div>
      <div className='grid gap-3 sm:grid-cols-2'>
        <div className='space-y-1.5'>
          <Label htmlFor={`gemini-pref-name-${environment.id}`}>显示名称</Label>
          <Input
            id={`gemini-pref-name-${environment.id}`}
            maxLength={80}
            value={name}
            disabled={busy || save.isPending}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className='space-y-1.5'>
          <Label htmlFor={`gemini-pref-conc-${environment.id}`}>
            并发上限（1–64）
          </Label>
          <Input
            id={`gemini-pref-conc-${environment.id}`}
            type='number'
            min={1}
            max={64}
            step={1}
            placeholder='默认（宿主配置）'
            value={concurrency}
            disabled={busy || save.isPending}
            onChange={(e) => setConcurrency(e.target.value)}
          />
        </div>
      </div>
      <div className='space-y-1.5'>
        <div className='flex flex-wrap items-center justify-between gap-2 text-sm'>
          <span className='font-medium'>权重模式与权重等级（1–10）</span>
          <div className='flex flex-wrap items-center gap-1.5'>
            <WeightTierBadge
              tier={levelMode === 'manual' ? level : 5}
              mode={levelMode}
            />
            <span className='text-xs text-muted-foreground'>
              {levelMode === 'manual' ? `P${level} · manual` : 'P5 · auto'}
            </span>
          </div>
        </div>
        <div
          role='radiogroup'
          aria-label='Gemini 调度优先级'
          className='flex flex-wrap items-center gap-1'
        >
          <button
            type='button'
            role='radio'
            aria-checked={levelMode === 'auto'}
            disabled={busy || save.isPending}
            onClick={() => setLevelMode('auto')}
            className={cn(
              'h-7 rounded-md border px-2 text-xs font-medium transition-colors',
              levelMode === 'auto'
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border bg-background text-muted-foreground hover:bg-muted'
            )}
          >
            自动
          </button>
          {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
            <button
              key={n}
              type='button'
              role='radio'
              aria-checked={levelMode === 'manual' && level === n}
              disabled={busy || save.isPending}
              onClick={() => {
                setLevelMode('manual')
                setLevel(n)
              }}
              className={cn(
                'h-7 w-7 rounded-md border font-mono text-xs font-semibold tabular-nums transition-colors',
                levelMode === 'manual' && level === n
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-background text-muted-foreground hover:bg-muted'
              )}
            >
              {n}
            </button>
          ))}
        </div>
      </div>
      <div className='flex flex-wrap items-center justify-between gap-2 text-xs'>
        <div className='flex flex-wrap items-center gap-1.5'>
          <span className='text-muted-foreground'>所属分组池：</span>
          {belongingPools?.length ? (
            <NodePoolBadges pools={belongingPools} maxVisible={4} />
          ) : (
            <span className='text-muted-foreground'>未加入分组池</span>
          )}
        </div>
        <Link to='/pools' className='text-primary underline underline-offset-4'>
          管理分组池 →
        </Link>
      </div>
      <div className='flex items-center gap-2'>
        <Button
          type='button'
          size='sm'
          disabled={busy || save.isPending}
          onClick={() => save.mutate(undefined)}
        >
          {save.isPending ? '保存中…' : '保存配置'}
        </Button>
      </div>
    </section>
  )
}

function EnvironmentData({
  environment,
  proxy,
}: {
  environment: GeminiEnvironment
  proxy?: GeminiProxy | null
}) {
  const account = environment.account
  return (
    <dl className='grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-3'>
      <div>
        <dt className='text-muted-foreground'>凭证</dt>
        <dd>{geminiAuthorizationLabel(environment)}</dd>
      </div>
      <div>
        <dt className='text-muted-foreground'>绑定代理</dt>
        <dd>
          {proxy ? geminiProxyOptionLabel(proxy) : environment.proxy_id}
          {environment.proxy_ready === false ? ' · 不可用' : null}
        </dd>
      </div>
      <div>
        <dt className='text-muted-foreground'>模型发现</dt>
        <dd>
          {environment.models_discovered
            ? `已发现 ${environment.models.length} 个模型`
            : '尚未拉取模型'}
        </dd>
      </div>
      <div>
        <dt className='text-muted-foreground'>最近宿主推理</dt>
        <dd>{geminiInferenceLabel(environment)}</dd>
        {environment.last_inference ? (
          <dd className='text-xs [overflow-wrap:anywhere] text-muted-foreground'>
            {environment.last_inference.model} ·{' '}
            {localTime(
              environment.last_inference.finished_at ||
                environment.last_inference.started_at
            )}
            {environment.last_inference.state === 'failed'
              ? ` · ${geminiInferenceErrorLabel(environment.last_inference.error_code)}`
              : ''}
          </dd>
        ) : null}
        {environment.last_inference?.state === 'failed' &&
        geminiInferenceErrorAction(environment.last_inference.error_code) ? (
          <dd className='mt-0.5 text-xs text-muted-foreground'>
            {geminiInferenceErrorAction(environment.last_inference.error_code)}
          </dd>
        ) : null}
      </div>
      <div>
        <dt className='text-muted-foreground'>公共 API 端到端验证</dt>
        <dd>未上报；宿主推理记录不等同于公共 API 成功</dd>
      </div>
      <div>
        <dt className='text-muted-foreground'>逐回合结算数据</dt>
        <dd>
          {environment.billing_ready
            ? '已上报'
            : '未上报，不作为推理可用性结论'}
        </dd>
      </div>
      <div>
        <dt className='text-muted-foreground'>环境 ID</dt>
        <dd className='break-all'>{environment.id}</dd>
      </div>
      <div>
        <dt className='text-muted-foreground'>内核</dt>
        <dd>{environment.kernel_version || '未上报版本'}</dd>
      </div>
      {environment.auth_method === 'oauth' && environment.crag_license ? (
        <div>
          <dt className='text-muted-foreground'>CRAGGemini 席位</dt>
          <dd>
            {environment.crag_license.valid
              ? environment.crag_license.seat
                ? `已绑定席位 #${environment.crag_license.seat}`
                : '许可有效'
              : geminiInferenceErrorLabel(
                  environment.crag_license.code ?? 'license_required'
                )}
          </dd>
          {!environment.crag_license.valid &&
          geminiInferenceErrorAction(
            environment.crag_license.code ?? 'license_required'
          ) ? (
            <dd className='mt-0.5 text-xs text-muted-foreground'>
              {geminiInferenceErrorAction(
                environment.crag_license.code ?? 'license_required'
              )}
            </dd>
          ) : null}
        </div>
      ) : null}
      <div>
        <dt className='text-muted-foreground'>创建 / 更新</dt>
        <dd>
          {localTime(environment.created_at)} /{' '}
          {localTime(environment.updated_at)}
        </dd>
      </div>
      <div>
        <dt className='text-muted-foreground'>账号</dt>
        <dd className='break-all'>{account?.email || '未提供'}</dd>
      </div>
      <div>
        <dt className='text-muted-foreground'>项目 / 地区 / 订阅</dt>
        <dd>
          {account?.project_id || '—'} / {account?.region || '—'} /{' '}
          {account?.plan || '—'}
        </dd>
      </div>
      <div>
        <dt className='text-muted-foreground'>凭据有效期</dt>
        <dd>{localTime(account?.expires_at)}</dd>
      </div>
      <div className='sm:col-span-2 lg:col-span-3'>
        <dt className='text-muted-foreground'>数据状态</dt>
        <dd>
          {account
            ? `${ACCOUNT_LABELS[account.state]} · 最近检查 ${localTime(account.checked_at)}`
            : '尚未读取'}
        </dd>
        {account &&
        (account.state === 'error' ||
          account.state === 'reauth_required' ||
          account.error_message ||
          account.error_code) ? (
          <dd className='mt-1 text-xs text-destructive'>
            {geminiAccountErrorText(account)}
          </dd>
        ) : null}
      </div>
      {environment.unschedulable ? (
        <div className='space-y-1 rounded-md border border-destructive/40 bg-destructive/10 p-3 sm:col-span-2 lg:col-span-3'>
          <dt className='font-medium text-destructive'>
            不可调度 ·{' '}
            {geminiUnschedulableLabel(
              environment.unschedulable.reason,
              environment.unschedulable.detail
            )}
          </dt>
          {environment.unschedulable.detail ? (
            <dd className='text-xs text-muted-foreground'>
              {environment.unschedulable.detail}
            </dd>
          ) : null}
          <dd className='text-xs text-muted-foreground'>
            触发时间：{localTime(environment.unschedulable.at)} ·
            可在账号操作菜单点击「恢复状态」或点击「刷新」恢复调度。
          </dd>
        </div>
      ) : null}
      {(() => {
        const notice = geminiEligibilityNotice(
          account,
          environment.last_inference
        )
        if (!notice) return null
        return (
          <div
            className={
              notice.advisory
                ? 'space-y-1.5 rounded-md border border-border bg-muted/40 p-3 sm:col-span-2 lg:col-span-3'
                : 'space-y-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 sm:col-span-2 lg:col-span-3'
            }
          >
            <dt
              className={
                notice.advisory
                  ? 'font-medium text-foreground'
                  : 'font-medium text-amber-700 dark:text-amber-300'
              }
            >
              {notice.advisory
                ? notice.label
                : `上游资格状态 · ${notice.label}`}
            </dt>
            <dd className='text-xs text-muted-foreground'>{notice.action}</dd>
            {notice.validationUrl ? (
              <dd className='flex flex-wrap items-center gap-2 pt-0.5'>
                <a
                  href={notice.validationUrl}
                  target='_blank'
                  rel='noopener noreferrer'
                  className='inline-flex items-center gap-1 text-xs font-medium text-primary underline underline-offset-4'
                >
                  打开 Google 验证页
                  <ExternalLink className='size-3' />
                </a>
                <Button
                  type='button'
                  variant='outline'
                  size='sm'
                  className='h-6 px-2 text-xs'
                  onClick={async () => {
                    if (await copyText(notice.validationUrl!)) {
                      toast.success('已复制 Google 验证链接')
                    } else {
                      toast.error('复制失败，请点击链接直接打开')
                    }
                  }}
                >
                  <Copy className='mr-1 size-3' />
                  复制验证链接
                </Button>
              </dd>
            ) : null}
          </div>
        )
      })()}
      <div className='sm:col-span-2 lg:col-span-3'>
        <dt className='text-muted-foreground'>模型</dt>
        <dd className='break-words'>
          {(() => {
            const groups = groupGeminiModels(
              environment.models ?? [],
              account?.model_catalog
            )
            if (!groups.length) return '未提供'
            if (groups.length === 1 && groups[0].provider === 'google') {
              return groups[0].models.map((item) => item.publicId).join('、')
            }
            return (
              <div className='mt-1 space-y-1.5'>
                {groups.map((group) => (
                  <div key={group.provider} className='text-xs'>
                    <span className='font-medium text-muted-foreground'>
                      {group.label}（{group.models.length}）：
                    </span>
                    <span className='break-words'>
                      {group.models.map((item) => item.publicId).join('、')}
                    </span>
                  </div>
                ))}
              </div>
            )
          })()}
        </dd>
      </div>
      <div className='text-sm text-muted-foreground sm:col-span-2 lg:col-span-3'>
        <dt className='sr-only'>状态含义</dt>
        <dd>
          授权和模型发现是前置状态，不代表推理已验证。宿主记录只来自已执行回合；配置不匹配或服务重启后不再显示旧记录，当前状态需重新验证。
        </dd>
      </div>
    </dl>
  )
}

function GeminiTerminal({
  environmentId,
  busy,
}: {
  environmentId: string
  busy: boolean
}) {
  const [open, setOpen] = useState(false)
  const resource = `${ROOT}/environments/${encodeURIComponent(environmentId)}`
  const terminalId = `gemini-terminal-${environmentId}`

  return (
    <div className='min-w-0 space-y-2 border-t pt-3'>
      <div className='flex flex-wrap items-center gap-x-3 gap-y-2'>
        <Button
          type='button'
          variant='outline'
          disabled={busy && !open}
          aria-expanded={open}
          aria-controls={open ? terminalId : undefined}
          onClick={() => setOpen((current) => !current)}
        >
          {open ? '关闭 Gemini 终端' : '启动 Gemini'}
        </Button>
        <p className='text-sm text-muted-foreground'>
          通过绑定代理以 Plan 模式运行 Antigravity CLI，不启用 API 推理。
        </p>
        <GeminiMaintenanceLink />
      </div>
      {open ? (
        <div
          id={terminalId}
          role='region'
          aria-label='Gemini 终端'
          className='h-[min(420px,65dvh)]'
        >
          <WsTerminal
            ticketPath={`${resource}/terminal-ticket`}
            socketPath={`${resource}/terminal/ws`}
          />
        </div>
      ) : null}
    </div>
  )
}

export function geminiInventoryOptions() {
  return queryOptions({
    queryKey: QUERY_KEY,
    queryFn: ({ signal }) => api<GeminiInventory>(ROOT, { signal }),
    retry: false,
    refetchInterval: (query) => {
      const inventory = query.state.data
      if (!inventory?.available || query.state.status === 'error') return false
      return inventory.environments.some(
        (environment) =>
          environment.auth_state === 'authorizing' ||
          environment.last_inference?.state === 'running'
      )
        ? 1500
        : 5000
    },
  })
}

function GeminiDetails({
  environment,
  initialTab = 'account',
  children,
}: {
  environment: GeminiEnvironment
  initialTab?: 'account' | 'proxy' | 'test'
  children: React.ReactNode
}) {
  const [tab, setTab] = useState<'account' | 'proxy' | 'test'>(initialTab)
  return (
    <Tabs
      value={tab}
      onValueChange={(next) => setTab(next as 'account' | 'proxy' | 'test')}
      className='min-w-0'
    >
      <TabsList aria-label='Gemini 环境详情'>
        <TabsTrigger value='account'>账号</TabsTrigger>
        <TabsTrigger value='proxy'>代理</TabsTrigger>
        <TabsTrigger value='test'>测试</TabsTrigger>
      </TabsList>
      {/* Keep the terminal and the active test attached when inspecting another tab. */}
      <TabsContent
        forceMount
        value='account'
        className='pt-2 data-[state=inactive]:hidden'
      >
        {children}
      </TabsContent>
      <TabsContent
        forceMount
        value='proxy'
        className='pt-2 data-[state=inactive]:hidden'
      >
        <GeminiProxyPanel environment={environment} active={tab === 'proxy'} />
      </TabsContent>
      <TabsContent
        forceMount
        value='test'
        className='pt-2 data-[state=inactive]:hidden'
      >
        <GeminiTestPanel
          key={JSON.stringify([environment.id, environment.proxy_id])}
          environment={environment}
        />
      </TabsContent>
    </Tabs>
  )
}

export function GeminiAuthorizationChallenge({
  environmentId,
  url,
  code,
  busy,
  onCodeChange,
  onSubmit,
}: {
  environmentId: string
  url: string
  code: string
  busy: boolean
  onCodeChange: (value: string) => void
  onSubmit: () => void
}) {
  const [copyState, setCopyState] = useState<'copied' | 'failed' | null>(null)

  const handleCopy = async () => {
    // 纯 HTTP 面板没有 navigator.clipboard（secure-context only），
    // copyText 会回落到 execCommand；失败时给出可操作指引。
    if (await copyText(url)) {
      setCopyState('copied')
      toast.success('已复制授权链接')
    } else {
      setCopyState('failed')
      toast.error('复制失败，请选中输入框中的链接手动复制')
    }
  }

  return (
    <form
      className='space-y-2'
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <Label htmlFor={`gemini-auth-url-${environmentId}`}>
        Google 授权链接
      </Label>
      <Input
        id={`gemini-auth-url-${environmentId}`}
        readOnly
        value={url}
        className='font-mono text-xs'
        onFocus={(event) => event.currentTarget.select()}
      />
      <div className='flex flex-wrap items-center gap-2'>
        <Button type='button' size='sm' variant='outline' onClick={handleCopy}>
          {copyState === 'copied' ? (
            <Check className='size-4' aria-hidden='true' />
          ) : (
            <Copy className='size-4' aria-hidden='true' />
          )}
          {copyState === 'copied' ? '已复制链接' : '复制链接'}
        </Button>
        <Button asChild size='sm' variant='outline'>
          <a href={url} target='_blank' rel='noreferrer'>
            <ExternalLink className='size-4' aria-hidden='true' />
            打开 Google 授权页
          </a>
        </Button>
      </div>
      {copyState === 'copied' ? (
        <p role='status' className='text-xs text-muted-foreground'>
          已复制授权链接，请在使用此环境绑定代理的浏览器中打开。
        </p>
      ) : copyState === 'failed' ? (
        <p role='alert' className='text-xs text-destructive'>
          复制失败，请选中上方输入框中的链接手动复制。
        </p>
      ) : null}
      <Label htmlFor={`gemini-code-${environmentId}`}>
        浏览器显示的授权码或完整回调链接
      </Label>
      <Input
        id={`gemini-code-${environmentId}`}
        type='password'
        autoComplete='off'
        required
        maxLength={3500}
        value={code}
        onChange={(event) => onCodeChange(event.target.value)}
      />
      <Button type='submit' disabled={busy || !code.trim()}>
        提交授权码
      </Button>
    </form>
  )
}

export function GeminiEnvironments({
  environmentId,
  initialTab,
}: {
  environmentId?: string
  initialTab?: 'account' | 'proxy' | 'test'
}) {
  const isImport = !environmentId
  const client = useQueryClient()
  const inventory = useQuery(geminiInventoryOptions())
  const proxies = useQuery({
    ...geminiProxyOptions,
    enabled: inventory.data?.available === true,
  })
  const proxyPool = proxies.data?.proxies ?? []
  const exits = proxyPool.filter(isGeminiProxy)
  const busy = useGeminiBusy()
  const [name, setName] = useState('')
  const [proxyId, setProxyId] = useState('')
  const [authMethod, setAuthMethod] = useState<
    GeminiEnvironment['auth_method'] | 'oauth_file'
  >('oauth')
  const [apiKey, setApiKey] = useState('')
  const [accountFile, setAccountFile] = useState<File | null>(null)
  const [accountText, setAccountText] = useState('')
  const [accountImport, setAccountImport] =
    useState<ParsedGeminiImportResult | null>(null)
  const [accountImportIndex, setAccountImportIndex] = useState(0)
  const [accountImportError, setAccountImportError] = useState<string | null>(
    null
  )
  const [accountImportParsedAt, setAccountImportParsedAt] = useState(0)
  const [challenge, setChallenge] = useState<
    (Authorization & { id: string }) | null
  >(null)
  const [code, setCode] = useState('')
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [createdId, setCreatedId] = useState<string | null>(null)
  const nameInput = useRef<HTMLInputElement>(null)
  const nameAutoFilled = useRef(false)
  const accountParseSeq = useRef(0)

  const selectedImportAccount =
    accountImport?.accounts[accountImportIndex] ??
    accountImport?.accounts[0] ??
    null

  const resetAccountImport = () => {
    accountParseSeq.current += 1
    setAccountFile(null)
    setAccountText('')
    setAccountImport(null)
    setAccountImportIndex(0)
    setAccountImportError(null)
    setAccountImportParsedAt(0)
  }

  const applySuggestedName = (suggested?: string) => {
    if (!suggested) return
    setName((current) => {
      if (!current.trim() || nameAutoFilled.current) {
        nameAutoFilled.current = true
        return suggested
      }
      return current
    })
  }

  const handleAccountFileChange = (file: File | null) => {
    const seq = ++accountParseSeq.current
    setAccountFile(file)
    if (file) setAccountText('')
    setAccountImport(null)
    setAccountImportIndex(0)
    setAccountImportError(null)
    setAccountImportParsedAt(0)
    if (!file) return
    void readGeminiAccountImportFile(file)
      .then((parsed) => {
        if (accountParseSeq.current !== seq) return
        setAccountImport(parsed)
        setAccountImportIndex(0)
        setAccountImportParsedAt(Date.now())
        applySuggestedName(parsed.accounts[0]?.suggestedName)
      })
      .catch((error: unknown) => {
        if (accountParseSeq.current !== seq) return
        setAccountImportError(
          error instanceof Error ? error.message : '账号文件解析失败。'
        )
      })
  }

  const handleAccountTextChange = (rawText: string) => {
    accountParseSeq.current += 1
    setAccountText(rawText)
    if (rawText.trim()) setAccountFile(null)
    setAccountImport(null)
    setAccountImportIndex(0)
    setAccountImportError(null)
    setAccountImportParsedAt(0)
    if (!rawText.trim()) return
    try {
      const parsed = parseGeminiAccountImportText(rawText)
      setAccountImport(parsed)
      setAccountImportIndex(0)
      setAccountImportParsedAt(Date.now())
      applySuggestedName(parsed.accounts[0]?.suggestedName)
    } catch (error: unknown) {
      setAccountImportError(
        error instanceof Error ? error.message : '导入内容解析失败。'
      )
    }
  }

  const operation = useGeminiMutation({
    mutationFn: async (action: {
      type:
        | 'create'
        | 'authorize'
        | 'complete'
        | 'disable'
        | 'delete'
        | 'refresh'
        | 'bind_seat'
        | 'release_seat'
        | 'sync_subscription'
      id?: string
    }) => {
      const resource = `${ROOT}/environments${action.id ? `/${encodeURIComponent(action.id)}` : ''}`
      if (action.type === 'create') {
        let importedAccount = selectedImportAccount
        if (authMethod === 'oauth_file' && !importedAccount) {
          const parsed = accountFile
            ? await readGeminiAccountImportFile(accountFile)
            : accountText.trim()
              ? parseGeminiAccountImportText(accountText)
              : null
          importedAccount =
            parsed?.accounts[accountImportIndex] ?? parsed?.accounts[0] ?? null
        }
        if (authMethod === 'oauth_file' && !importedAccount) {
          throw new Error('请选择有效的账号 JSON 文件或粘贴 Refresh Token。')
        }
        const effectiveMethod =
          authMethod === 'oauth_file' && importedAccount
            ? importedAccount.kind === 'api_key'
              ? 'api_key'
              : 'oauth'
            : authMethod
        const effectiveApiKey =
          authMethod === 'oauth_file' && importedAccount?.kind === 'api_key'
            ? importedAccount.api_key
            : authMethod === 'api_key'
              ? apiKey.trim()
              : null
        const effectiveOAuthAccount =
          authMethod === 'oauth_file' && importedAccount?.kind === 'oauth'
            ? importedAccount.oauth_account
            : null
        const environment = await api<GeminiEnvironment>(resource, {
          method: 'POST',
          body: JSON.stringify({
            name,
            proxy_id: proxyId,
            auth_method: effectiveMethod,
            ...(effectiveOAuthAccount
              ? { oauth_account: effectiveOAuthAccount }
              : {}),
            ...(effectiveApiKey ? { api_key: effectiveApiKey } : {}),
          }),
        })
        client.setQueryData<GeminiInventory>(
          QUERY_KEY,
          (current) =>
            current && {
              ...current,
              payload_state: 'installed',
              environments: [...current.environments, environment],
            }
        )
        setName('')
        nameAutoFilled.current = false
        setApiKey('')
        resetAccountImport()
        setCreatedId(environment.id)
        return
      }
      if (action.type === 'authorize' && action.id) {
        const auth = await api<Authorization>(`${resource}/authorization`, {
          method: 'POST',
        })
        setChallenge({ ...auth, id: action.id })
        setCode('')
        return
      }
      if (action.type === 'complete') {
        if (!challenge || challenge.id !== action.id) {
          throw new Error('授权会话已失效，请重新发起 Google 授权。')
        }
        await api<GeminiEnvironment>(`${resource}/authorization`, {
          method: 'PUT',
          body: JSON.stringify({
            attempt_id: challenge.attempt_id,
            code: code.trim(),
          }),
        })
      }
      if (action.type === 'disable')
        await api(`${resource}/disable`, { method: 'POST' })
      if (action.type === 'refresh')
        await api(`${resource}/refresh`, { method: 'POST' })
      if (action.type === 'bind_seat')
        await api(`${resource}/crag-license/bind`, { method: 'POST' })
      if (action.type === 'release_seat')
        await api(`${resource}/crag-license/release`, { method: 'POST' })
      if (action.type === 'sync_subscription')
        await api(`${ROOT}/crag-subscription/sync`, { method: 'POST' })
      if (action.type === 'delete') await api(resource, { method: 'DELETE' })
      setChallenge(null)
      setCode('')
      setDeleteId(null)
    },
    onSettled: () => client.invalidateQueries({ queryKey: QUERY_KEY }),
  })

  if (inventory.isPending)
    return <p role='status'>正在检测 Gemini 宿主机服务…</p>
  if (inventory.isError && !inventory.data)
    return (
      <div className='space-y-2'>
        <p role='alert'>读取 Gemini 环境失败。</p>
        <GeminiMaintenanceLink />
      </div>
    )
  if (!inventory.data) return null
  if (!inventory.data.available)
    return <GeminiStartupStatus inventory={inventory.data} />
  const awaitingRedemption =
    inventory.data.payload_state === 'awaiting_redemption'
  const isCragSubscription = inventory.data.payload_mode === 'crag_subscription'
  const cragSub = inventory.data.crag_subscription
  const payloadReady =
    inventory.data.payload_state === 'installed' &&
    inventory.data.release_activated !== false
  const canInstall =
    payloadReady || inventory.data.payload_state === 'install_on_create'
  const selectedId = environmentId || createdId
  const environment = inventory.data.environments.find(
    (item) => item.id === selectedId
  )
  const terminalUnavailable = environment?.oauth_imported
    ? '已导入 OAuth 凭据，仍需完成官方 Google 授权。'
    : environment?.proxy_ready === false
      ? '绑定的 IPv4 SOCKS5 代理不可用。'
      : geminiPayloadIssue(inventory.data) ||
        (inventory.data.oauth_runtime_issue
          ? OAUTH_ISSUES[inventory.data.oauth_runtime_issue]
          : awaitingRedemption
            ? '请先兑换 CRAGGemini 内核。'
            : null)

  const account = environment ? (
    <div className='space-y-4'>
      {isImport ? <h3 className='font-medium'>{environment.name}</h3> : null}
      {!isImport ? <AntigravityUsage environment={environment} /> : null}
      {!isImport ? (
        <GeminiBasicPrefs environment={environment} busy={busy} />
      ) : null}
      <EnvironmentData
        environment={environment}
        proxy={
          proxyPool.find((item) => item.id === environment.proxy_id) ?? null
        }
      />
      <div className='flex flex-wrap gap-2'>
        {environment.auth_method !== 'api_key' ? (
          <Button
            type='button'
            variant='outline'
            disabled={
              busy ||
              !canInstall ||
              Boolean(inventory.data.oauth_runtime_issue) ||
              environment.proxy_ready === false
            }
            onClick={() =>
              operation.mutate({ type: 'authorize', id: environment.id })
            }
          >
            {environment.oauth_imported
              ? '完成官方 Google 授权'
              : environment.auth_state === 'authorized'
                ? '重新授权'
                : 'Google 授权'}
          </Button>
        ) : null}
        {environment.auth_state === 'authorized' ||
        environment.auth_state === 'reauth_required' ? (
          <Button
            type='button'
            variant='outline'
            disabled={
              busy || !payloadReady || environment.proxy_ready === false
            }
            onClick={() =>
              operation.mutate({ type: 'refresh', id: environment.id })
            }
          >
            刷新数据
          </Button>
        ) : null}
        {isCragSubscription && cragSub?.sync_pending ? (
          <Button
            type='button'
            variant='outline'
            disabled={busy}
            onClick={() => operation.mutate({ type: 'sync_subscription' })}
          >
            继续同步订阅
          </Button>
        ) : null}
        {isCragSubscription &&
        environment.auth_method === 'oauth' &&
        !environment.crag_license?.valid &&
        !CRAG_LICENSE_SANDBOX_CODES.has(
          environment.crag_license?.code ?? ''
        ) ? (
          <Button
            type='button'
            variant='outline'
            disabled={busy || !payloadReady || !cragSub?.active}
            onClick={() =>
              operation.mutate({ type: 'bind_seat', id: environment.id })
            }
          >
            {environment.crag_license?.code &&
            environment.crag_license.code !== 'license_required'
              ? '重新绑定 CRAG 席位'
              : '绑定 CRAG 席位'}
          </Button>
        ) : null}
        {isCragSubscription &&
        environment.auth_method === 'oauth' &&
        environment.crag_license?.valid &&
        environment.crag_license.scope === 'host' &&
        cragSub?.reclaim_supported ? (
          <Button
            type='button'
            variant='outline'
            disabled={busy}
            onClick={() =>
              operation.mutate({ type: 'release_seat', id: environment.id })
            }
          >
            释放 CRAG 席位
          </Button>
        ) : null}
        {!isImport && isCragSubscription && !cragSub?.sync_pending ? (
          <GeminiRedeemDialog
            mode='crag_subscription'
            triggerLabel={
              cragSub?.active ? '叠加/续费 CRAGGemini 订阅' : undefined
            }
            onRedeemed={() => {
              void client.invalidateQueries({ queryKey: QUERY_KEY })
            }}
          />
        ) : null}
        <Button
          type='button'
          variant='outline'
          disabled={busy || environment.auth_state === 'disabled'}
          onClick={() =>
            operation.mutate({ type: 'disable', id: environment.id })
          }
        >
          停用
        </Button>
        {deleteId === environment.id ? (
          <Button
            type='button'
            variant='destructive'
            disabled={busy}
            onClick={() =>
              operation.mutate({ type: 'delete', id: environment.id })
            }
          >
            确认删除
          </Button>
        ) : (
          <Button
            type='button'
            variant='outline'
            disabled={busy}
            onClick={() => setDeleteId(environment.id)}
          >
            删除
          </Button>
        )}
      </div>
      {environment.auth_method === 'oauth' &&
      environment.auth_state === 'authorized' ? (
        terminalUnavailable ? (
          <p role='status' className='text-sm text-muted-foreground'>
            暂时无法启动 Gemini：{terminalUnavailable}
          </p>
        ) : (
          <GeminiTerminal
            key={environment.id}
            environmentId={environment.id}
            busy={busy}
          />
        )
      ) : null}
      {payloadReady &&
      challenge?.id === environment.id &&
      environment.auth_state === 'authorizing' ? (
        <GeminiAuthorizationChallenge
          key={challenge.attempt_id}
          environmentId={environment.id}
          url={challenge.url}
          code={code}
          busy={busy}
          onCodeChange={setCode}
          onSubmit={() =>
            operation.mutate({ type: 'complete', id: environment.id })
          }
        />
      ) : null}
    </div>
  ) : null

  return (
    <section
      className='max-w-3xl min-w-0 space-y-4'
      aria-label='Gemini 宿主环境'
    >
      {isImport ? (
        <p className='text-sm text-muted-foreground'>
          在宿主机创建环境，不创建虚拟机。必须绑定 IPv4 SOCKS5 代理。已有账号在{' '}
          <Link to='/vm' className='text-primary underline'>
            虚拟机
          </Link>{' '}
          管理。
        </p>
      ) : null}
      <GeminiStartupStatus inventory={inventory.data} />
      {isImport && isCragSubscription && cragSub?.sync_pending ? (
        <div>
          <Button
            type='button'
            size='sm'
            variant='outline'
            disabled={busy}
            onClick={() => operation.mutate({ type: 'sync_subscription' })}
          >
            继续同步订阅
          </Button>
        </div>
      ) : null}
      {isImport ? (
        <GeminiRedeemDialog
          mode={isCragSubscription ? 'crag_subscription' : 'legacy_release'}
          triggerVisible={awaitingRedemption || isCragSubscription}
          returnFocusTo={nameInput}
          onRedeemed={() => {
            if (!isCragSubscription) {
              client.setQueryData<GeminiInventory>(
                QUERY_KEY,
                (current) =>
                  current && {
                    ...current,
                    payload_state: 'installed',
                    payload_issue: null,
                    release_activated: true,
                  }
              )
            }
            void client.invalidateQueries({ queryKey: QUERY_KEY })
          }}
        />
      ) : null}
      {isImport ? (
        <form
          className='space-y-3'
          onSubmit={(event) => {
            event.preventDefault()
            if (canInstall) operation.mutate({ type: 'create' })
          }}
        >
          <fieldset className='space-y-2'>
            <legend className='text-sm font-medium'>导入方式</legend>
            <div className='flex flex-wrap gap-4 text-sm'>
              <label className='flex items-center gap-2'>
                <input
                  type='radio'
                  name='gemini-auth-method'
                  checked={authMethod === 'oauth'}
                  onChange={() => {
                    setAuthMethod('oauth')
                    setApiKey('')
                    resetAccountImport()
                  }}
                />
                Google 授权
              </label>
              <label className='flex items-center gap-2'>
                <input
                  type='radio'
                  name='gemini-auth-method'
                  checked={authMethod === 'api_key'}
                  onChange={() => {
                    setAuthMethod('api_key')
                    resetAccountImport()
                  }}
                />
                Gemini API Key
              </label>
              <label className='flex items-center gap-2'>
                <input
                  type='radio'
                  name='gemini-auth-method'
                  checked={authMethod === 'oauth_file'}
                  onChange={() => {
                    setAuthMethod('oauth_file')
                    setApiKey('')
                  }}
                />
                导入账号 JSON / Refresh Token
              </label>
            </div>
          </fieldset>
          <div className='space-y-2'>
            <Label htmlFor='gemini-name'>环境名称</Label>
            <Input
              ref={nameInput}
              id='gemini-name'
              required
              maxLength={80}
              value={name}
              onChange={(event) => {
                nameAutoFilled.current = false
                setName(event.target.value)
              }}
            />
          </div>
          {authMethod === 'oauth_file' ? (
            <div className='space-y-2'>
              <Label htmlFor='gemini-account-file'>
                账号 JSON 文件（或 .txt）
              </Label>
              <Input
                id='gemini-account-file'
                key={`${createdId ?? ''}-${accountText.trim() ? 'pasted' : 'file'}`}
                type='file'
                accept='.json,.txt,application/json,text/plain'
                required={!accountText.trim()}
                disabled={operation.isPending}
                aria-describedby='gemini-account-file-help'
                onChange={(event) =>
                  handleAccountFileChange(event.target.files?.item(0) ?? null)
                }
              />
              <div className='space-y-1.5'>
                <Label htmlFor='gemini-account-paste'>
                  或直接粘贴账号 JSON / Refresh Token（1//...）
                </Label>
                <textarea
                  id='gemini-account-paste'
                  rows={3}
                  spellCheck={false}
                  disabled={operation.isPending}
                  placeholder='[{"email": "user@example.com", "refresh_token": "1//..."}] 或直接粘贴 1//...'
                  className='block w-full rounded-md border bg-background px-3 py-2 font-mono text-xs'
                  value={accountText}
                  onChange={(event) =>
                    handleAccountTextChange(event.target.value)
                  }
                />
              </div>
              <p
                id='gemini-account-file-help'
                className='text-sm text-muted-foreground'
              >
                支持 Antigravity Manager / Antigravity2API、Antigravity
                Tools、CLIProxyAPI（CPA）、sub2api 等导出的账号 JSON（含仅含
                email + refresh_token 的列表）及单独 Refresh Token（1//...）。含
                Refresh Token
                的凭据将经所选代理换取令牌并写入标准配置，支持自动续票与推理；仅含短期
                access_token 的文件过期后需重新授权。
              </p>
              {accountImportError ? (
                <p role='alert' className='text-sm text-destructive'>
                  {accountImportError}
                </p>
              ) : null}
              {accountImport && selectedImportAccount ? (
                <div className='space-y-2 rounded-md border bg-muted/30 p-3 text-sm'>
                  {accountImport.accounts.length > 1 ? (
                    <div className='space-y-1.5'>
                      <Label htmlFor='gemini-import-account'>
                        选择要导入的账号（共 {accountImport.accounts.length}{' '}
                        个）
                      </Label>
                      <select
                        id='gemini-import-account'
                        className='block w-full rounded-md border bg-background p-2 text-sm'
                        disabled={operation.isPending}
                        value={String(accountImportIndex)}
                        onChange={(event) => {
                          const nextIndex = Number(event.target.value)
                          if (
                            Number.isInteger(nextIndex) &&
                            nextIndex >= 0 &&
                            nextIndex < accountImport.accounts.length
                          ) {
                            setAccountImportIndex(nextIndex)
                            applySuggestedName(
                              accountImport.accounts[nextIndex]?.suggestedName
                            )
                          }
                        }}
                      >
                        {accountImport.accounts.map((item, idx) => (
                          <option key={`${item.label}-${idx}`} value={idx}>
                            {item.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : null}
                  <p role='status' className='text-xs text-muted-foreground'>
                    已识别：{GEMINI_IMPORT_FORMAT_LABELS[accountImport.format]}{' '}
                    ·{' '}
                    {selectedImportAccount.kind === 'api_key'
                      ? 'Gemini API Key'
                      : selectedImportAccount.hasRefreshToken
                        ? 'OAuth Refresh Token（自动换票）'
                        : 'OAuth 短期访问令牌'}
                    {selectedImportAccount.email
                      ? ` · ${selectedImportAccount.email}`
                      : ''}
                    {selectedImportAccount.project_id
                      ? ` · 项目 ${selectedImportAccount.project_id}`
                      : ''}
                    {accountImport.skippedNonGemini > 0
                      ? `（已忽略 ${accountImport.skippedNonGemini} 个非 Gemini/Antigravity 账号）`
                      : ''}
                  </p>
                  {selectedImportAccount.kind === 'oauth' &&
                  !selectedImportAccount.hasRefreshToken &&
                  accountImportParsedAt > 0 &&
                  selectedImportAccount.oauth_account.expiry_timestamp !=
                    null &&
                  selectedImportAccount.oauth_account.expiry_timestamp * 1000 <=
                    accountImportParsedAt ? (
                    <p className='text-xs text-amber-700 dark:text-amber-300'>
                      提示：文件中的访问令牌可能已过期，导入验证时可能会被
                      Google 拒绝；请提供含 Refresh Token 的文件或改用 Google
                      授权。
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
          {authMethod === 'api_key' ? (
            <div className='space-y-2'>
              <Label htmlFor='gemini-api-key'>Gemini API Key</Label>
              <Input
                id='gemini-api-key'
                type='password'
                autoComplete='off'
                required
                maxLength={256}
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
              />
            </div>
          ) : authMethod === 'oauth' ? (
            <p className='text-sm text-muted-foreground'>
              创建后打开 Google 授权页，再粘贴授权码或回调链接。
            </p>
          ) : null}
          <div className='space-y-2'>
            <Label htmlFor='gemini-proxy'>SOCKS5 代理</Label>
            <select
              id='gemini-proxy'
              className='block w-full rounded-md border bg-background p-2 text-sm'
              required
              value={proxyId}
              onChange={(event) => setProxyId(event.target.value)}
            >
              <option value=''>选择代理</option>
              {exits.map((proxy) => (
                <option key={proxy.id} value={proxy.id}>
                  {geminiProxyOptionLabel(proxy)}
                </option>
              ))}
            </select>
          </div>
          {proxies.isError ? <p role='alert'>读取 SOCKS5 代理失败。</p> : null}
          <Button
            type='submit'
            disabled={
              busy ||
              !canInstall ||
              !name.trim() ||
              (authMethod === 'api_key' && !apiKey.trim()) ||
              (authMethod === 'oauth_file' &&
                ((!accountFile && !accountText.trim()) ||
                  Boolean(accountImportError) ||
                  !selectedImportAccount)) ||
              !exits.some((proxy) => proxy.id === proxyId)
            }
          >
            {authMethod === 'oauth_file'
              ? '验证并导入账号'
              : '创建 Gemini 环境'}
          </Button>
        </form>
      ) : !environment ? (
        <p role='status' className='text-sm text-muted-foreground'>
          Gemini 环境已删除或不可用。
        </p>
      ) : null}
      {operation.isError ? (
        <GeminiOperationError error={operation.error} />
      ) : null}
      {environment && !isImport ? (
        <GeminiDetails environment={environment} initialTab={initialTab}>
          {account}
        </GeminiDetails>
      ) : (
        account
      )}
    </section>
  )
}

export function GeminiOperationError({ error }: { error: Error }) {
  const parsed = geminiError(error, '')
  const action = geminiInferenceErrorAction(parsed.code)
  return (
    <div className='space-y-1'>
      <p role='alert' className='text-sm text-destructive'>
        {error.message}
      </p>
      {action ? (
        <p className='text-xs text-muted-foreground'>{action}</p>
      ) : null}
      {isGeminiHostIssue(parsed.code) ? <GeminiMaintenanceLink /> : null}
    </div>
  )
}
