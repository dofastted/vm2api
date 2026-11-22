import { useRef, useState } from 'react'
import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { api } from '@/lib/api'
import {
  geminiAuthorizationLabel,
  geminiInferenceLabel,
  geminiInferenceErrorLabel,
} from '@/lib/gemini-account-status'
import { isGeminiHostIssue } from '@/lib/gemini-recovery'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { WsTerminal } from '@/components/ws-terminal-lazy'
import { GeminiRedeemDialog } from '@/features/billing/gemini-redeem-dialog'
import { GeminiMaintenanceLink } from '@/features/settings/gemini-maintenance-link'
import {
  GEMINI_INVENTORY_KEY as QUERY_KEY,
  GEMINI_ROOT as ROOT,
  geminiProxyOptions,
  geminiError,
  isGeminiProxy,
  useGeminiBusy,
  useGeminiMutation,
} from './gemini-operations'
import { GeminiProxyPanel } from './gemini-proxy-panel'
import { GeminiTestPanel } from './gemini-test-panel'

const ACCOUNT_FILE_LIMIT = 128 * 1024

async function readOAuthAccount(file: File | null) {
  if (!file || file.size > ACCOUNT_FILE_LIMIT) {
    throw new Error('请选择不超过 128 KiB 的单个账号 JSON 文件。')
  }
  try {
    const data: unknown = JSON.parse(await file.text())
    if (!data || typeof data !== 'object' || !('token' in data))
      throw new Error()
    const token = data.token
    if (
      !token ||
      typeof token !== 'object' ||
      !('access_token' in token) ||
      !('expiry_timestamp' in token)
    ) {
      throw new Error()
    }
    if (
      typeof token.access_token !== 'string' ||
      !token.access_token ||
      typeof token.expiry_timestamp !== 'number' ||
      !Number.isSafeInteger(token.expiry_timestamp)
    ) {
      throw new Error()
    }
    return {
      access_token: token.access_token,
      expiry_timestamp: token.expiry_timestamp,
    }
  } catch {
    throw new Error(
      '文件格式无效，请选择 Antigravity Tools 导出的单个账号 JSON。'
    )
  }
}

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

