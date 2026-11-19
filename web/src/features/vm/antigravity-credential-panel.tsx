import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { Copy, ExternalLink } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { hasSlotCredential } from '@/lib/vm-kind'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { dashboardQueryOptions } from '@/features/overview/queries'
import {
  antigravityOAuthAuthenticated,
  antigravityOAuthExpired,
  antigravityOAuthMessage,
  antigravityOAuthPending,
  antigravityOAuthUrl,
  mergeAntigravityOAuthSession,
  type AntigravityOAuthSession,
} from '@/features/vm/antigravity-oauth'
import type { CommitResult } from '@/features/vm/credential-panel'
import { vmQueryOptions, vmsListQueryOptions } from '@/features/vm/queries'
import { useVmPerms } from '@/features/vm/vm-perms'

type CredentialProps = {
  vm: Vm
  onCommitted?: (data: CommitResult, vmId: string, what: string) => void
}
type Action = '' | 'start' | 'complete' | 'cancel'

export function AntigravityCredentialPanel(props: CredentialProps) {
  return <AntigravityCredentialSession key={props.vm.id} {...props} />
}

function AntigravityCredentialSession({ vm, onCommitted }: CredentialProps) {
  const perms = useVmPerms()
  const qc = useQueryClient()
  const base = `/api/panel/vms/${encodeURIComponent(vm.id)}/antigravity/oauth`
  const [session, setSession] = useState<AntigravityOAuthSession | null>(null)
  const [code, setCode] = useState('')
  const [failure, setFailure] = useState('')
  const [action, setAction] = useState<Action>('')
  const [now, setNow] = useState(() => Date.now())
  const alive = useRef(true)
  const current = useRef<AntigravityOAuthSession | null>(null)
  const activeAction = useRef<Action>('')
  const committed = useRef('')
  const waiting = antigravityOAuthPending(session)

  const cancelSession = useCallback(
    (sessionId: string) =>
      api<AntigravityOAuthSession>(`${base}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ session_id: sessionId }),
      }),
    [base]
  )

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      if (antigravityOAuthPending(current.current)) {
        void cancelSession(current.current!.session_id).catch(() => undefined)
      }
    }
  }, [cancelSession])

  const receive = useCallback(
    (next: AntigravityOAuthSession, replace = false) => {
      if (!alive.current) return
      const accepted = replace
        ? next
        : mergeAntigravityOAuthSession(current.current, next)
      if (!accepted) return
      current.current = accepted
      setSession(accepted)
      if (
        !antigravityOAuthAuthenticated(accepted) ||
        committed.current === accepted.session_id
      )
        return
      committed.current = accepted.session_id
      setCode('')
      void Promise.all([
        qc.invalidateQueries({ queryKey: vmQueryOptions(vm.id).queryKey }),
        qc.invalidateQueries({ queryKey: vmsListQueryOptions().queryKey }),
        qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
      ])
      const message = '已完成 Antigravity OAuth'
      if (onCommitted) onCommitted({}, vm.id, message)
      else toast.success(message)
    },
    [onCommitted, qc, vm.id]
  )

  const status = useQuery({
    queryKey: [
      'panel',
      'vm',
      vm.id,
      'antigravity',
      'oauth',
      base,
      session?.session_id,
    ] as const,
    queryFn: ({ signal }) =>
      api<AntigravityOAuthSession>(
        `${base}/session?session_id=${encodeURIComponent(session!.session_id)}`,
        { signal }
      ),
    enabled: perms.credential && waiting,
    refetchInterval: waiting ? 1500 : false,
    retry: false,
    gcTime: 0,
  })

  useEffect(() => {
    if (status.data && activeAction.current !== 'cancel') receive(status.data)
  }, [status.data, receive])

  useEffect(() => {
    if (!waiting) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [waiting])

  useEffect(() => {
    if (!session || !antigravityOAuthExpired(session, now)) return
    receive({
      ...session,
      status: 'expired',
      message: '授权会话已过期，请重新生成授权链接。',
    })
    void cancelSession(session.session_id).catch(() => undefined)
    setCode('')
  }, [now, session, receive, cancelSession])

  function beginAction(next: Action) {
    if (!perms.credential || activeAction.current) return false
    activeAction.current = next
    setAction(next)
    setFailure('')
    return true
  }

  function endAction() {
    activeAction.current = ''
    if (alive.current) setAction('')
  }

  async function start() {
    if (antigravityOAuthPending(current.current) || !beginAction('start'))
      return
    setCode('')
    try {
      const next = await api<AntigravityOAuthSession>(`${base}/start`, {
        method: 'POST',
        body: JSON.stringify({}),
      })
      if (!next.session_id) throw new Error('服务未返回授权会话，请重试。')
      if (!alive.current) {
        if (antigravityOAuthPending(next))
          void cancelSession(next.session_id).catch(() => undefined)
        return
      }
      receive(next, true)
    } catch (error) {
      if (alive.current) setFailure((error as Error).message)
    } finally {
      endAction()
    }
  }

  async function complete() {
    const pending = current.current
    const submitted = code.trim()
    if (
      !pending ||
      pending.status !== 'awaiting_code' ||
      !submitted ||
      /\s/.test(submitted) ||
      antigravityOAuthExpired(pending, Date.now()) ||
      !beginAction('complete')
    )
      return
    receive({ ...pending, status: 'verifying', message: '', error: null })
    try {
      const next = await api<AntigravityOAuthSession>(`${base}/complete`, {
        method: 'POST',
        body: JSON.stringify({
          session_id: pending.session_id,
          code: submitted,
        }),
      })
      if (next.session_id !== pending.session_id)
        throw new Error('授权会话不匹配，请刷新状态后重试。')
      if (
        current.current?.session_id === pending.session_id &&
        antigravityOAuthPending(current.current)
      )
        receive(next, true)
      if (alive.current) setCode('')
    } catch (error) {
      if (alive.current) {
        setFailure((error as Error).message)
        if (
          current.current?.session_id === pending.session_id &&
          current.current.status === 'verifying'
        ) {
          receive(
            {
              ...current.current,
              status: 'awaiting_code',
              message: '',
              error: null,
            },
            true
          )
        }
        // A transport error may occur after the client accepted the code; poll the same session.
        void status.refetch()
      }
    } finally {
      endAction()
    }
  }

  async function cancel() {
    const pending = current.current
    if (!pending || !antigravityOAuthPending(pending) || !beginAction('cancel'))
      return
    try {
      receive(await cancelSession(pending.session_id))
      if (alive.current) setCode('')
    } catch (error) {
      if (alive.current) setFailure((error as Error).message)
    } finally {
      endAction()
    }
  }

  return (
    <AntigravityCredentialContent
      session={session}
      code={code}
      now={now}
      action={action}
      failure={failure || status.error?.message || ''}
      canAuthorize={perms.credential}
      permissionKnown={perms.known}
      bound={hasSlotCredential(vm)}
      email={String(vm.email || '')}
      refreshing={status.isFetching}
      onCodeChange={setCode}
      onStart={() => void start()}
      onComplete={() => void complete()}
      onCancel={() => void cancel()}
      onRefresh={() => void status.refetch()}
    />
  )
}

export function AntigravityCredentialContent({
  session,
  code,
  now,
  action,
  failure,
  canAuthorize,
  permissionKnown,
  bound,
  email,
  refreshing,
  onCodeChange,
  onStart,
  onComplete,
  onCancel,
  onRefresh,
}: {
  session: AntigravityOAuthSession | null
  code: string
  now: number
  action: Action
  failure: string
  canAuthorize: boolean
  permissionKnown: boolean
  bound: boolean
  email: string
  refreshing: boolean
  onCodeChange: (value: string) => void
  onStart: () => void
  onComplete: () => void
  onCancel: () => void
  onRefresh: () => void
}) {
  const codeId = useId()
  const expired = antigravityOAuthExpired(session, now)
  const pending = antigravityOAuthPending(session) && !expired
  const url = pending ? antigravityOAuthUrl(session) : ''
  const showCode =
    !!url &&
    (session?.status === 'awaiting_code' || session?.status === 'verifying')
  const seconds = Math.max(
    0,
    Math.ceil((Date.parse(session?.expires_at || '') - now) / 1000)
  )
  const remaining = Number.isFinite(seconds)
    ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
    : ''
  const message = expired
    ? '授权会话已过期，请重新生成授权链接。'
    : antigravityOAuthMessage(session)
  return (
    <div className='space-y-3' aria-label='Antigravity OAuth'>
      <p className='text-sm text-muted-foreground'>
        使用官方 Antigravity OAuth
        登录。授权完成后，凭证由当前槽位内的官方客户端保存。
      </p>
      <p className='text-xs text-muted-foreground'>
        当前账号：
        {bound || antigravityOAuthAuthenticated(session)
          ? '已登录官方客户端'
          : '未绑定'}
        {email ? ` · ${email}` : ''}
      </p>
      {!canAuthorize ? (
        <p className='text-sm text-muted-foreground'>
          {permissionKnown
            ? '当前角色只能查看账号绑定状态。'
            : '正在确认授权权限…'}
        </p>
      ) : (
        <>
          <p
            role='status'
            aria-live='polite'
            className='text-sm text-muted-foreground'
          >
            {message}
          </p>
          {failure ? (
            <p role='alert' className='text-sm text-destructive'>
              {failure}
            </p>
          ) : null}
          {url ? (
            <div className='space-y-2 rounded-md border p-3'>
              <div className='flex flex-wrap items-center gap-2'>
                <Button
                  type='button'
                  size='sm'
                  variant='outline'
                  onClick={() => {
                    void navigator.clipboard.writeText(url).then(
                      () => toast.success('已复制授权链接'),
                      () => toast.error('复制失败，请手动复制链接')
                    )
                  }}
                >
                  <Copy />
                  复制链接
                </Button>
                <Button asChild size='sm' variant='outline'>
                  <a href={url} target='_blank' rel='noreferrer'>
                    <ExternalLink />
                    打开授权页
                  </a>
                </Button>
                {remaining ? (
                  <span className='text-xs text-muted-foreground'>
                    剩余 {remaining}
                  </span>
                ) : null}
              </div>
              <p className='font-mono text-xs break-all text-muted-foreground'>
                {url}
              </p>
            </div>
          ) : null}
          {showCode ? (
            <div className='space-y-2'>
              <Label htmlFor={codeId}>授权码</Label>
              <Input
                id={codeId}
                value={code}
                autoComplete='off'
                spellCheck={false}
                placeholder='粘贴授权页面给出的单行授权码'
                disabled={!!action || session?.status !== 'awaiting_code'}
                onChange={(event) => onCodeChange(event.target.value)}
              />
              <p className='text-xs text-muted-foreground'>
                完成浏览器授权后，复制页面显示的授权码。
              </p>
              {code.trim() && /\s/.test(code.trim()) ? (
                <p role='alert' className='text-xs text-destructive'>
                  请输入单行授权码。
                </p>
              ) : null}
              <Button
                type='button'
                size='sm'
                loading={action === 'complete'}
                disabled={
                  !!action ||
                  session?.status !== 'awaiting_code' ||
                  !code.trim() ||
                  /\s/.test(code.trim())
                }
                onClick={onComplete}
              >
                提交授权码
              </Button>
            </div>
          ) : null}
          <div className='flex flex-wrap items-center gap-2'>
            {pending ? (
              <>
                <Button
                  type='button'
                  size='sm'
                  variant='outline'
                  loading={refreshing}
                  disabled={!!action}
                  onClick={onRefresh}
                >
                  刷新授权状态
                </Button>
                <Button
                  type='button'
                  size='sm'
                  variant='outline'
                  loading={action === 'cancel'}
                  disabled={!!action}
                  onClick={onCancel}
                >
                  取消授权
                </Button>
              </>
            ) : (
              <Button
                type='button'
                size='sm'
                loading={action === 'start'}
                disabled={!!action}
                onClick={onStart}
              >
                {session ? '重新生成授权链接' : '生成授权链接'}
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  )
}
