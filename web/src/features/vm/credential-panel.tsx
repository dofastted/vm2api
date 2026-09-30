import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { AuthScheme, Vm } from '@/types/panel-vm'
import { Copy, ExternalLink } from 'lucide-react'
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
import { proxyHostLabel } from '@/lib/vm-status'
import { Button } from '@/components/ui/button'
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
import { dashboardQueryOptions } from '@/features/overview/queries'
import { CodexCredentialPanel } from '@/features/vm/codex-credential-panel'
import { ConvertOauthToSetupButton } from '@/features/vm/convert-oauth-button'
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

  const busy = gen.isPending || exchange.isPending || importCred.isPending
  const proxyHint =
    link.proxyHint || (vm.proxy?.host ? proxyHostLabel(vm.proxy) : '')

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
                ? 'sessionKey 经槽出口申请完整 OAuth 权限（含 profile、inference、sessions），采集身份并开启账号 Grove（Help improve Claude）。以 Setup Token 模式运行，不跑官方初装；直接粘贴 access token 不增加权限。'
                : SESSION_KEY_PREFIX.test(sessionKey.trim())
                  ? '识别为 sessionKey，将申请完整 OAuth 权限、采集身份并开启账号 Grove，以 Setup Token 模式运行。'
                  : '识别为 access token，将按 Setup Token 直接落盘，不增加权限。'
              : !sessionKey.trim()
                ? 'sk-ant-sid 经槽出口申请完整 OAuth 权限、采集身份并开启账号 Grove（Help improve Claude）；其它值按 access token 直接落盘，不增加权限。'
                : SESSION_KEY_PREFIX.test(sessionKey.trim())
                  ? '识别为 sessionKey，将申请完整 OAuth 权限、采集身份并开启账号 Grove（Help improve Claude）。'
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
              ? `申请完整 OAuth 权限，换票后采集身份并开启账号 Grove（Help improve Claude）。浏览器须走 ${proxyHint || '同一槽出口'}，授权码须含 # 后半段。以 Setup Token 模式运行，不跑官方初装。`
              : `浏览器须走 ${proxyHint || '同一槽出口'}，授权码须含 # 后半段。换票后采集身份并开启账号 Grove（Help improve Claude）。`}
          </Hint>
        </div>
      ) : (
        <div className='space-y-2'>
          <Hint>
            {kind === 'setup-token'
              ? `连接形式：生成完整 OAuth 权限授权链接。换票经槽 SOCKS5，浏览器须走 ${proxyHint || '同一槽出口'}；落盘后仍以 Setup Token 模式运行。`
              : activeMethod === 'cc'
                ? '官方 Claude Code 授权页。换票经槽 SOCKS5，打开链接仍是本机浏览器。'
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
