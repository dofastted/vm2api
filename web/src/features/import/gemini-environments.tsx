import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
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
}

type Inventory = { available: boolean; environments: Environment[] }
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

export function GeminiEnvironments() {
  const client = useQueryClient()
  const inventory = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => api<Inventory>(ROOT),
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
    enabled: inventory.data?.available === true,
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
  const [challenge, setChallenge] = useState<
    (Authorization & { id: string }) | null
  >(null)
  const [code, setCode] = useState('')
  const [deleteId, setDeleteId] = useState<string | null>(null)

  const operation = useMutation({
    mutationFn: async (action: {
      type: 'create' | 'authorize' | 'complete' | 'disable' | 'delete'
      id?: string
    }) => {
      const resource = `${ROOT}/environments${action.id ? `/${encodeURIComponent(action.id)}` : ''}`
      if (action.type === 'create') {
        await api<Environment>(resource, {
          method: 'POST',
          body: JSON.stringify({ name, proxy_id: proxyId }),
        })
        setName('')
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
  if (!inventory.data.available) {
    return (
      <p role='status'>
        此宿主机尚未启用 Gemini。需要先安装通过校验的反代包和官方 CLI。
      </p>
    )
  }

  return (
    <section className='max-w-2xl space-y-4'>
      <p className='text-sm text-muted-foreground'>
        在宿主机创建环境，不创建虚拟机。仅接受 Google 授权，必须绑定 IPv4 SOCKS5
        代理。
      </p>
      <form
        className='space-y-3'
        onSubmit={(event) => {
          event.preventDefault()
          operation.mutate({ type: 'create' })
        }}
      >
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
            !name.trim() ||
            !exits.some((proxy) => proxy.id === proxyId)
          }
        >
          创建 Gemini 环境
        </Button>
      </form>
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
            代理 {environment.proxy_id} · {AUTH_LABELS[environment.auth_state]}{' '}
            · {environment.runtime_ready ? '运行就绪' : '运行未就绪'} ·{' '}
            {environment.billing_ready ? '计费可用' : '官方计费未核实'}
          </p>
          <div className='flex flex-wrap gap-2'>
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
                浏览器显示的授权码
              </Label>
              <Input
                id={`gemini-code-${environment.id}`}
                type='password'
                autoComplete='off'
                required
                maxLength={2048}
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
