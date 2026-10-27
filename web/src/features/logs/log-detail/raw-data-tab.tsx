import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { RequestLogItem } from '@/types/panel-logs'
import { Check, Copy } from 'lucide-react'
import { maskPresentedKey } from '@/lib/log-mute'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { requestLogQueryOptions } from '../queries'

type Section = {
  id: string
  label: string
  value: unknown
  note?: string
}

function pretty(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/** Empty objects count as absent: debug records store `{}` for unset header maps. */
function present(value: unknown): boolean {
  if (value == null || value === '') return false
  if (typeof value === 'object' && Object.keys(value as object).length === 0)
    return false
  return true
}

/**
 * 原始数据各块，顺序即请求的实际流向：入站 → 出站 → 返回客户端。
 * 后端写入时已脱敏（Authorization / Cookie / 凭证形态字符串）。
 */
function sections(item: RequestLogItem): Section[] {
  const res = item.response ?? null
  const all: Section[] = [
    { id: 'inbound_body', label: '入站请求体', value: item.inbound_body },
    { id: 'headers', label: '入站请求头', value: item.headers },
    { id: 'outbound_body', label: '出站请求体', value: item.outbound_body },
    {
      id: 'outbound_headers',
      label:
        item.outbound_headers_source === 'cli_final'
          ? '最终出站请求头'
          : '出站请求头',
      value:
        item.outbound_headers_source === 'unavailable'
          ? '未获取到最终出站请求头（运行中的 CLI 尚不支持回传，或请求尚未发送）。'
          : item.outbound_headers,
      note:
        item.outbound_headers_source === 'cli_final'
          ? 'CLI 完成请求头组装及 CCH 密封后、调用 fetch 前采集；凭证已脱敏。'
          : item.outbound_headers_source == null &&
              present(item.outbound_headers)
            ? '历史记录未标注采集位置，不能确认是最终出站值。'
            : undefined,
    },
    {
      id: 'worker_envelope_headers',
      label: '槽位入站请求头（中间值）',
      value: item.worker_envelope_headers,
    },
    {
      id: 'response_body',
      label: '响应体',
      value: res?.body,
      note: res
        ? `${res.bytes.toLocaleString()} 字节${res.truncated ? ' · 已截断' : ''}`
        : undefined,
    },
    { id: 'response_headers', label: '响应头', value: res?.headers },
    { id: 'hop_meta', label: '链路元数据', value: item.hop_meta },
    {
      id: 'cache_continuity',
      label: '缓存连续性',
      value: item.cache_continuity,
    },
    { id: 'cache_prefix', label: '缓存前缀', value: item.cache_prefix },
    { id: 'classifier', label: '分类器', value: item.classifier },
  ]
  return all.filter((s) => present(s.value))
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      type='button'
      variant='ghost'
      size='sm'
      className='h-7 gap-1 px-2 text-xs'
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
    >
      {copied ? <Check className='h-3 w-3' /> : <Copy className='h-3 w-3' />}
      {copied ? '已复制' : '复制'}
    </Button>
  )
}

/**
 * 「原始数据」页签：debug 采样记录（`/api/panel/request-logs/:id`）。
 * 只有 debug 模式落库的请求才有头/体；普通请求给出开启方式。
 */
export function RawDataTab({
  requestId,
  logMode,
}: {
  requestId: string | null
  logMode: 'normal' | 'debug' | null
}) {
  const detail = useQuery(requestLogQueryOptions(requestId ?? '', !!requestId))
  const item = detail.data?.item as RequestLogItem | undefined
  const list = item ? sections(item) : []
  const [active, setActive] = useState<string | null>(null)

  if (!requestId) {
    return (
      <p className='text-sm text-muted-foreground'>该请求没有 Request ID。</p>
    )
  }
  if (detail.isLoading) {
    return <p className='text-sm text-muted-foreground'>加载原始数据…</p>
  }
  if (!list.length) {
    return (
      <div className='space-y-2 rounded-lg border border-dashed p-6 text-sm text-muted-foreground'>
        <p>
          {logMode === 'debug'
            ? '这条 debug 记录没有可展示的原始数据（可能已过 debug 保留期）。'
            : '该请求未开启 debug 采样，没有保存原始请求体与响应体。'}
        </p>
        <p className='text-xs'>
          在「设置 → 日志」把模式切到
          Debug，之后的请求会保存入站/出站请求体和返回给客户端的响应。 请求时带{' '}
          <code>x-kin-debug: 1</code>{' '}
          只保存入站请求体与响应，出站请求体（含网关改写）不保存。
        </p>
      </div>
    )
  }

  const current = list.find((s) => s.id === active) ?? list[0]
  const text = pretty(current.value)
  return (
    <div className='space-y-3'>
      <div className='flex flex-wrap items-center gap-2 text-xs'>
        {item?.upstream_status != null && item.upstream_status !== '' ? (
          <Badge variant='outline' className='font-mono'>
            上游 {String(item.upstream_status)}
          </Badge>
        ) : null}
        {item?.response?.status != null ? (
          <Badge variant='outline' className='font-mono'>
            返回 {item.response.status}
          </Badge>
        ) : null}
        {item?.api_key_presented ? (
          // 入站 Key 是攻击者可控的明文：只渲染掩码，不设 title、不提供复制。
          <Badge variant='outline' className='font-mono'>
            入站 Key {maskPresentedKey(item.api_key_presented)}
          </Badge>
        ) : null}
      </div>
      <div className='flex flex-wrap gap-1'>
        {list.map((s) => (
          <button
            key={s.id}
            type='button'
            data-active={s.id === current.id}
            onClick={() => setActive(s.id)}
            className={cn(
              'cursor-pointer rounded-md border px-2.5 py-1 text-xs transition-colors',
              'hover:bg-muted/60 data-[active=true]:border-primary/50 data-[active=true]:bg-primary/10 data-[active=true]:text-primary'
            )}
          >
            {s.label}
          </button>
        ))}
      </div>
      <div className='overflow-hidden rounded-lg border'>
        <div className='flex items-center justify-between border-b bg-muted/40 px-3 py-1'>
          <span className='text-xs text-muted-foreground'>
            {current.label}
            {current.note ? ` · ${current.note}` : ''}
          </span>
          <CopyButton text={text} />
        </div>
        <pre className='max-h-[55vh] overflow-auto bg-muted/20 p-3 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap'>
          {text}
        </pre>
      </div>
    </div>
  )
}