export type GeminiEnvironment = {
  id: string
  name: string
  proxy_id: string
  auth_state:
    'unverified' | 'authorizing' | 'authorized' | 'reauth_required' | 'disabled'
  runtime_ready: boolean
  billing_ready: boolean
  proxy_ready?: boolean
  auth_method: 'oauth' | 'api_key'
  oauth_imported?: boolean
  kernel_version: string | null
  created_at: string | null
  updated_at: string | null
  models: string[]
  models_discovered?: boolean
  last_inference?: GeminiInferenceStatus | null
  account: {
    state: 'ok' | 'partial' | 'error' | 'reauth_required'
    checked_at: string | null
    data_at?: string | null
    email: string | null
    project_id: string | null
    region: string | null
    plan: string | null
    expires_at: string | null
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
  payload_issue?: keyof typeof PAYLOAD_ISSUES | null
  release_activated?: boolean | null
  oauth_runtime_issue?: keyof typeof OAUTH_ISSUES | null
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

const OAUTH_ISSUES = {
  gemini_oauth_tools_missing: '宿主缺少 Google 授权所需工具。',
  gemini_egress_unavailable: '宿主缺少可用的 kin-egress。',
  gemini_ipv4_forwarding_unavailable: '宿主 IPv4 转发未就绪。',
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
        本地逐回合用量尚不可用；请求数、Token 和费用不从额度变化推算。
      </p>
    </section>
  )
}

function EnvironmentData({ environment }: { environment: GeminiEnvironment }) {
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
          {environment.proxy_id}
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
      <div>
        <dt className='text-muted-foreground'>创建 / 更新</dt>
        <dd>
          {localTime(environment.created_at)} /{' '}
          {localTime(environment.updated_at)}
        </dd>
      </div>
      <div>
        <dt className='text-muted-foreground'>账号</dt>
        <dd>{account?.email || '未提供'}</dd>
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
      </div>
      <div className='sm:col-span-2 lg:col-span-3'>
        <dt className='text-muted-foreground'>模型</dt>
        <dd className='break-words'>
          {environment.models?.join('、') || '未提供'}
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
  children,
}: {
  environment: GeminiEnvironment
  children: React.ReactNode
}) {
  const [tab, setTab] = useState('account')
  return (
    <Tabs value={tab} onValueChange={setTab} className='min-w-0'>
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

export function GeminiEnvironments({
  environmentId,
}: {
  environmentId?: string
}) {
  const isImport = !environmentId
  const client = useQueryClient()
  const inventory = useQuery(geminiInventoryOptions())
  const proxies = useQuery({
    ...geminiProxyOptions,
    enabled: isImport && inventory.data?.available === true,
  })
  const exits = (proxies.data?.proxies ?? []).filter(isGeminiProxy)
  const busy = useGeminiBusy()
  const [name, setName] = useState('')
  const [proxyId, setProxyId] = useState('')
  const [authMethod, setAuthMethod] = useState<
    GeminiEnvironment['auth_method'] | 'oauth_file'
  >('oauth')
  const [apiKey, setApiKey] = useState('')
  const [accountFile, setAccountFile] = useState<File | null>(null)
  const [challenge, setChallenge] = useState<
    (Authorization & { id: string }) | null
  >(null)
  const [code, setCode] = useState('')
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [createdId, setCreatedId] = useState<string | null>(null)
  const nameInput = useRef<HTMLInputElement>(null)

  const operation = useGeminiMutation({
    mutationFn: async (action: {
      type:
        'create' | 'authorize' | 'complete' | 'disable' | 'delete' | 'refresh'
      id?: string
    }) => {
      const resource = `${ROOT}/environments${action.id ? `/${encodeURIComponent(action.id)}` : ''}`
      if (action.type === 'create') {
        const imported =
          authMethod === 'oauth_file'
            ? await readOAuthAccount(accountFile)
            : null
        const environment = await api<GeminiEnvironment>(resource, {
          method: 'POST',
          body: JSON.stringify({
            name,
            proxy_id: proxyId,
            auth_method: imported ? 'oauth' : authMethod,
            ...(imported ? { oauth_account: imported } : {}),
            ...(authMethod === 'api_key' ? { api_key: apiKey.trim() } : {}),
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
        setApiKey('')
        setAccountFile(null)
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
      <EnvironmentData environment={environment} />
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
        <form
          className='space-y-2'
          onSubmit={(event) => {
            event.preventDefault()
            operation.mutate({ type: 'complete', id: environment.id })
          }}
        >
          <a
            className='block text-sm text-primary underline'
            href={challenge.url}
            target='_blank'
            rel='noreferrer'
          >
            打开 Google 授权页
          </a>
          <Label htmlFor={`gemini-code-${environment.id}`}>
            浏览器显示的授权码或完整回调链接
          </Label>
          <Input
            id={`gemini-code-${environment.id}`}
            type='password'
            autoComplete='off'
            required
            maxLength={3500}
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
          <Button type='submit' disabled={busy || !code.trim()}>
            提交授权码
          </Button>
        </form>
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
      {isImport ? (
        <GeminiRedeemDialog
          triggerVisible={awaitingRedemption}
          returnFocusTo={nameInput}
          onRedeemed={() => {
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
                    setAccountFile(null)
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
                    setAccountFile(null)
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
                导入 Antigravity 账号文件
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
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          {authMethod === 'oauth_file' ? (
            <div className='space-y-2'>
              <Label htmlFor='gemini-account-file'>账号 JSON 文件</Label>
              <Input
                id='gemini-account-file'
                key={createdId}
                type='file'
                accept='.json,application/json'
                required
                disabled={operation.isPending}
                aria-describedby='gemini-account-file-help'
                onChange={(event) =>
                  setAccountFile(event.target.files?.item(0) ?? null)
                }
              />
              <p
                id='gemini-account-file-help'
                className='text-sm text-muted-foreground'
              >
                一次导入一个账号。凭据通过所选代理验证，过期后请重新进行 Google
                授权。
              </p>
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
                  {proxy.label || proxy.id}
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
              (authMethod === 'oauth_file' && !accountFile) ||
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
        <div className='space-y-1'>
          <p role='alert' className='text-sm text-destructive'>
            {operation.error.message}
          </p>
          {isGeminiHostIssue(geminiError(operation.error, '').code) ? (
            <GeminiMaintenanceLink />
          ) : null}
        </div>
      ) : null}
      {environment && !isImport ? (
        <GeminiDetails environment={environment}>{account}</GeminiDetails>
      ) : (
        account
      )}
    </section>
  )
}
