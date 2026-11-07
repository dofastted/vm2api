import { useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { AuthScheme, Vm } from '@/types/panel-vm'
import {
  Copy,
  ExternalLink,
  Keyboard,
  Link2,
  SquareTerminal,
} from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import {
  authSchemeLabel,
  defaultAuthScheme,
  defaultImportKind,
  defaultImportMethod,
  IMPORT_KINDS,
  importMethodsFor,
  importSurfaceFor,
  importTypeFor,
  oauthFlavorFor,
  resolveImportMethod,
  type ImportKind,
  type ImportMethod,
} from '@/lib/cred-type'
import { importErrorMessage } from '@/lib/import-errors'
import { loginAuthCode } from '@/lib/login-terminal'
import { proxyNamedLabel } from '@/lib/vm-status'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { type LoginTerminalHandle, WsTerminal } from '@/components/ws-terminal'
import { dashboardQueryOptions } from '@/features/overview/queries'
import { CodexCredentialPanel } from '@/features/vm/codex-credential-panel'
import { ConvertOauthToSetupButton } from '@/features/vm/convert-oauth-button'
import { prepareLoginTerminal } from '@/features/vm/login-terminal-start'
import { vmQueryOptions } from '@/features/vm/queries'

export type CommitResult = {
  official_cc_bootstrap?: { scheduled?: boolean; reason?: string } | null
  oauth_email?: string
}

const SESSION_KEY_PREFIX = /^sk-ant-sid/i
const CONSOLE_KEY_PREFIX = /^sk-ant-api03-/i

type Link = {
  sessionId: string
  authUrl: string
  expiresAt: number
  proxyHint: string
  /** 生成这条链接时的「类型+方式」签名，用于判断当前面板能否复用它。 */
  sig: string
}

const EMPTY_LINK: Link = {
  sessionId: '',
  authUrl: '',
  expiresAt: 0,
  proxyHint: '',
  sig: '',
}

function useCountdown(expiresAt: number) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!expiresAt) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [expiresAt])
  if (!expiresAt) return ''
  const left = Math.floor((expiresAt - now) / 1000)
  if (left <= 0) return '已过期'
  const m = Math.floor(left / 60)
  return `${m}:${String(left % 60).padStart(2, '0')}`
}

function Seg<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string
  value: T
  options: { id: T; label: string }[]
  onChange: (next: T) => void
  disabled?: boolean
}) {
  return (
    <div
      role='tablist'
      aria-label={label}
      className='flex flex-wrap items-center gap-1.5'
    >
      {options.map((o) => (
        <Button
          key={o.id}
          type='button'
          role='tab'
          size='sm'
          aria-selected={value === o.id}
          disabled={disabled}
          variant={value === o.id ? 'default' : 'outline'}
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </Button>
      ))}
    </div>
  )
}

function Hint({ children }: { children: React.ReactNode }) {
  return <p className='text-xs text-muted-foreground'>{children}</p>
}

export function CredentialPanel({
  vm,
  onCommitted,
  showConvert = true,
}: {
  vm: Vm
  /** 凭证落盘后回调，交由调用方决定跳转 / 追踪初装。 */
  onCommitted?: (data: CommitResult, vmId: string, what: string) => void
  showConvert?: boolean
}) {
  if (importSurfaceFor(vm) === 'codex') {
    return <CodexCredentialPanel vm={vm} onCommitted={onCommitted} />
  }
  return (
    <ClaudeCredentialPanel
      key={vm.id}
      vm={vm}
      onCommitted={onCommitted}
      showConvert={showConvert}
    />
  )
}

