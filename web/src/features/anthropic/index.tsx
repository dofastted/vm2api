import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { VIEW_TITLES } from '@/config/nav'
import { toast } from 'sonner'
import { api } from '@/lib/api'
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
  DEFAULT_URL,
  DIRECT,
  type EndpointDraft,
  draftFromStored,
  endpointSaveRequest,
} from './endpoint-save'

type ModelList = {
  models?: { id?: string; name?: string; alias?: string }[]
}

function freshEndpoint(): EndpointDraft {
  return {
    id: crypto.randomUUID(),
    baseUrl: DEFAULT_URL,
    authScheme: 'x_api_key',
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
  const [endpoints, setEndpoints] = useState<EndpointDraft[]>([freshEndpoint()])
  const [openProxy, setOpenProxy] = useState<string | null>(null)
  const [models, setModels] = useState<string[]>([])
  const [model, setModel] = useState('')
  const [maxTokens, setMaxTokens] = useState('256')
  const [message, setMessage] = useState('Hi')
  const [testing, setTesting] = useState<number | 'all' | null>(null)
  const [results, setResults] = useState<Record<string, KeyResult>>({})
  useEffect(() => {
    if (loaded || !stored.data) return
    const rows = (stored.data.items || [])
      .filter((item) => item.protocol !== 'openai')
      .map(draftFromStored)
    if (rows.length) setEndpoints(rows)
    setLoaded(true)
  }, [loaded, stored.data])
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
      api<ConsoleResult>('/api/panel/anthropic/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: model.trim(),
          max_tokens: Number(maxTokens),
          message,
          keys: endpoints.map((item) => ({
            base_url: item.baseUrl.trim() || DEFAULT_URL,
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
    mutationFn: () => {
      const endpoint = endpoints.find(
        (item) => item.apiKey.trim() || item.keyId
      )
      if (!endpoint) throw new Error('先保存或填写一把密钥')
      return api<ModelList>('/api/panel/api-endpoints/fetch-models', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'custom',
          protocol: 'anthropic',
          base_url: endpoint.baseUrl.trim() || DEFAULT_URL,
          api_key: endpoint.apiKey.trim(),
          key_id: endpoint.apiKey.trim() ? '' : endpoint.keyId || '',
          auth_scheme: endpoint.authScheme,
          proxy_id: endpoint.proxyId === DIRECT ? '' : endpoint.proxyId,
        }),
      })
    },
    onSuccess: (data) => {
      const seen: Record<string, true> = {}
      const ids: string[] = []
      for (const item of data.models || []) {
        const id = (item.alias || item.name || item.id || '').trim()
        if (!id || seen[id]) continue
        seen[id] = true
        ids.push(id)
      }
      setModels(ids)
      if (!model && ids[0]) setModel(ids[0])
      if (!ids.length) toast.error('上游没有返回模型')
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const save = useMutation({
    mutationFn: async (item: EndpointDraft) => {
      const request = endpointSaveRequest(item, model)
      return api<{
        item?: { id?: string; api_key_entries?: { id?: string }[] }
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
                  stored: {
                    baseUrl: item.baseUrl.trim() || DEFAULT_URL,
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
    <PageHeader title={VIEW_TITLES.anthropic}>
      <div className='mx-auto grid max-w-5xl gap-6'>
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
              const custom = item.baseUrl.trim() !== DEFAULT_URL
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
                      placeholder='sk-ant-…'
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
                    <div className='grid grid-cols-3 gap-1'>
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
              setEndpoints((current) => [...current, freshEndpoint()])
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
