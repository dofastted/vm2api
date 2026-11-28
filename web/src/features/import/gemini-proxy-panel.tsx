import { useId, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Field } from '@/features/vm/detail-section-primitives'
import type { GeminiEnvironment } from './gemini-environments'
import {
  GEMINI_INVENTORY_KEY,
  geminiError,
  geminiProxyAddress,
  geminiProxyOptionLabel,
  geminiProxyOptions,
  geminiResource,
  isGeminiProxy,
  syncGeminiEnvironment,
  useGeminiBusy,
  useGeminiMutation,
} from './gemini-operations'

type Probe = { ok: boolean; latency_ms: number | null; code?: string }

export function GeminiProxyPanel({
  environment,
  active,
}: {
  environment: GeminiEnvironment
  active: boolean
}) {
  const client = useQueryClient()
  const busy = useGeminiBusy()
  const pickerId = useId()
  const [selection, setSelection] = useState('')
  const resource = geminiResource(environment.id)
  const proxies = useQuery({ ...geminiProxyOptions, enabled: active })
  const pool = proxies.data?.proxies ?? []
  const boundId = environment.proxy_id
  const envOwnerId = environment.owner_user_id ?? null
  const bound = pool.find((proxy) => proxy.id === boundId)
  const candidates = pool.filter(
    (proxy) =>
      proxy.id !== boundId && isGeminiProxy(proxy, { ownerUserId: envOwnerId })
  )
  const selected = candidates.find((proxy) => proxy.id === selection)
  const probe = useGeminiMutation({
    mutationFn: (proxyId: string) =>
      api<Probe>(`${resource}/proxy/probe`, { method: 'POST' }).then(
        (result) => ({
          ...result,
          proxyId,
        })
      ),
    onSettled: () =>
      client.invalidateQueries({ queryKey: GEMINI_INVENTORY_KEY }),
  })
  const rebind = useGeminiMutation({
    mutationFn: (proxyId: string) =>
      api<GeminiEnvironment>(`${resource}/proxy`, {
        method: 'PUT',
        body: JSON.stringify({ proxy_id: proxyId }),
      }),
    onSuccess: async (updated) => {
      // The test panel is keyed by the current binding, so no pulled model or
      // selection from the previous proxy survives the change.
      await syncGeminiEnvironment(client, updated)
      setSelection('')
    },
  })
  const lastProbe = probe.data?.proxyId === boundId ? probe.data : null
  const probeError =
    probe.isError && probe.variables === boundId
      ? geminiError(probe.error, '代理探测失败，请重试。')
      : lastProbe && !lastProbe.ok
        ? { code: lastProbe.code, message: '绑定代理未通过连通性探测。' }
        : null
  const bindError = rebind.isError
    ? geminiError(rebind.error, '更换代理失败，请重试。')
    : null

  return (
    <div className='min-w-0 space-y-3'>
      <Card>
        <CardHeader className='pb-2'>
          <CardTitle className='text-sm'>
            绑定的出口代理（SOCKS5 / HTTP）
          </CardTitle>
        </CardHeader>
        <CardContent className='space-y-3 pt-0'>
          <div className='divide-y'>
            <Field label='绑定 ID'>{boundId || '未绑定'}</Field>
            {bound?.label && bound.label !== boundId ? (
              <Field label='代理名称'>{bound.label}</Field>
            ) : null}
            {bound && geminiProxyAddress(bound) ? (
              <Field label='代理地址'>
                <span className='font-mono'>{geminiProxyAddress(bound)}</span>
              </Field>
            ) : null}
            {bound?.geo?.ip ? (
              <Field label='出口 IP'>
                <span className='font-mono'>{bound.geo.ip}</span>
                {bound.geo.country_code || bound.geo.country
                  ? ` · ${bound.geo.country_code || bound.geo.country}`
                  : null}
              </Field>
            ) : null}
            {boundId ? (
              <Field label='绑定状态'>
                {environment.proxy_ready === false ||
                (bound &&
                  !isGeminiProxy(bound, {
                    ownerUserId: envOwnerId,
                    allowFail: true,
                  }))
                  ? '不可用'
                  : environment.proxy_ready === true
                    ? '可用'
                    : '未确认'}
              </Field>
            ) : null}
          </div>
          <Button
            type='button'
            size='sm'
            variant='outline'
            loading={probe.isPending}
            disabled={busy || !boundId}
            onClick={() => probe.mutate(boundId)}
          >
            测通
          </Button>
          {probeError ? (
            <p role='alert' className='text-sm text-destructive'>
              {probeError.message}
              {probeError.code ? ` (${probeError.code})` : ''}
            </p>
          ) : lastProbe?.ok ? (
            <p role='status' className='text-sm'>
              探测通过
              {lastProbe.latency_ms != null
                ? ` · ${lastProbe.latency_ms} ms`
                : ''}
            </p>
          ) : null}
        </CardContent>
      </Card>
      <Card>
        <CardHeader className='pb-2'>
          <CardTitle className='text-sm'>更换绑定</CardTitle>
        </CardHeader>
        <CardContent className='space-y-3 pt-0'>
          <div className='space-y-1.5'>
            <Label htmlFor={pickerId}>
              {envOwnerId ? '可用代理（平台 / 租户）' : '平台代理'}
            </Label>
            <Select
              value={selected?.id ?? ''}
              onValueChange={setSelection}
              disabled={busy || !candidates.length}
            >
              <SelectTrigger id={pickerId} className='w-full'>
                <SelectValue placeholder='选择 SOCKS5 / HTTP 代理' />
              </SelectTrigger>
              <SelectContent>
                {candidates.map((proxy) => (
                  <SelectItem key={proxy.id} value={proxy.id}>
                    {geminiProxyOptionLabel(proxy)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {proxies.isError ? (
            <p role='alert' className='text-sm text-destructive'>
              读取代理列表失败。
            </p>
          ) : proxies.isPending ? (
            <p role='status' className='text-sm text-muted-foreground'>
              正在读取代理列表…
            </p>
          ) : !candidates.length ? (
            <p className='text-sm text-muted-foreground'>
              没有其他符合条件的 SOCKS5 / HTTP 代理（支持 IPv4 或域名，不支持
              IPv6 / HTTPS）。
            </p>
          ) : null}
          <Button
            type='button'
            size='sm'
            loading={rebind.isPending}
            disabled={busy || proxies.isError || !selected}
            onClick={() => {
              if (selected) {
                probe.reset()
                rebind.mutate(selected.id)
              }
            }}
          >
            更换代理
          </Button>
          {bindError ? (
            <p role='alert' className='text-sm text-destructive'>
              {bindError.message}
              {bindError.code ? ` (${bindError.code})` : ''}
            </p>
          ) : rebind.isSuccess && rebind.data.proxy_id === boundId ? (
            <p role='status' className='text-sm'>
              代理已更换。请在「测试」重新拉取模型。
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  )
}
