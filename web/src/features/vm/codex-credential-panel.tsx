import { useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { Copy, ExternalLink, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { proxyHostLabel } from '@/lib/vm-status'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { dashboardQueryOptions } from '@/features/overview/queries'
import type { CommitResult } from '@/features/vm/credential-panel'
import { vmQueryOptions } from '@/features/vm/queries'

type CodexImportMode = 'oauth' | 'access_token' | 'refresh_token' | 'json'

const MODES: { id: CodexImportMode; label: string }[] = [
  { id: 'oauth', label: 'OAuth' },
  { id: 'json', label: '账号文件' },
]

type Link = {
  sessionId: string
  authUrl: string
  expiresAt: number
  proxyHint: string
}

const EMPTY_LINK: Link = {
  sessionId: '',
  authUrl: '',
  expiresAt: 0,
  proxyHint: '',
}

function Seg({
  value,
  onChange,
  disabled,
}: {
  value: CodexImportMode
  onChange: (next: CodexImportMode) => void
  disabled?: boolean
}) {
  return (
    <div
      role='tablist'
      aria-label='账号添加方式'
      className='flex flex-wrap items-center gap-1.5'
    >
      {MODES.map((option) => (
        <Button
          key={option.id}
          type='button'
          role='tab'
          size='sm'
          aria-selected={value === option.id}
          disabled={disabled}
          variant={value === option.id ? 'default' : 'outline'}
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </Button>
      ))}
    </div>
  )
}

function Hint({ children }: { children: React.ReactNode }) {
  return <p className='text-xs text-muted-foreground'>{children}</p>
}

function fileSizeLabel(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  return `${Math.max(0.1, bytes / 1024).toFixed(1)} KB`
}

function useCountdown(expiresAt: number) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!expiresAt) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [expiresAt])
  const left = Math.max(0, Math.floor((expiresAt - now) / 1000))
  const mm = String(Math.floor(left / 60)).padStart(2, '0')
  const ss = String(left % 60).padStart(2, '0')
  return `${mm}:${ss}`
}

