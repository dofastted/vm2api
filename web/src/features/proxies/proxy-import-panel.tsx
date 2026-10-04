import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { House, Import } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { ProxyPanel } from './proxy-panel'
import { useRefreshProxies } from './queries'

type ImportResult = {
  added?: number
  skipped?: number
  skip_details?: { line?: string; reason?: string }[]
}

type ImportOutcome = {
  added: number
  duplicates: string[]
  parseFailed: number
  /** skip_details 只回前 20 条，多出来的只知道数量。 */
  unlisted: number
}

function outcomeOf(data: ImportResult): ImportOutcome {
  const details = data.skip_details || []
  return {
    added: Number(data.added ?? 0),
    // duplicate 的 line 由网关拼成 host:port，不含账密，可以展示。
    duplicates: details
      .filter((d) => d.reason === 'duplicate' && d.line)
      .map((d) => String(d.line)),
    // parse_failed 的 line 是原始输入，可能带账密 —— 只报数量，不回显。
    parseFailed: details.filter((d) => d.reason === 'parse_failed').length,
    unlisted: Math.max(0, Number(data.skipped ?? 0) - details.length),
  }
}

/** 与网关 importLines() 的跳过规则一致：空行与 `#` 注释行不算。 */
function countLines(raw: string): number {
  return raw.split(/\r?\n/).filter((l) => {
    const t = l.trim()
    return t && !t.startsWith('#')
  }).length
}

export function ProxyImportPanel({ hasLocal }: { hasLocal: boolean }) {
  const refresh = useRefreshProxies()
  const [raw, setRaw] = useState('')
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null)
  const lines = countLines(raw)

  const importPx = useMutation({
    mutationFn: () =>
      api<ImportResult>('/api/panel/proxies/import', {
        method: 'POST',
        body: JSON.stringify({ text: raw }),
      }),
    onSuccess: async (data) => {
      const next = outcomeOf(data)
      setOutcome(next)
      setRaw('')
      if (next.added) toast.success(`已导入 ${next.added} 条`)
      else toast.warning('没有新增代理')
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const addLocal = useMutation({
    mutationFn: () =>
      api<{ created?: boolean }>('/api/panel/proxies/local', {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    onSuccess: async (data) => {
      toast.success(data.created ? '已添加本地出口' : '本地出口已存在')
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const submit = () => {
    if (!lines || importPx.isPending) return
    importPx.mutate()
  }

  return (
    <ProxyPanel
      title='添加代理'
      meta={
        <span className='text-xs text-muted-foreground tabular-nums'>
          {lines ? `${lines} 行待导入` : '每行一条'}
        </span>
      }
    >
      <label htmlFor='proxy-import' className='sr-only'>
        代理列表，每行一条
      </label>
      <Textarea
        id='proxy-import'
        value={raw}
        onChange={(event) => {
          setRaw(event.target.value)
          if (outcome) setOutcome(null)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            submit()
          }
        }}
        rows={4}
        spellCheck={false}
        autoComplete='off'
        placeholder={
          'host:port\nsocks5://user:pass@host:port\nhttp://user:pass@host:port'
        }
        className='field-host min-h-24 resize-y text-xs leading-relaxed'
      />
      <p className='mt-1.5 text-[11px] text-muted-foreground'>
        也支持 host:port:user:pass。账密入库后不再回显，重复的自动跳过。
      </p>
      <div className='mt-3 flex flex-wrap items-center gap-2'>
        <Button
          size='sm'
          onClick={submit}
          disabled={!lines || importPx.isPending}
          loading={importPx.isPending}
          title='Ctrl / ⌘ + Enter'
        >
          <Import aria-hidden='true' />
          导入{lines ? ` ${lines} 条` : ''}
        </Button>
        <Button
          size='sm'
          variant='outline'
          onClick={() => addLocal.mutate()}
          disabled={addLocal.isPending || hasLocal}
          loading={addLocal.isPending}
          title='不走 SOCKS5，槽位经宿主机默认路由出站'
        >
          <House aria-hidden='true' />
          {hasLocal ? '已有本地出口' : '本地出口'}
        </Button>
      </div>
      {outcome ? <ImportSummary outcome={outcome} /> : null}
    </ProxyPanel>
  )
}

function ImportSummary({ outcome }: { outcome: ImportOutcome }) {
  const { added, duplicates, parseFailed, unlisted } = outcome
  return (
    <div
      role='status'
      className='mt-3 space-y-1 rounded-lg bg-muted/50 px-3 py-2 text-xs'
    >
      <div className='flex flex-wrap gap-x-3 gap-y-0.5 tabular-nums'>
        <span>
          新增 <b className='font-semibold'>{added}</b>
        </span>
        {duplicates.length ? <span>重复 {duplicates.length}</span> : null}
        {parseFailed ? (
          <span className='text-[color:var(--status-bad)]'>
            无法解析 {parseFailed}
          </span>
        ) : null}
        {unlisted ? (
          <span className='text-muted-foreground'>另跳过 {unlisted}</span>
        ) : null}
      </div>
      {duplicates.length ? (
        <p className='field-host truncate text-[11px] text-muted-foreground'>
          {duplicates.join('  ')}
        </p>
      ) : null}
    </div>
  )
}
