import { useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Textarea } from '@/components/ui/textarea'
import { dashboardQueryOptions } from '@/features/overview/queries'
import { readPackageFacts } from '@/features/vm/vm-package-view'

type ImportResult = {
  vm?: { id?: string; status?: string }
  renamed_from?: string | null
  start_error?: string | null
  official_cc_bootstrap?: { scheduled?: boolean; reason?: string } | null
  probe?: { ok?: boolean; error?: string } | null
}

export function progressOf(
  result: ImportResult | null,
  busy: boolean,
  tick: number
) {
  if (busy) {
    return {
      value: Math.min(88, 12 + tick),
      label: '正在创建虚拟机',
      detail: '',
    }
  }
  if (!result?.vm?.id) return null
  const started = !result.start_error
  const installed = !!result.official_cc_bootstrap?.scheduled
  const probed = !!result.probe?.ok
  const value = probed ? 100 : installed ? 75 : started ? 50 : 25
  const label = !started
    ? `已创建 ${result.vm.id}，启动未完成`
    : !installed
      ? `${result.vm.id} 已启动，初装未排队`
      : !probed
        ? `${result.vm.id} 初装已排队，探测未完成`
        : `${result.vm.id} 已创建`
  const renamed = result.renamed_from
    ? `${result.renamed_from} 已占用，落到 ${result.vm.id}`
    : ''
  const failure =
    result.start_error ||
    result.probe?.error ||
    result.official_cc_bootstrap?.reason ||
    ''
  const detail = [renamed, failure].filter(Boolean).join('；')
  return { value, label, detail }
}

export function VmPackageImportCard() {
  const qc = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const [text, setText] = useState('')
  const [parseError, setParseError] = useState('')
  const [result, setResult] = useState<ImportResult | null>(null)
  const [tick, setTick] = useState(0)

  const importPackage = useMutation({
    mutationFn: (body: unknown) =>
      api<ImportResult>('/api/panel/vms/package', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: async (data) => {
      setResult(data)
      const id = data?.vm?.id
      toast.success(
        data?.renamed_from
          ? `${data.renamed_from} 已占用，已创建 ${id}`
          : `已创建 ${id || '虚拟机'}`
      )
      await qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey })
    },
    onError: (e: Error) => toast.error(e.message || '导入失败'),
  })

  const busy = importPackage.isPending
  useEffect(() => {
    if (!busy) return
    const timer = window.setInterval(() => setTick((n) => n + 4), 400)
    return () => window.clearInterval(timer)
  }, [busy])

  const submit = () => {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      setParseError('JSON 无效，请检查格式后重试')
      return
    }
    setParseError('')
    setTick(0)
    setResult(null)
    importPackage.mutate(parsed)
  }

  const facts = parseError ? null : readPackageFacts(text)
  const progress = progressOf(result, busy, tick)
  const summary =
    facts && facts.ok
      ? [facts.id, facts.platform, facts.proxy, facts.credential]
          .filter(Boolean)
          .join(' · ')
      : ''

  return (
    <div className='space-y-4'>
      <p className='max-w-[62ch] text-sm leading-relaxed text-muted-foreground'>
        用一份 JSON 创建虚拟机。带了 SOCKS5 就建代理并绑定。id
        被占用时顺延到下一个空号。
      </p>
      <Textarea
        className='h-56 font-mono text-[13px] leading-relaxed'
        spellCheck={false}
        value={text}
        disabled={busy}
        aria-label='虚拟机包 JSON'
        placeholder='把 vm2api-vm-package 贴在这里'
        onChange={(e) => {
          setText(e.target.value)
          if (parseError) setParseError('')
        }}
      />
      {parseError ? (
        <p className='text-xs text-destructive'>{parseError}</p>
      ) : facts && !facts.ok ? (
        <p className='text-xs text-destructive'>{facts.error}</p>
      ) : summary ? (
        <p className='truncate font-mono text-xs text-muted-foreground'>
          {summary}
        </p>
      ) : null}
      {progress ? (
        <div className='space-y-2'>
          <div className='flex items-baseline justify-between gap-3'>
            <p className='text-sm'>{progress.label}</p>
            <p className='text-xs text-muted-foreground tabular-nums'>
              {Math.round(progress.value)}%
            </p>
          </div>
          <Progress value={progress.value} />
          {progress.detail ? (
            <p className='text-xs text-muted-foreground'>{progress.detail}</p>
          ) : null}
        </div>
      ) : null}
      <div className='flex flex-wrap gap-2'>
        <input
          ref={fileRef}
          type='file'
          accept='application/json,.json'
          className='hidden'
          onChange={(e) => {
            const file = e.target.files?.[0]
            e.target.value = ''
            if (!file) return
            file
              .text()
              .then((raw) => {
                setText(raw)
                setParseError('')
                setResult(null)
              })
              .catch(() => setParseError('读取文件失败'))
          }}
        />
        <Button
          size='sm'
          variant='outline'
          disabled={busy}
          onClick={() => fileRef.current?.click()}
        >
          选择文件
        </Button>
        <Button size='sm' disabled={!text.trim() || busy} onClick={submit}>
          {busy ? '创建中…' : '创建虚拟机'}
        </Button>
      </div>
    </div>
  )
}
