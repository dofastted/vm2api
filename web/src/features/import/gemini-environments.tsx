import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

const ROOT = '/api/panel/gemini'
const QUERY_KEY = ['panel', 'gemini-environments'] as const

type Environment = {
  id: string
  name: string
  proxy_id: string
  auth_state:
    'unverified' | 'authorizing' | 'authorized' | 'reauth_required' | 'disabled'
  runtime_ready: boolean
  billing_ready: boolean
  auth_method: 'oauth' | 'api_key'
  kernel_version: string | null
  created_at: string | null
  updated_at: string | null
  models: string[]
  account: {
    state: 'ok' | 'partial' | 'error' | 'reauth_required'
    checked_at: string | null
    email: string | null
    project_id: string | null
    region: string | null
    plan: string | null
    expires_at: string | null
    quotas: {
      model: string
      remaining_fraction: number
      reset_at: string | null
    }[]
    credits: { type: string; amount: string }[]
  } | null
}

type Inventory = {
  available: boolean
  payload_state?:
    'installed' | 'install_on_create' | 'not_configured' | 'invalid'
  environments: Environment[]
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

const AUTH_LABELS: Record<Environment['auth_state'], string> = {
  unverified: '未授权',
  authorizing: '等待 Google 授权',
  authorized: '已授权',
  reauth_required: '需要重新授权',
  disabled: '已停用',
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

function EnvironmentData({ environment }: { environment: Environment }) {
  const account = environment.account
  return (
    <dl className='grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-3'>
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
      <div className='sm:col-span-2 lg:col-span-3'>
        <dt className='text-muted-foreground'>模型配额（剩余 / 重置时间）</dt>
        <dd>
          {account?.quotas.length
            ? account.quotas.map((quota) => (
                <div key={quota.model}>
                  {quota.model} ·{' '}
                  {new Intl.NumberFormat(undefined, {
                    style: 'percent',
                    maximumFractionDigits: 2,
                  }).format(quota.remaining_fraction)}{' '}
                  · {localTime(quota.reset_at)}
                </div>
              ))
            : '未提供'}
        </dd>
      </div>
      <div className='sm:col-span-2 lg:col-span-3'>
        <dt className='text-muted-foreground'>
          AI Credits 余额（不等同于费用）
        </dt>
        <dd>
          {account?.credits
            .map((credit) => `${credit.type}: ${credit.amount}`)
            .join('、') || '未提供'}
        </dd>
      </div>
    </dl>
  )
}

export function GeminiEnvironments({
  view = 'import',
}: {
  view?: 'import' | 'vm'
}) {
  const client = useQueryClient()
  const inventory = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => api<Inventory>(ROOT),
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.environments.some(
        (environment) => environment.auth_state === 'authorizing'
      )
        ? 1500
        : false,
  })
  const proxies = useQuery({
    queryKey: ['panel', 'gemini-egress-options'],
    queryFn: () => api<{ proxies: Proxy[] }>('/api/panel/proxies'),
    enabled: view === 'import' && inventory.data?.available === true,
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
    useState<Environment['auth_method']>('oauth')
  const [apiKey, setApiKey] = useState('')
  const [challenge, setChallenge] = useState<
    (Authorization & { id: string }) | null
  >(null)
  const [code, setCode] = useState('')
  const [deleteId, setDeleteId] = useState<string | null>(null)

  const operation = useMutation({
    mutationFn: async (action: {
      type:
        'create' | 'authorize' | 'complete' | 'disable' | 'delete' | 'refresh'
      id?: string
    }) => {
      const resource = `${ROOT}/environments${action.id ? `/${encodeURIComponent(action.id)}` : ''}`
      if (action.type === 'create') {
        const environment = await api<Environment>(resource, {
          method: 'POST',
          body: JSON.stringify({
            name,
            proxy_id: proxyId,
            auth_method: authMethod,
            ...(authMethod === 'api_key' ? { api_key: apiKey.trim() } : {}),
          }),
        })
        client.setQueryData<Inventory>(
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
        await api<Environment>(`${resource}/authorization`, {
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

  if (inventory.isPending && view === 'import')
    return <p role='status'>正在检测 Gemini 宿主机服务…</p>
  if (inventory.isError && view === 'import')
    return <p role='alert'>读取 Gemini 环境失败。</p>
  if (!inventory.data?.available)
    return view === 'vm' ? null : (
      <p role='status'>
        此宿主机尚未启用 Gemini。请先在宿主运行{' '}
        <code>deploy/install.sh prepare-gemini</code>，再刷新面板。
      </p>
    )
  const payloadState = inventory.data.payload_state
  const canInstall = payloadState !== 'not_configured'

  return (
    <section
      className={
        view === 'vm' ? 'mt-8 space-y-4 border-t pt-5' : 'max-w-3xl space-y-4'
      }
      aria-label='Gemini 宿主环境'
    >
      {view === 'vm' ? (
        <div className='flex flex-wrap items-center justify-between gap-2'>
          <h2 className='text-lg font-semibold'>Gemini 宿主环境</h2>
          <Link
            to='/import'
            hash='gemini'
            className='text-sm text-primary underline'
          >
            导入 Gemini
          </Link>
        </div>
      ) : null}
      <p className='text-sm text-muted-foreground'>
        在宿主机创建环境，不创建虚拟机。支持 Google 授权和 Gemini API
        Key，必须绑定 IPv4 SOCKS5 代理。
      </p>
      {payloadState === 'install_on_create' ? (
        <p role='status'>首次创建时自动校验并安装 Gemini 内核和官方 CLI。</p>
      ) : null}
      {payloadState === 'not_configured' ? (
        <p role='status'>宿主服务已连接，但缺少签名载荷安装源或发行公钥。</p>
      ) : null}
      {payloadState === 'invalid' ? (
        <p role='alert'>Gemini 载荷校验失败，请检查安装源及宿主服务日志。</p>
      ) : null}
      {view === 'import' ? (
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
      ) : !inventory.data.environments.length ? (
        <p className='text-sm text-muted-foreground'>尚无 Gemini 环境。</p>
      ) : null}
      {operation.isError ? (
        <p role='alert' className='text-sm text-destructive'>
          {operation.error.message}
        </p>
      ) : null}
      {inventory.data.environments.map((environment) => (
        <article
          key={environment.id}
          className='space-y-3 rounded-md border p-4'
        >
          <h3 className='font-medium'>{environment.name}</h3>
          <p className='text-sm text-muted-foreground'>
            {environment.auth_method === 'api_key' ? 'API Key' : 'Google OAuth'}{' '}
            · 代理 {environment.proxy_id} ·{' '}
            {AUTH_LABELS[environment.auth_state]} ·{' '}
            {environment.runtime_ready ? '运行就绪' : '运行未就绪'} ·{' '}
            {environment.billing_ready ? '计费可用' : '官方计费未核实'}
          </p>
          <EnvironmentData environment={environment} />
          <div className='flex flex-wrap gap-2'>
            {environment.auth_method !== 'api_key' ? (
              <Button
                type='button'
                variant='outline'
                disabled={operation.isPending}
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
                disabled={operation.isPending}
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
        </article>
      ))}
    </section>
  )
}