export function CodexCredentialPanel({
  vm,
  onCommitted,
}: {
  vm: Vm
  onCommitted?: (data: CommitResult, vmId: string, what: string) => void
}) {
  const qc = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const [mode, setMode] = useState<CodexImportMode>('oauth')
  const [text, setText] = useState('')
  const [code, setCode] = useState('')
  const [link, setLink] = useState<Link>(EMPTY_LINK)
  const [fileError, setFileError] = useState('')
  const [pickedFile, setPickedFile] = useState<{
    name: string
    size: number
  } | null>(null)

  const remaining = useCountdown(link.expiresAt)
  const linkReady = !!(link.sessionId && link.authUrl)
  const proxyHint =
    link.proxyHint || (vm.proxy?.host ? proxyHostLabel(vm.proxy) : '')

  useEffect(() => {
    setText('')
    setCode('')
    setLink(EMPTY_LINK)
    setFileError('')
    setPickedFile(null)
  }, [vm.id, mode])

  const invalidate = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
      qc.invalidateQueries({ queryKey: vmQueryOptions(vm.id).queryKey }),
    ])

  const importCred = useMutation({
    mutationFn: () =>
      api<CommitResult>('/api/panel/vms/import', {
        method: 'POST',
        body: JSON.stringify({
          vm_id: vm.id,
          type: 'codex',
          mode,
          auth_json: text,
        }),
      }),
    onSuccess: async (data) => {
      setText('')
      setFileError('')
      setPickedFile(null)
      await invalidate()
      toast.success('已导入 GPT OAuth')
      onCommitted?.(data, vm.id, '已导入 GPT OAuth')
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const gen = useMutation({
    mutationFn: () =>
      api<{
        auth_url?: string
        session_id?: string
        expires_at?: number
        proxy_hint?: string | null
      }>(
        `/api/panel/vms/${encodeURIComponent(vm.id)}/oauth/generate-auth-url`,
        {
          method: 'POST',
          body: JSON.stringify({ flavor: 'codex' }),
        }
      ),
    onSuccess: (data) => {
      setLink({
        sessionId: String(data.session_id || ''),
        authUrl: String(data.auth_url || ''),
        expiresAt: Number(data.expires_at) || 0,
        proxyHint: String(data.proxy_hint || ''),
      })
      setCode('')
      toast.success('授权链接已生成')
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const exchange = useMutation({
    mutationFn: () =>
      api<CommitResult>(
        `/api/panel/vms/${encodeURIComponent(vm.id)}/oauth/exchange-code`,
        {
          method: 'POST',
          body: JSON.stringify({
            session_id: link.sessionId,
            code: code.trim(),
            flavor: 'codex',
          }),
        }
      ),
    onSuccess: async (data) => {
      setCode('')
      setLink(EMPTY_LINK)
      await invalidate()
      toast.success('已完成 Codex OAuth')
      onCommitted?.(data, vm.id, '已完成 Codex OAuth')
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const busy = importCred.isPending || gen.isPending || exchange.isPending
  const placeholder =
    '粘贴或上传 Codex CLI ~/.codex/auth.json、CPR 账号文件，或含 accessToken/refreshToken 的 JSON'

  async function onPickFile(file: File | undefined) {
    setFileError('')
    if (!file) return
    try {
      const raw = await file.text()
      setText(raw)
      setPickedFile({ name: file.name, size: file.size })
    } catch {
      setPickedFile(null)
      setFileError('文件读取失败')
    }
  }

  return (
    <div className='space-y-3'>
      <Hint>
        对齐 Codex Desktop：OAuth 授权或账号文件（auth.json）。不要用 Claude
        sessionKey、Setup Token 或 Console Key。一槽一号。
      </Hint>
      <Seg value={mode} onChange={setMode} disabled={busy} />
      {mode === 'oauth' ? (
        linkReady ? (
          <div className='space-y-2'>
            <div className='flex flex-wrap items-center gap-2'>
              <Button
                size='sm'
                variant='outline'
                onClick={() => {
                  void navigator.clipboard
                    ?.writeText(link.authUrl)
                    .then(() => toast.success('已复制授权链接'))
                    .catch(() => toast.error('复制失败，请手动选中链接'))
                }}
              >
                <Copy className='size-3.5' aria-hidden='true' />
                复制链接
              </Button>
              <a
                className='inline-flex items-center gap-1 text-xs underline'
                href={link.authUrl}
                target='_blank'
                rel='noreferrer'
              >
                打开授权页
                <ExternalLink className='size-3' aria-hidden='true' />
              </a>
            </div>
            <p className='text-xs break-all text-muted-foreground'>
              {link.authUrl}
            </p>
            <p className='text-xs text-muted-foreground tabular-nums'>
              剩余有效 {remaining}
              {proxyHint ? ` · 经 ${proxyHint}` : ''}
            </p>
            <div className='space-y-1'>
              <Label htmlFor='codex-oauth-callback'>回调 URL</Label>
              <Textarea
                id='codex-oauth-callback'
                rows={3}
                value={code}
                disabled={busy}
                onChange={(event) => setCode(event.target.value)}
                placeholder='http://localhost:1455/auth/callback?code=...&state=...'
              />
            </div>
            <div className='flex flex-wrap items-center gap-2'>
              <Button
                size='sm'
                disabled={!code.trim() || busy}
                loading={exchange.isPending}
                onClick={() => exchange.mutate()}
              >
                {exchange.isPending ? '验证中…' : '完成授权'}
              </Button>
              <Button
                size='sm'
                variant='ghost'
                disabled={busy}
                loading={gen.isPending}
                onClick={() => gen.mutate()}
              >
                重新生成
              </Button>
            </div>
            <Hint>
              浏览器走 {proxyHint || '槽 SOCKS5'}。授权完成后把 localhost:1455
              回调整段贴回来。
            </Hint>
          </div>
        ) : (
          <div className='space-y-2'>
            <Hint>
              生成官方 Codex Desktop 授权链接。换票经槽
              SOCKS5，打开链接仍是本机浏览器。
            </Hint>
            <Button
              size='sm'
              disabled={busy}
              loading={gen.isPending}
              onClick={() => gen.mutate()}
            >
              {gen.isPending ? '生成中…' : '生成授权链接'}
            </Button>
          </div>
        )
      ) : (
        <div className='space-y-2'>
          <div className='flex flex-wrap items-center justify-between gap-2'>
            <Label htmlFor='codex-import-text'>
              {mode === 'access_token'
                ? 'Access Token'
                : mode === 'refresh_token'
                  ? 'Refresh Token'
                  : '账号文件'}
            </Label>
            {mode === 'json' ? (
              <>
                <input
                  ref={fileRef}
                  type='file'
                  accept='application/json,.json'
                  className='hidden'
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    event.target.value = ''
                    void onPickFile(file)
                  }}
                />
                <Button
                  type='button'
                  size='sm'
                  variant='outline'
                  disabled={busy}
                  onClick={() => fileRef.current?.click()}
                >
                  <Upload className='size-3.5' aria-hidden='true' />
                  上传文件
                </Button>
              </>
            ) : null}
          </div>
          {pickedFile ? (
            <div className='flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2'>
              <div className='min-w-0'>
                <p className='truncate text-sm'>{pickedFile.name}</p>
                <p className='text-xs text-muted-foreground'>
                  {fileSizeLabel(pickedFile.size)} · 已读取，不展示原文
                </p>
              </div>
              <Button
                type='button'
                size='sm'
                variant='ghost'
                disabled={busy}
                onClick={() => {
                  setPickedFile(null)
                  setText('')
                  setFileError('')
                }}
              >
                清除
              </Button>
            </div>
          ) : (
            <Textarea
              id='codex-import-text'
              rows={8}
              value={text}
              disabled={busy}
              onChange={(event) => {
                setFileError('')
                setText(event.target.value)
              }}
              placeholder={placeholder}
            />
          )}
          {fileError ? (
            <p className='text-xs text-destructive'>{fileError}</p>
          ) : null}
          <Hint>
            支持 Codex CLI ~/.codex/auth.json、kernel accounts、CPR openai
            文档。仅 OPENAI_API_KEY 的客户端配置不能当 OAuth 导入。
          </Hint>
          <Button
            size='sm'
            disabled={!text.trim() || busy}
            loading={importCred.isPending}
            onClick={() => importCred.mutate()}
          >
            {importCred.isPending ? '写入中…' : '导入 GPT OAuth'}
          </Button>
        </div>
      )}
    </div>
  )
}
