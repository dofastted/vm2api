import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { VIEW_TITLES } from '@/config/nav'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { randomUUID } from '@/lib/random-uuid'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { PageHeader } from '@/components/page-header'
import { apiEndpointsQueryOptions } from '@/features/api-endpoints/queries'
import { proxyLabel } from '@/features/proxies/proxy-sort'
import { proxiesQueryOptions } from '@/features/proxies/queries'
import {
  applyConsoleResults,
  type ConsoleResult,
  type KeyResult,
  endpointHasTestableKey,
} from './console-results'
import {
  type AuthScheme,
  API_DEFAULTS,
  type ApiProtocol,
  DIRECT,
  type EndpointDraft,
  draftFromStored,
  endpointSaveRequest,
} from './endpoint-save'

type ModelList = {
  models?: { id?: string; name?: string; alias?: string }[]
}

function freshEndpoint(protocol: ApiProtocol = 'anthropic'): EndpointDraft {
  return {
    id: randomUUID(),
    protocol,
    riskReviewEnabled: false,
    ...API_DEFAULTS[protocol],
    apiKey: '',
    proxyId: DIRECT,
  }
}

export function AnthropicConsolePage() {
  const qc = useQueryClient()
  const proxies = useQuery(proxiesQueryOptions())
  const stored = useQuery(apiEndpointsQueryOptions())
  const options = (proxies.data?.proxies || []).filter((item) => item.id)
  const [loaded, setLoaded] = useState(false)
  const [protocol, setProtocol] = useState<ApiProtocol>('anthropic')
  const [allEndpoints, setEndpoints] = useState<EndpointDraft[]>([
    freshEndpoint('anthropic'),
    freshEndpoint('openai'),
  ])
  const endpoints = allEndpoints.filter((item) => item.protocol === protocol)
  const defaultUrl = API_DEFAULTS[protocol].baseUrl
  const [openProxy, setOpenProxy] = useState<string | null>(null)
  const [models, setModels] = useState<string[]>([])
  const [model, setModel] = useState('')
  const [maxTokens, setMaxTokens] = useState('256')
  const [message, setMessage] = useState('Hi')
  const [testing, setTesting] = useState<number | 'all' | null>(null)
  const [results, setResults] = useState<Record<string, KeyResult>>({})
  useEffect(() => {
    if (loaded || !stored.data) return
    const rows = (stored.data.items || []).map(draftFromStored)
    for (const kind of ['anthropic', 'openai'] as const) {
      if (!rows.some((item) => item.protocol === kind))
        rows.push(freshEndpoint(kind))
    }
    setEndpoints(rows)
    setLoaded(true)
  }, [loaded, stored.data])

  useEffect(() => {
    const activeModels = endpoints
      .filter((e) => (e.protocol || 'anthropic') === protocol)
      .flatMap((e) => e.fetchedModels || [])
      .map((s) => s.trim())
      .filter(Boolean)
    const unique = [...new Set(activeModels)]
    setModels(unique)
    if (unique.length && (!model || !unique.includes(model))) {
      setModel(unique[0])
    }
  }, [endpoints, protocol])
  function patchEndpoint(id: string, patch: Partial<EndpointDraft>) {
    setEndpoints((current) =>
      current.map((item) => (item.id === id ? { ...item, ...patch } : item))
    )
  }

  function proxyName(id: string) {
    if (id === DIRECT) return '直连'
    const found = options.find((item) => item.id === id)
    return found ? proxyLabel(found) : '代理不可用'
  }

  function storeResults(data: ConsoleResult, index: number | null) {
    setResults((current) =>
      applyConsoleResults(
        endpoints,
        (row) => endpointHasTestableKey(endpoints[row]),
        current,
        data,
        index
      )
    )
  }

  const send = useMutation({
    mutationFn: (index: number | null) =>
      api<ConsoleResult>('/api/panel/api/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: model.trim(),
          max_tokens: Number(maxTokens),
          message,
          keys: endpoints.map((item) => ({
            protocol,
            base_url: item.baseUrl.trim() || defaultUrl,
            auth_scheme: item.authScheme,
            api_key: item.apiKey.trim(),
            key_id: item.apiKey.trim() ? '' : item.keyId || '',
            proxy_id: item.proxyId === DIRECT ? '' : item.proxyId,
          })),
          ...(index == null ? {} : { key_index: index }),
        }),
      }),
    onMutate: (index) => setTesting(index == null ? 'all' : index),
    onSettled: () => setTesting(null),
    onSuccess: (data, index) => {
      storeResults(data, index)
      if (data.ok === false)
        toast.error(data.error || `上游返回 ${data.status || ''}`)
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const fetchModels = useMutation({
    mutationFn: (endpointId?: string) => {
      const endpoint = endpoints.find(
        (item) =>
          (!endpointId || item.id === endpointId) &&
          (item.apiKey.trim() || item.keyId)
      )
      if (!endpoint) throw new Error('先保存或填写一把密钥')
      const targetProtocol = endpoint.protocol || protocol
      const targetUrl =
        endpoint.baseUrl.trim() || API_DEFAULTS[targetProtocol].baseUrl
      const path = endpoint.storedId
        ? `/api/panel/api-endpoints/${encodeURIComponent(endpoint.storedId)}/fetch-models`
        : '/api/panel/api-endpoints/fetch-models'
      return api<ModelList>(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          apply: true,
          kind: 'custom',
          protocol: targetProtocol,
          base_url: targetUrl,
          api_key: endpoint.apiKey.trim(),
          key_id: endpoint.apiKey.trim() ? '' : endpoint.keyId || '',
          auth_scheme: endpoint.authScheme,
          proxy_id: endpoint.proxyId === DIRECT ? '' : endpoint.proxyId,
        }),
      }).then((data) => ({ data, endpointId: endpoint.id }))
    },
    onSuccess: ({ data, endpointId }) => {
      const seen: Record<string, true> = {}
      const ids: string[] = []
      for (const item of data.models || []) {
        const id = (item.alias || item.name || item.id || '').trim()
        if (!id || seen[id]) continue
        seen[id] = true
        ids.push(id)
      }
      setModels(ids)
      if (ids.length) patchEndpoint(endpointId, { fetchedModels: ids })
      if (!ids.includes(model) && ids[0]) setModel(ids[0])
      if (!ids.length) toast.error('上游没有返回模型')
      else toast.success(`获取到 ${ids.length} 个模型`)
      qc.invalidateQueries({
        queryKey: apiEndpointsQueryOptions().queryKey,
      })
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const save = useMutation({
    mutationFn: async (item: EndpointDraft) => {
      const request = endpointSaveRequest(item, model)
      return api<{
        item?: {
          id?: string
          api_key_entries?: { id?: string }[]
          models?: { name: string; alias: string }[]
        }
      }>(request.path, {
        method: request.method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request.body),
      })
    },
    onSuccess: async (data, item) => {
      const saved = data.item
      if (saved?.id) {
        setEndpoints((current) =>
          current.map((row) =>
            row.id === item.id
              ? {
                  ...row,
                  storedId: saved.id,
                  keyId: saved.api_key_entries?.[0]?.id || row.keyId,
                  apiKey: '',
                  fetchedModels: (saved.models || [])
                    .map((m) => m.alias || m.name)
                    .filter(Boolean).length
                    ? (saved.models || [])
                        .map((m) => String(m.alias || m.name).trim())
                        .filter(Boolean)
                    : item.fetchedModels,
                  stored: {
                    protocol: item.protocol,
                    riskReviewEnabled: item.riskReviewEnabled === true,
                    baseUrl: item.baseUrl.trim() || defaultUrl,
                    authScheme: item.authScheme,
                    proxyId: item.proxyId,
                  },
                }
              : row
          )
        )
      }
      toast.success('已接入 API 密钥路径')
      await qc.invalidateQueries({
        queryKey: apiEndpointsQueryOptions().queryKey,
      })
    },
    onError: (error: Error) => toast.error(error.message),
  })

  return (
    <PageHeader title={VIEW_TITLES.api}>
      <div className='mx-auto grid max-w-5xl gap-6'>
        <div
          className='flex flex-wrap gap-2'
          role='group'
          aria-label='API 协议'
        >
          {(['anthropic', 'openai'] as const).map((kind) => (
            <Button
              key={kind}
              variant={protocol === kind ? 'secondary' : 'outline'}
              disabled={
                testing !== null || fetchModels.isPending || save.isPending
              }
              aria-pressed={protocol === kind}
              onClick={() => {
                setProtocol(kind)
                setModel('')
                setModels([])
              }}
            >
              {kind}
            </Button>
          ))}
        </div>
        <p className='text-sm text-muted-foreground'>
          保存地址、密钥及模型后，渠道选择 API 的密钥会从这里调用，不使用 OAuth
          虚拟机。
        </p>
        <div>
          <div className='mb-2 hidden grid-cols-[minmax(10rem,1.1fr)_8rem_minmax(0,1.4fr)_8rem_auto] gap-2 px-1 text-xs text-muted-foreground @2xl/content:grid'>
            <span>地址</span>
            <span>认证</span>
            <span>密钥</span>
            <span>代理</span>
            <span />
          </div>
          <div className='divide-y rounded-md border'>
            {endpoints.map((item, index) => {
              const result = results[item.id]
              const custom = item.baseUrl.trim() !== defaultUrl
              return (
                <div key={item.id} className='px-2 py-2'>
                  <div className='grid items-center gap-2 @2xl/content:grid-cols-[minmax(10rem,1.1fr)_8rem_minmax(0,1.4fr)_8rem_auto]'>
                    <Input
                      value={item.baseUrl}
                      onChange={(event) =>
                        patchEndpoint(item.id, { baseUrl: event.target.value })
                      }
                      aria-label={`地址 ${index + 1}`}
                      spellCheck={false}
                      className={cn(
                        custom ? 'text-foreground' : 'text-muted-foreground'
                      )}
                    />
                    <Select
                      value={item.authScheme}
                      disabled={protocol === 'openai'}
                      onValueChange={(value) =>
                        patchEndpoint(item.id, {
                          authScheme: value as AuthScheme,
                        })
                      }
                    >
                      <SelectTrigger
                        className='w-full'
                        aria-label={`认证 ${index + 1}`}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value='x_api_key'>x-api-key</SelectItem>
                        <SelectItem value='authorization_bearer'>
                          Bearer
                        </SelectItem>
                      </SelectContent>
                    </Select>
                    <Input
                      type='password'
                      autoComplete='off'
                      value={item.apiKey}
                      onChange={(event) =>
                        patchEndpoint(item.id, { apiKey: event.target.value })
                      }
                      placeholder={protocol === 'openai' ? 'sk-…' : 'sk-ant-…'}
                      aria-label={`密钥 ${index + 1}`}
                    />
                    <Popover
                      open={openProxy === item.id}
                      onOpenChange={(open) =>
                        setOpenProxy(open ? item.id : null)
                      }
                    >
                      <PopoverTrigger asChild>
                        <Button
                          type='button'
                          variant='outline'
                          className='justify-start font-normal'
                        >
                          <span className='truncate'>
                            {proxyName(item.proxyId)}
                          </span>
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent
                        align='end'
                        className='grid max-h-72 gap-1 overflow-auto p-2'
                      >
                        <Button
                          type='button'
                          variant={
                            item.proxyId === DIRECT ? 'secondary' : 'ghost'
                          }
                          className='justify-start'
                          onClick={() => {
                            patchEndpoint(item.id, { proxyId: DIRECT })
                            setOpenProxy(null)
                          }}
                        >
                          直连
                        </Button>
                        {options.map((proxy) => (
                          <Button
                            key={proxy.id}
                            type='button'
                            variant={
                              item.proxyId === proxy.id ? 'secondary' : 'ghost'
                            }
                            className='justify-start'
                            onClick={() => {
                              patchEndpoint(item.id, {
                                proxyId: proxy.id || DIRECT,
                              })
                              setOpenProxy(null)
                            }}
                          >
                            <span className='truncate'>
                              {proxyLabel(proxy)}
                            </span>
                          </Button>
                        ))}
                      </PopoverContent>
                    </Popover>
                    <div className='grid grid-cols-4 gap-1'>
                      <Button
                        type='button'
                        variant='outline'
                        disabled={fetchModels.isPending}
                        onClick={() => fetchModels.mutate(item.id)}
                      >
                        模型
                      </Button>
                      <Button
                        type='button'
                        variant='outline'
                        disabled={testing !== null}
                        onClick={() => send.mutate(index)}
                      >
                        {testing === index ? '…' : '测试'}
                      </Button>
                      <Button
                        type='button'
                        variant='outline'
                        disabled={
                          save.isPending || (!item.apiKey.trim() && !item.keyId)
                        }
                        onClick={() => save.mutate(item)}
                      >
                        保存
                      </Button>
                      <Button
                        type='button'
                        variant='ghost'
                        disabled={endpoints.length === 1}
                        onClick={() => {
                          setEndpoints((current) =>
                            current.filter(
                              (endpoint) => endpoint.id !== item.id
                            )
                          )
                          setResults((current) => {
                            const next = { ...current }
                            delete next[item.id]
                            return next
                          })
                        }}
                      >
                        删除
                      </Button>
                    </div>
                  </div>
                  {protocol === 'anthropic' ? (
                    <div className='mt-3 flex items-start gap-3 px-1 pb-1'>
                      <Switch
                        id={`risk-review-${item.id}`}
                        aria-describedby={`risk-review-help-${item.id}`}
                        checked={item.riskReviewEnabled === true}
                        disabled={save.isPending}
                        onCheckedChange={(checked) =>
                          patchEndpoint(item.id, { riskReviewEnabled: checked })
                        }
                      />
                      <div className='grid gap-1 text-sm'>
                        <label htmlFor={`risk-review-${item.id}`}>
                          风控前置审查
                        </label>
                        <p
                          id={`risk-review-help-${item.id}`}
                          className='text-xs text-muted-foreground'
                        >
                          默认关闭，修改后需保存。开启后，API Key 推理请求先按
                          <a
                            href='#/risk'
                            className='underline underline-offset-4'
                          >
                            风险审计
                          </a>
                          中启用的规则与决策模型审查，通过后再调用此端点；不影响本页连通性测试。
                        </p>
                      </div>
                    </div>
                  ) : null}
                  {result ? (
                    <p
                      className={cn(
                        'mt-2 px-1 text-sm whitespace-pre-wrap',
                        result.ok ? 'text-foreground' : 'text-destructive'
                      )}
                    >
                      {result.ok ? '可用' : '不可用'} · HTTP{' '}
                      {result.status || 0}
                      {result.proxy ? ' · 经代理' : ' · 直连'}
                      {result.error || result.text
                        ? `\n${result.error || result.text}`
                        : ''}
                    </p>
                  ) : null}
                </div>
              )
            })}
          </div>
          <Button
            type='button'
            variant='ghost'
            className='mt-1 px-2'
            onClick={() =>
              setEndpoints((current) => [...current, freshEndpoint(protocol)])
            }
          >
            添加一个地址
          </Button>
        </div>

        <div className='grid gap-3 sm:grid-cols-[minmax(0,1fr)_6rem_auto]'>
          {models.length ? (
            <Select value={model} onValueChange={setModel}>
              <SelectTrigger className='w-full' aria-label='模型'>
                <SelectValue placeholder='选择模型' />
              </SelectTrigger>
              <SelectContent>
                {models.map((id) => (
                  <SelectItem key={id} value={id}>
                    {id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Input
              value={model}
              onChange={(event) => setModel(event.target.value)}
              placeholder='模型'
              aria-label='模型'
              spellCheck={false}
            />
          )}
          <Input
            inputMode='numeric'
            value={maxTokens}
            onChange={(event) => setMaxTokens(event.target.value)}
            aria-label='max_tokens'
          />
          <Button
            type='button'
            variant='outline'
            disabled={fetchModels.isPending}
            onClick={() => fetchModels.mutate()}
          >
            {fetchModels.isPending ? '获取中' : '获取模型'}
          </Button>
        </div>
        <Textarea
          rows={3}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          aria-label='消息'
        />
        <div>
          <Button
            variant='outline'
            disabled={testing !== null}
            onClick={() => send.mutate(null)}
          >
            {testing === 'all' ? '请求中' : '全部测试'}
          </Button>
        </div>
      </div>
    </PageHeader>
  )
}
