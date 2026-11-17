import { useState } from 'react'
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'

const ROOT = '/api/panel/gemini'
const QUERY_KEY = ['panel', 'gemini-environments'] as const

type QuotaReading = {
  remaining_fraction: number | null
  reset_at: string | null
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
  kernel_version: string | null
  created_at: string | null
  updated_at: string | null
  models: string[]
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
    'installed' | 'install_on_create' | 'not_configured' | 'invalid' | 'unknown'
  payload_issue?: keyof typeof PAYLOAD_ISSUES | null
  oauth_runtime_issue?: keyof typeof OAUTH_ISSUES | null
  environments: GeminiEnvironment[]
}
type Authorization = { url: string; attempt_id: string }
type Proxy = {
  id: string
  label?: string
  enabled: boolean
  kind: string
  address_family?: number | null
  status: string
  owner_user_id?: string
  blocked_reason?: string
}

const AUTH_LABELS: Record<GeminiEnvironment['auth_state'], string> = {
  unverified: '未授权',
  authorizing: '等待 Google 授权',
  authorized: '已授权',
  reauth_required: '需要重新授权',
  disabled: '已停用',
}

const PAYLOAD_ISSUES = {
  gemini_public_key_missing: '缺少 Gemini 发行公钥。',
  gemini_payload_source_missing: '缺少 Antigravity 签名载荷安装源。',
  gemini_payload_incomplete: 'Antigravity 签名载荷不完整或不可执行。',
  gemini_payload_invalid: 'Gemini 载荷校验失败，请检查宿主服务日志。',
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
      <p role='status' className='text-sm'>
        {inventory.host_message || '未检测到可用的 Gemini 宿主服务。'}{' '}
        请在宿主检查 <code>systemctl status vm2api-gemini</code>；未安装时运行{' '}
        <code>deploy/install.sh prepare-gemini</code>。
      </p>
    )
  const payloadIssue = geminiPayloadIssue(inventory)
  return (
    <div className='space-y-1 text-sm'>
      {payloadIssue ? <p role='status'>{payloadIssue}</p> : null}
      {inventory.payload_state === 'install_on_create' ? (
        <p role='status'>首次创建时自动校验并安装 Gemini 内核和官方 CLI。</p>
      ) : null}
      {inventory.oauth_runtime_issue ? (
        <p role='status'>{OAUTH_ISSUES[inventory.oauth_runtime_issue]}</p>
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
        <dd>{AUTH_LABELS[environment.auth_state]}</dd>
      </div>
      <div>
        <dt className='text-muted-foreground'>绑定代理</dt>
        <dd>
          {environment.proxy_id}
          {environment.proxy_ready === false ? ' · 不可用' : null}
        </dd>
      </div>
      <div>
        <dt className='text-muted-foreground'>推理</dt>
        <dd>{environment.runtime_ready ? '就绪' : '当前载荷未启用推理'}</dd>
      </div>
      <div>
        <dt className='text-muted-foreground'>付费调用</dt>
        <dd>
          {environment.billing_ready ? '可用' : '关闭 · 缺少官方逐回合结算'}
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
    </dl>
  )
}

export function geminiInventoryOptions() {
  return queryOptions({
    queryKey: QUERY_KEY,
    queryFn: () => api<GeminiInventory>(ROOT),
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.environments.some(
        (environment) => environment.auth_state === 'authorizing'
      )
        ? 1500
        : false,
  })
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
    queryKey: ['panel', 'gemini-egress-options'],
    queryFn: () => api<{ proxies: Proxy[] }>('/api/panel/proxies'),
    enabled: isImport && inventory.data?.available === true,
  })
  const exits = (proxies.data?.proxies ?? []).filter(
    (proxy) =>
      proxy.enabled &&
      proxy.kind === 'socks5' &&
      proxy.address_family === 4 &&
      !proxy.owner_user_id &&
      !proxy.blocked_reason &&
      proxy.status !== 'dead' &&
      proxy.status !== 'fail'
  )
  const [name, setName] = useState('')
  const [proxyId, setProxyId] = useState('')
  const [authMethod, setAuthMethod] =
    useState<GeminiEnvironment['auth_method']>('oauth')
  const [apiKey, setApiKey] = useState('')
  const [challenge, setChallenge] = useState<
    (Authorization & { id: string }) | null
  >(null)
  const [code, setCode] = useState('')
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [createdId, setCreatedId] = useState<string | null>(null)

  const operation = useMutation({
    mutationFn: async (action: {
      type:
        'create' | 'authorize' | 'complete' | 'disable' | 'delete' | 'refresh'
      id?: string
    }) => {
      const resource = `${ROOT}/environments${action.id ? `/${encodeURIComponent(action.id)}` : ''}`
      if (action.type === 'create') {
        const environment = await api<GeminiEnvironment>(resource, {
          method: 'POST',
          body: JSON.stringify({
            name,
            proxy_id: proxyId,
            auth_method: authMethod,
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
  if (inventory.isError) return <p role='alert'>读取 Gemini 环境失败。</p>
  if (!inventory.data) return null
  if (!inventory.data.available)
    return <GeminiStartupStatus inventory={inventory.data} />
  const payloadState = inventory.data.payload_state
  const canInstall =
    payloadState === 'installed' ||
    payloadState === 'install_on_create' ||
    payloadState === 'invalid'
  const selectedId = environmentId || createdId
  const environment = inventory.data.environments.find(
    (item) => item.id === selectedId
  )

  return (
    <section className='max-w-3xl space-y-4' aria-label='Gemini 宿主环境'>
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
        <form
          className='space-y-3'
          onSubmit={(event) => {
            event.preventDefault()
            operation.mutate({ type: 'create' })
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
                  }}
                />
                Google 授权
              </label>
              <label className='flex items-center gap-2'>
                <input
                  type='radio'
                  name='gemini-auth-method'
                  checked={authMethod === 'api_key'}
                  onChange={() => setAuthMethod('api_key')}
                />
                Gemini API Key
              </label>
            </div>
          </fieldset>
          <div className='space-y-2'>
            <Label htmlFor='gemini-name'>环境名称</Label>
            <Input
              id='gemini-name'
              required
              maxLength={80}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
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
          ) : (
            <p className='text-sm text-muted-foreground'>
              创建后打开 Google 授权页，再粘贴授权码或回调链接。
            </p>
          )}
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
              operation.isPending ||
              !canInstall ||
              !name.trim() ||
              (authMethod === 'api_key' && !apiKey.trim()) ||
              !exits.some((proxy) => proxy.id === proxyId)
            }
          >
            创建 Gemini 环境
          </Button>
        </form>
      ) : !environment ? (
        <p role='status' className='text-sm text-muted-foreground'>
          Gemini 环境已删除或不可用。
        </p>
      ) : null}
      {operation.isError ? (
        <p role='alert' className='text-sm text-destructive'>
          {operation.error.message}
        </p>
      ) : null}
      {environment ? (
        <div className='space-y-4'>
          {isImport ? (
            <h3 className='font-medium'>{environment.name}</h3>
          ) : null}
          {!isImport ? <AntigravityUsage environment={environment} /> : null}
          <EnvironmentData environment={environment} />
          <div className='flex flex-wrap gap-2'>
            {environment.auth_method !== 'api_key' ? (
              <Button
                type='button'
                variant='outline'
                disabled={
                  operation.isPending ||
                  !canInstall ||
                  Boolean(inventory.data.oauth_runtime_issue) ||
                  environment.proxy_ready === false
                }
                onClick={() =>
                  operation.mutate({ type: 'authorize', id: environment.id })
                }
              >
                {environment.auth_state === 'authorized'
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
                  operation.isPending || environment.proxy_ready === false
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
              disabled={
                operation.isPending || environment.auth_state === 'disabled'
              }
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
                disabled={operation.isPending}
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
                disabled={operation.isPending}
                onClick={() => setDeleteId(environment.id)}
              >
                删除
              </Button>
            )}
          </div>
          {challenge?.id === environment.id &&
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
              <Button
                type='submit'
                disabled={operation.isPending || !code.trim()}
              >
                提交授权码
              </Button>
            </form>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