function ClaudeCredentialPanel({
  vm,
  onCommitted,
  showConvert = true,
}: {
  vm: Vm
  onCommitted?: (data: CommitResult, vmId: string, what: string) => void
  showConvert?: boolean
}) {
  const qc = useQueryClient()
  const vmId = vm.id

  const [kind, setKind] = useState<ImportKind>(defaultImportKind)
  const [method, setMethod] = useState<ImportMethod>(() =>
    defaultImportMethod(defaultImportKind())
  )
  // 跟随**面板选中的凭证类型**，不是槽位当前的类型。
  const [authScheme, setAuthScheme] = useState<AuthScheme>(() =>
    defaultAuthScheme(defaultImportKind())
  )
  const [link, setLink] = useState<Link>(EMPTY_LINK)
  const [code, setCode] = useState('')
  const [sessionKey, setSessionKey] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [loginOpen, setLoginOpen] = useState(false)
  const [loginUrl, setLoginUrl] = useState('')
  const [loginCode, setLoginCode] = useState('')
  const loginTerm = useRef<LoginTerminalHandle>(null)
  const activeMethod = resolveImportMethod(kind, method)
  const sig = `${kind}:${activeMethod}`
  const linkReady = !!(link.sessionId && link.authUrl && link.sig === sig)
  const remaining = useCountdown(linkReady ? link.expiresAt : 0)
  const methods = importMethodsFor(kind)

  function switchKind(next: ImportKind) {
    if (next === kind) return
    setKind(next)
    setMethod(defaultImportMethod(next))
    setLink(EMPTY_LINK)
    setCode('')
    setAuthScheme(defaultAuthScheme(next))
  }

  function switchMethod(next: ImportMethod) {
    if (next === method) return
    setMethod(next)
    setLink(EMPTY_LINK)
    setCode('')
  }

  useEffect(() => {
    setLink(EMPTY_LINK)
    setCode('')
  }, [vmId])

  const invalidate = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
      qc.invalidateQueries({ queryKey: vmQueryOptions(vmId).queryKey }),
    ])

  const gen = useMutation({
    mutationFn: (force: boolean) =>
      api<{
        auth_url?: string
        session_id?: string
        expires_at?: number
        proxy_hint?: string | null
        reused?: boolean
      }>(`/api/panel/vms/${encodeURIComponent(vmId)}/oauth/generate-auth-url`, {
        method: 'POST',
        body: JSON.stringify({
          // 必须发下划线风格的 setup_token —— 发 claude_setup_token 会被静默
          // 降级成 CAI PKCE 流程且不报错。
          flavor: oauthFlavorFor(kind, activeMethod),
          force,
        }),
      }),
    onSuccess: (d) => {
      setLink({
        sessionId: String(d.session_id || ''),
        authUrl: String(d.auth_url || ''),
        expiresAt: Number(d.expires_at) || 0,
        proxyHint: String(d.proxy_hint || ''),
        sig,
      })
      setCode('')
      toast.success('授权链接已生成')
    },
    onError: (e: Error) => toast.error(importErrorMessage(e)),
  })

  const exchange = useMutation({
    mutationFn: () =>
      api<CommitResult>(
        `/api/panel/vms/${encodeURIComponent(vmId)}/oauth/exchange-code`,
        {
          method: 'POST',
          body: JSON.stringify({
            session_id: link.sessionId,
            code: code.trim(),
            flavor: oauthFlavorFor(kind, activeMethod),
            auth_scheme: authScheme,
          }),
        }
      ),
    onSuccess: async (d) => {
      setCode('')
      setLink(EMPTY_LINK)
      await invalidate()
      onCommitted?.(d, vmId, '换票完成')
    },
    onError: (e: Error) => toast.error(importErrorMessage(e)),
  })

  const importCred = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {
        vm_id: vmId,
        auth_scheme: authScheme,
      }
      if (kind === 'apikey') {
        body.type = 'apikey'
        body.api_key = apiKey.trim()
      } else {
        const type = importTypeFor(kind)
        if (type) {
          body.type = type
          body.scope = 'inference'
        }
        const value = sessionKey.trim()
        // 前缀决定分支：sk-ant-sid 走 cookie 换票，否则按 access token 落盘
        if (SESSION_KEY_PREFIX.test(value)) body.session_key = value
        else body.access_token = value
      }
      return api<CommitResult>('/api/panel/vms/import', {
        method: 'POST',
        body: JSON.stringify(body),
      })
    },
    onSuccess: async (d) => {
      // 明文凭证提交后立即丢弃，不回显
      setApiKey('')
      setSessionKey('')
      await invalidate()
      onCommitted?.(d, vmId, '已导入')
    },
    onError: (e: Error) => toast.error(importErrorMessage(e)),
  })

  const openLogin = useMutation({
    mutationFn: () => prepareLoginTerminal(vm),
    onSuccess: () => {
      setLoginUrl('')
      setLoginCode('')
      setLoginOpen(true)
      void invalidate()
    },
    onError: (error: Error) => toast.error(importErrorMessage(error)),
  })

  const busy =
    gen.isPending ||
    exchange.isPending ||
    importCred.isPending ||
    openLogin.isPending
  const proxyHint =
    link.proxyHint || (vm.proxy?.host ? proxyNamedLabel(vm.proxy) : '')

  return (
    <div className='space-y-3'>
      <Seg
        label='凭证类型'
        value={kind}
        options={IMPORT_KINDS}
        onChange={switchKind}
        disabled={busy}
      />

      {methods.length ? (
        <Seg
          label='导入方式'
          value={activeMethod}
          options={methods}
          onChange={switchMethod}
          disabled={busy}
        />
      ) : null}

      {showConvert ? (
        <ConvertOauthToSetupButton vm={vm} onCommitted={onCommitted} />
      ) : null}

      {kind !== 'oauth' ? (
        <div className='space-y-1'>
          <Label htmlFor='cred-auth-scheme'>上游认证</Label>
          <Select
            value={authScheme}
            onValueChange={(v) => setAuthScheme(v as AuthScheme)}
            disabled={busy}
          >
            <SelectTrigger id='cred-auth-scheme' className='w-full sm:w-72'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='x_api_key'>
                {authSchemeLabel('x_api_key')}
              </SelectItem>
              <SelectItem value='authorization_bearer'>
                {authSchemeLabel('authorization_bearer')}
              </SelectItem>
            </SelectContent>
          </Select>
          <Hint>
            Claude Console 可用 Authorization: Bearer 调用 Setup Token。兼容上游
            也可改回 x-api-key。
          </Hint>
        </div>
      ) : null}

      {kind === 'apikey' ? (
        <div className='space-y-2'>
          <Label htmlFor='cred-api-key'>Console API Key</Label>
          <Input
            id='cred-api-key'
            type='password'
            autoComplete='off'
            value={apiKey}
            disabled={busy}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder='sk-ant-api03-…'
          />
          <Hint>
            console.anthropic.com 静态密钥，提交后立即从表单清除、不回显。
            不刷新、不跑官方初装。
          </Hint>
          <Button
            size='sm'
            disabled={!CONSOLE_KEY_PREFIX.test(apiKey.trim()) || busy}
            loading={importCred.isPending}
            onClick={() => importCred.mutate()}
          >
            {importCred.isPending ? '写入中…' : '导入'}
          </Button>
          {apiKey.trim() && !CONSOLE_KEY_PREFIX.test(apiKey.trim()) ? (
            <Hint>需要 sk-ant-api03- 开头的 Console API Key。</Hint>
          ) : null}
        </div>
      ) : activeMethod === 'session' ? (
        <div className='space-y-2'>
          <Label htmlFor='cred-session-key'>sessionKey / access token</Label>
          <Input
            id='cred-session-key'
            type='password'
            autoComplete='off'
            value={sessionKey}
            disabled={busy}
            onChange={(e) => setSessionKey(e.target.value)}
            placeholder='sk-ant-sid01-… 或 access token，不会回显'
          />
          <Hint>
            {kind === 'setup-token'
              ? !sessionKey.trim()
                ? 'sessionKey 经槽出口申请完整 OAuth 权限（含 profile、inference、sessions），换票后采集身份。以 Setup Token 模式运行，不跑官方初装；直接粘贴 access token 不增加权限。'
                : SESSION_KEY_PREFIX.test(sessionKey.trim())
                  ? '识别为 sessionKey，将申请完整 OAuth 权限、换票后采集身份，以 Setup Token 模式运行。'
                  : '识别为 access token，将按 Setup Token 直接落盘，不增加权限。'
              : !sessionKey.trim()
                ? 'sk-ant-sid 经槽出口申请完整 OAuth 权限、换票后采集身份；其它值按 access token 直接落盘，不增加权限。'
                : SESSION_KEY_PREFIX.test(sessionKey.trim())
                  ? '识别为 sessionKey，将申请完整 OAuth 权限、换票后采集身份。'
                  : '识别为 access token，将直接落盘，不增加权限。'}
          </Hint>
          <Button
            size='sm'
            disabled={!sessionKey.trim() || busy}
            loading={importCred.isPending}
            onClick={() => importCred.mutate()}
          >
            {importCred.isPending ? '换票中…' : '导入'}
          </Button>
        </div>
      ) : activeMethod === 'cc' ? (
        <div className='space-y-2'>
          <Hint>
            未运行的槽位会先使用已绑定的出口开机，再打开终端启动 claude。
            授权链接提取后显示在这里，复制后把授权码回填。
          </Hint>
          <Button
            size='sm'
            disabled={busy}
            loading={openLogin.isPending}
            onClick={() => openLogin.mutate()}
          >
            {openLogin.isPending
              ? '正在准备登录终端…'
              : vm.status?.toLowerCase() === 'running'
                ? '打开官方登录终端'
                : '启动并打开官方登录终端'}
          </Button>
          <Dialog open={loginOpen} onOpenChange={setLoginOpen}>
            <DialogContent className='flex h-[min(820px,calc(100svh-1.5rem))] w-[min(1120px,calc(100vw-1.5rem))] max-w-none flex-col gap-0 overflow-hidden border-border/70 bg-background p-0'>
              <div className='shrink-0 border-b bg-muted/15 px-5 py-4'>
                <DialogHeader className='gap-1'>
                  <div className='flex items-center gap-2.5'>
                    <span className='grid size-8 place-items-center rounded-md bg-foreground text-background'>
                      <SquareTerminal className='size-4' aria-hidden='true' />
                    </span>
                    <div className='min-w-0'>
                      <DialogTitle className='text-base'>
                        Claude Code 登录
                      </DialogTitle>
                      <DialogDescription className='mt-1 text-xs'>
                        在真实 cli-node TUI 中完成
                        OAuth。链接、回调码和终端保持在同一窗口。
                      </DialogDescription>
                    </div>
                    <span className='ml-auto hidden items-center gap-1 rounded-full border bg-background px-2 py-1 font-mono text-[10px] text-muted-foreground sm:inline-flex'>
                      <span className='size-1.5 rounded-full bg-zinc-400' />
                      PTY / TUI
                    </span>
                  </div>
                </DialogHeader>
              </div>

              <div className='grid min-h-0 flex-1 grid-rows-[minmax(340px,1fr)_auto] lg:grid-cols-[minmax(0,1fr)_320px] lg:grid-rows-1'>
                <section className='flex min-h-0 flex-col bg-[#080a0d] p-3 sm:p-4'>
                  <div className='mb-2 flex shrink-0 items-center justify-between gap-3 px-1 text-[11px] text-zinc-400'>
                    <div className='flex min-w-0 items-center gap-2'>
                      <span className='font-mono text-zinc-200'>
                        claude auth login
                      </span>
                      <span className='truncate text-zinc-600'>
                        /home/kincli
                      </span>
                    </div>
                    <button
                      type='button'
                      className='inline-flex shrink-0 items-center gap-1 rounded border border-zinc-700 px-2 py-1 text-[10px] text-zinc-400 transition-colors hover:border-zinc-500 hover:text-zinc-100 focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:outline-none'
                      onClick={() => loginTerm.current?.focus()}
                    >
                      <Keyboard className='size-3' aria-hidden='true' />
                      聚焦终端
                    </button>
                  </div>
                  <div className='min-h-0 flex-1 rounded-lg border border-zinc-800 bg-[#0b0d10] p-1 shadow-[0_16px_50px_rgba(0,0,0,0.28)]'>
                    {loginOpen ? (
                      <WsTerminal
                        ref={loginTerm}
                        ticketPath={`/api/panel/vms/${encodeURIComponent(vmId)}/shell-ticket`}
                        socketPath={`/api/panel/vms/${encodeURIComponent(vmId)}/shell`}
                        officialLogin
                        onAuthUrl={setLoginUrl}
                        onLogin={() => {
                          void invalidate()
                          toast.success('官方登录已写入槽凭证')
                        }}
                      />
                    ) : null}
                  </div>
                  <p className='mt-2 shrink-0 px-1 text-[11px] leading-relaxed text-zinc-500'>
                    终端已连接后可直接键入或粘贴{' '}
                    <code className='text-zinc-300'>code#state</code>，再按
                    Enter；右侧回填框适合从浏览器复制完整回调码。
                  </p>
                </section>

                <aside className='min-h-0 overflow-y-auto border-t bg-muted/20 p-4 lg:border-t-0 lg:border-l'>
                  <div className='space-y-4'>
                    <div>
                      <div className='mb-2 flex items-center gap-2'>
                        <span className='grid size-6 place-items-center rounded-full bg-foreground text-[11px] font-semibold text-background'>
                          1
                        </span>
                        <div>
                          <p className='text-sm font-medium'>复制授权链接</p>
                          <p className='text-[11px] text-muted-foreground'>
                            打开浏览器完成 Claude 登录
                          </p>
                        </div>
                      </div>
                      <div className='flex gap-2'>
                        <Input
                          aria-label='Claude Code 授权链接'
                          readOnly
                          value={loginUrl}
                          placeholder='等待终端显示链接…'
                          className='h-9 min-w-0 bg-background font-mono text-[11px]'
                        />
                        <Button
                          type='button'
                          size='sm'
                          variant='outline'
                          className='h-9 shrink-0 gap-1.5 px-2.5'
                          aria-label='复制授权链接'
                          disabled={!loginUrl}
                          onClick={async () => {
                            try {
                              await navigator.clipboard.writeText(loginUrl)
                              toast.success('已复制授权链接')
                            } catch {
                              toast.error('复制失败，请手动选中链接')
                            }
                          }}
                        >
                          <Copy className='size-3.5' aria-hidden='true' />
                          <span className='sr-only sm:not-sr-only'>
                            复制链接
                          </span>
                        </Button>
                      </div>
                      {loginUrl ? (
                        <a
                          className='mt-2 inline-flex items-center gap-1 text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground'
                          href={loginUrl}
                          target='_blank'
                          rel='noreferrer'
                        >
                          <Link2 className='size-3' aria-hidden='true' />
                          在新标签页打开
                          <ExternalLink className='size-3' aria-hidden='true' />
                        </a>
                      ) : null}
                    </div>

                    <div className='border-t pt-4'>
                      <div className='mb-2 flex items-center gap-2'>
                        <span className='grid size-6 place-items-center rounded-full bg-foreground text-[11px] font-semibold text-background'>
                          2
                        </span>
                        <div>
                          <p className='text-sm font-medium'>
                            回填 callback code
                          </p>
                          <p className='text-[11px] text-muted-foreground'>
                            必须包含 # 后半段 state
                          </p>
                        </div>
                      </div>
                      <Textarea
                        id='login-auth-code'
                        rows={4}
                        value={loginCode}
                        autoComplete='off'
                        spellCheck={false}
                        placeholder='粘贴完整 code#state'
                        className='resize-none bg-background font-mono text-xs leading-relaxed'
                        onChange={(event) => setLoginCode(event.target.value)}
                        onKeyDown={(event) => {
                          if (
                            (event.metaKey || event.ctrlKey) &&
                            event.key === 'Enter'
                          ) {
                            event.preventDefault()
                            const value = loginAuthCode(loginCode)
                            if (value) {
                              loginTerm.current?.paste(value)
                              setLoginCode('')
                            }
                          }
                        }}
                      />
                      <Button
                        type='button'
                        size='sm'
                        className='mt-2 w-full'
                        disabled={!loginAuthCode(loginCode)}
                        onClick={() => {
                          loginTerm.current?.paste(loginAuthCode(loginCode))
                          setLoginCode('')
                        }}
                      >
                        回填到终端
                      </Button>
                      <p className='mt-2 text-[11px] leading-relaxed text-muted-foreground'>
                        回填后终端会自动按
                        Enter。也可以点击左侧终端，直接粘贴并提交。
                      </p>
                    </div>

                    <div className='rounded-md border border-dashed bg-background/70 p-3 text-[11px] leading-relaxed text-muted-foreground'>
                      <div className='mb-1 flex items-center gap-1.5 text-foreground'>
                        <Keyboard className='size-3.5' aria-hidden='true' />
                        终端快捷方式
                      </div>
                      <p>
                        链接出现后可复制；授权页回调时不要关闭终端。换票成功后窗口会自动提示并写入槽位。
                      </p>
                    </div>
                  </div>
                </aside>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      ) : linkReady ? (
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
            <Label htmlFor='cred-code'>授权码</Label>
            <Textarea
              id='cred-code'
              rows={2}
              value={code}
              disabled={busy}
              onChange={(e) => setCode(e.target.value)}
              placeholder='完整授权码，含 # 后半段'
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
              onClick={() => gen.mutate(true)}
            >
              重新生成
            </Button>
          </div>
          <Hint>
            {kind === 'setup-token'
              ? `申请完整 OAuth 权限，换票后采集身份。浏览器须走 ${proxyHint || '同一槽出口'}，授权码须含 # 后半段。以 Setup Token 模式运行，不跑官方初装。`
              : `浏览器须走 ${proxyHint || '同一槽出口'}，授权码须含 # 后半段。换票后采集身份。`}
          </Hint>
        </div>
      ) : (
        <div className='space-y-2'>
          <Hint>
            {kind === 'setup-token'
              ? `连接形式：生成完整 OAuth 权限授权链接。换票经槽 SOCKS5，浏览器须走 ${proxyHint || '同一槽出口'}；落盘后仍以 Setup Token 模式运行。`
              : `换票经槽 SOCKS5，浏览器须走 ${proxyHint || '同一 SOCKS5'}。`}
          </Hint>
          <Button
            size='sm'
            disabled={busy}
            loading={gen.isPending}
            onClick={() => gen.mutate(false)}
          >
            {gen.isPending ? '生成中…' : '生成授权链接'}
          </Button>
        </div>
      )}
    </div>
  )
}
