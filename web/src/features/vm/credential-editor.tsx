import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { meQueryOptions } from '@/features/auth/queries'
import { vmCredentialQueryOptions, vmQueryOptions } from '@/features/vm/queries'

function credExportFilename(id: string) {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  return `sub2api-account-${id || 'slot'}-${stamp}.json`
}

function downloadJson(name: string, text: string) {
  const url = URL.createObjectURL(
    new Blob([text], { type: 'application/json' })
  )
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

/**
 * The one place in the panel that shows credential plaintext.
 * Gated on role==='admin' and only fetched once the dialog is opened —
 * never preloaded with the detail page. See spec/frontend/api-contract.md.
 */
export function CredentialEditorButton({ vmId }: { vmId: string }) {
  const me = useQuery(meQueryOptions())
  const [open, setOpen] = useState(false)
  if (me.data?.role !== 'admin') return null
  return (
    <>
      <Button size='sm' variant='outline' onClick={() => setOpen(true)}>
        编辑凭证
      </Button>
      {open ? (
        <CredentialDialog vmId={vmId} open={open} onOpenChange={setOpen} />
      ) : null}
    </>
  )
}

function CredentialDialog({
  vmId,
  open,
  onOpenChange,
}: {
  vmId: string
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const qc = useQueryClient()
  const [text, setText] = useState('')
  const [parseError, setParseError] = useState('')

  const cred = useQuery(vmCredentialQueryOptions(vmId, open))

  useEffect(() => {
    if (!cred.data) return
    setText(JSON.stringify(cred.data.export ?? cred.data, null, 2))
  }, [cred.data])

  const save = useMutation({
    mutationFn: (body: unknown) =>
      api(`/api/panel/vms/${encodeURIComponent(vmId)}/oauth/credential`, {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      toast.success('凭证已写入。此接口不会触发官方初装')
      qc.invalidateQueries({ queryKey: vmQueryOptions(vmId).queryKey })
      qc.removeQueries({ queryKey: vmCredentialQueryOptions(vmId).queryKey })
      onOpenChange(false)
    },
    // never echo the payload back — only the server's own message
    onError: (e: Error) => toast.error(e.message || '写入凭证失败'),
  })

  const submit = () => {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      setParseError('JSON 无效，请检查格式后重试')
      return
    }
    setParseError('')
    save.mutate(parsed)
  }

  const busy = save.isPending

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!busy) {
          if (!v) setText('')
          onOpenChange(v)
        }
      }}
    >
      <DialogContent className='sm:max-w-2xl'>
        <DialogHeader>
          <DialogTitle>编辑槽位凭证</DialogTitle>
          <DialogDescription>
            账号导出的 JSON，至少含 access_token 或 refresh_token。写入只换票，
            不会触发官方 Claude Code 初装。
          </DialogDescription>
        </DialogHeader>

        {cred.isLoading ? (
          <p className='py-8 text-center text-sm text-muted-foreground'>
            读取中…
          </p>
        ) : cred.error ? (
          <p className='py-8 text-center text-sm text-destructive'>
            {(cred.error as Error).message || '读取凭证失败'}
          </p>
        ) : (
          <div className='space-y-2'>
            <Textarea
              className='h-72 font-mono text-xs'
              spellCheck={false}
              value={text}
              disabled={busy}
              onChange={(e) => {
                setText(e.target.value)
                if (parseError) setParseError('')
              }}
            />
            {parseError ? (
              <p className='text-xs text-destructive'>{parseError}</p>
            ) : (
              <p className='text-xs text-muted-foreground'>
                来源 {cred.data?.source || '—'} ·{' '}
                {cred.data?.has_token ? '已有活票' : '无票'}
              </p>
            )}
          </div>
        )}

        <DialogFooter className='gap-2 sm:justify-between'>
          <div className='flex gap-2'>
            <Button
              size='sm'
              variant='ghost'
              disabled={!text || busy}
              onClick={() => {
                navigator.clipboard
                  .writeText(text)
                  .then(() => toast.success('已复制到剪贴板'))
                  .catch(() => toast.error('复制失败'))
              }}
            >
              复制
            </Button>
            <Button
              size='sm'
              variant='ghost'
              disabled={!text || busy}
              onClick={() => downloadJson(credExportFilename(vmId), text)}
            >
              下载 JSON
            </Button>
          </div>
          <div className='flex gap-2'>
            <Button
              size='sm'
              variant='outline'
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              取消
            </Button>
            <Button size='sm' disabled={!text || busy} onClick={submit}>
              {busy ? '写入中…' : '保存凭证'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
