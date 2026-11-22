import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { TwoFactorSetup, TwoFactorStatus } from '@/types/panel-auth'
import { KeyRound, ShieldCheck, ShieldOff } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { toast } from 'sonner'
import {
  twoFactorDisableRequest,
  twoFactorEnableRequest,
  twoFactorRecoveryRequest,
  twoFactorSetupRequest,
} from '@/lib/api'
import { copyText } from '@/lib/clipboard'
import { fmtExpiresAt } from '@/lib/format'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from '@/components/ui/input-otp'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { TWO_FACTOR_QUERY_KEY } from './queries'

const OTP_SLOTS = [0, 1, 2, 3, 4, 5]

/** 需要密码再认证的三个入口：绑定、关闭、重新生成恢复码。 */
type Intent = 'setup' | 'disable' | 'recovery'

type Flow =
  | { step: 'idle' }
  | { step: 'password'; intent: Intent }
  /** 密钥已生成但未确认，此时登录还不拦。 */
  | { step: 'verify'; setup: TwoFactorSetup }
  /** 恢复码只在这一步出现，离开后无法再看。 */
  | { step: 'codes'; codes: string[] }

const INTENT_TITLES: Record<Intent, string> = {
  setup: '开启两步验证',
  disable: '关闭两步验证',
  recovery: '重新生成恢复码',
}

function splitGroups(secret: string): string {
  return secret.replace(/(.{4})/g, '$1 ').trim()
}

export function TwoFactorPane({ status }: { status: TwoFactorStatus }) {
  const queryClient = useQueryClient()
  const [flow, setFlow] = useState<Flow>({ step: 'idle' })
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: TWO_FACTOR_QUERY_KEY })

  function reset() {
    setFlow({ step: 'idle' })
    setPassword('')
    setCode('')
    setAcknowledged(false)
  }

  const setupMutation = useMutation({
    mutationFn: () => twoFactorSetupRequest(password),
    onSuccess: (setup) => {
      setPassword('')
      setCode('')
      setFlow({ step: 'verify', setup })
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const enableMutation = useMutation({
    mutationFn: (value: string) => twoFactorEnableRequest(value),
    onSuccess: async (result) => {
      toast.success('两步验证已开启')
      setCode('')
      setFlow({ step: 'codes', codes: result.recovery_codes })
      await refresh()
    },
    onError: (error: Error) => {
      setCode('')
      toast.error(error.message)
    },
  })

  const disableMutation = useMutation({
    mutationFn: () => twoFactorDisableRequest(password, code.trim()),
    onSuccess: async () => {
      toast.success('两步验证已关闭')
      reset()
      await refresh()
    },
    onError: (error: Error) => {
      setCode('')
      toast.error(error.message)
    },
  })

  const recoveryMutation = useMutation({
    mutationFn: () => twoFactorRecoveryRequest(password),
    onSuccess: async (result) => {
      toast.success('已生成新的恢复码，旧的全部失效')
      setPassword('')
      setFlow({ step: 'codes', codes: result.recovery_codes })
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const pending =
    setupMutation.isPending ||
    enableMutation.isPending ||
    disableMutation.isPending ||
    recoveryMutation.isPending

  async function copy(text: string, label: string) {
    const ok = await copyText(text)
    if (ok) toast.success(`${label}已复制`)
    else toast.error(`${label}复制失败，请手动选择`)
  }

  function submitPassword(intent: Intent) {
    if (intent === 'setup') setupMutation.mutate()
    else if (intent === 'recovery') recoveryMutation.mutate()
    else disableMutation.mutate()
  }

  return (
    <Card>
      <CardHeader className='flex flex-row items-center justify-between gap-2'>
        <CardTitle className='flex items-center gap-2'>
          <ShieldCheck aria-hidden className='size-4' />
          两步验证
        </CardTitle>
        {status.enabled ? (
          <Badge variant='default'>已开启</Badge>
        ) : status.pending ? (
          <Badge variant='secondary'>待确认</Badge>
        ) : (
          <Badge variant='outline'>未开启</Badge>
        )}
      </CardHeader>
      <CardContent className='space-y-4'>
        <p className='text-sm text-muted-foreground'>
          开启后，登录控制台除密码外还需输入验证器 App 的 6 位动态验证码
          （TOTP，30 秒一轮）。API 密钥调用不受影响。
        </p>

        {status.enabled ? (
          <div className='rounded-lg border px-4 py-3 text-sm'>
            <div className='flex flex-wrap items-center justify-between gap-2'>
              <span className='text-muted-foreground'>
                开启时间：
                {status.confirmed_at ? fmtExpiresAt(status.confirmed_at) : '—'}
              </span>
              <span
                className={
                  status.recovery_remaining === 0
                    ? 'font-medium text-destructive'
                    : 'text-muted-foreground'
                }
              >
                剩余恢复码：{status.recovery_remaining} /{' '}
                {status.recovery_total}
              </span>
            </div>
            {status.recovery_remaining === 0 ? (
              <p className='mt-2 text-xs text-destructive'>
                恢复码已全部用完。丢失验证器后将无法自助登录，建议立即重新生成。
              </p>
            ) : null}
          </div>
        ) : null}

        {flow.step === 'idle' ? (
          <div className='flex flex-wrap gap-2'>
            {status.enabled ? (
              <>
                <Button
                  variant='outline'
                  onClick={() =>
                    setFlow({ step: 'password', intent: 'recovery' })
                  }
                >
                  <KeyRound aria-hidden className='size-4' />
                  重新生成恢复码
                </Button>
                <Button
                  variant='destructive'
                  onClick={() =>
                    setFlow({ step: 'password', intent: 'disable' })
                  }
                >
                  <ShieldOff aria-hidden className='size-4' />
                  关闭两步验证
                </Button>
              </>
            ) : (
              <Button
                onClick={() => setFlow({ step: 'password', intent: 'setup' })}
              >
                <ShieldCheck aria-hidden className='size-4' />
                {status.pending ? '重新绑定验证器' : '开启两步验证'}
              </Button>
            )}
          </div>
        ) : null}

        {flow.step === 'password' ? (
          <form
            className='space-y-3 rounded-lg border p-4'
            onSubmit={(event) => {
              event.preventDefault()
              submitPassword(flow.intent)
            }}
          >
            <p className='text-sm font-medium'>{INTENT_TITLES[flow.intent]}</p>
            <div className='space-y-2'>
              <Label htmlFor='twofa-password'>当前密码</Label>
              <Input
                id='twofa-password'
                type='password'
                autoComplete='current-password'
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <p className='text-xs text-muted-foreground'>
                改动两步验证需要再次验证密码。
              </p>
            </div>
            {flow.intent === 'disable' ? (
              <div className='space-y-2'>
                <Label htmlFor='twofa-disable-code'>验证码或恢复码</Label>
                <Input
                  id='twofa-disable-code'
                  className='font-mono tracking-widest'
                  autoComplete='one-time-code'
                  placeholder='6 位验证码 / XXXXX-XXXXX'
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
              </div>
            ) : null}
            <div className='flex gap-2'>
              <Button
                type='submit'
                disabled={
                  pending ||
                  !password ||
                  (flow.intent === 'disable' && !code.trim())
                }
              >
                {pending ? '处理中…' : '继续'}
              </Button>
              <Button
                type='button'
                variant='ghost'
                onClick={reset}
                disabled={pending}
              >
                取消
              </Button>
            </div>
          </form>
        ) : null}

        {flow.step === 'verify' ? (
          <form
            className='space-y-4 rounded-lg border p-4'
            onSubmit={(event) => {
              event.preventDefault()
              enableMutation.mutate(code)
            }}
          >
            <p className='text-sm font-medium'>扫码绑定验证器</p>
            <div className='flex flex-wrap items-start gap-4'>
              {/* 二维码需要浅底才扫得动，深色模式下也保持白底。 */}
              <div className='rounded-lg bg-white p-3'>
                <QRCodeSVG value={flow.setup.uri} size={160} level='M' />
              </div>
              <div className='min-w-48 flex-1 space-y-2'>
                <Label htmlFor='twofa-secret'>手动输入密钥</Label>
                <Input
                  id='twofa-secret'
                  readOnly
                  className='font-mono text-xs'
                  value={splitGroups(flow.setup.secret)}
                  onFocus={(e) => e.currentTarget.select()}
                />
                <div className='flex flex-wrap gap-2'>
                  <Button
                    type='button'
                    variant='outline'
                    size='sm'
                    onClick={() => void copy(flow.setup.secret, '密钥')}
                  >
                    复制密钥
                  </Button>
                  <Button
                    type='button'
                    variant='ghost'
                    size='sm'
                    onClick={() => void copy(flow.setup.uri, '绑定链接')}
                  >
                    复制 otpauth 链接
                  </Button>
                </div>
                <p className='text-xs text-muted-foreground'>
                  {flow.setup.algorithm} · {flow.setup.digits} 位 ·{' '}
                  {flow.setup.period} 秒
                </p>
              </div>
            </div>
            <Separator />
            <div className='space-y-2'>
              <Label htmlFor='twofa-verify-code'>输入 App 显示的验证码</Label>
              <InputOTP
                id='twofa-verify-code'
                maxLength={6}
                autoFocus
                value={code}
                onChange={setCode}
                onComplete={(value) => enableMutation.mutate(value)}
              >
                <InputOTPGroup>
                  {OTP_SLOTS.map((index) => (
                    <InputOTPSlot key={index} index={index} />
                  ))}
                </InputOTPGroup>
              </InputOTP>
              <p className='text-xs text-muted-foreground'>
                验证通过才会真正开启，中途放弃不影响现在的登录方式。
              </p>
            </div>
            <div className='flex gap-2'>
              <Button type='submit' disabled={pending || code.length < 6}>
                {pending ? '验证中…' : '验证并开启'}
              </Button>
              <Button
                type='button'
                variant='ghost'
                onClick={reset}
                disabled={pending}
              >
                取消
              </Button>
            </div>
          </form>
        ) : null}

        {flow.step === 'codes' ? (
          <div className='space-y-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4'>
            <p className='text-sm font-medium'>保存恢复码</p>
            <p className='text-xs text-muted-foreground'>
              每个恢复码只能用一次，可在丢失验证器时代替验证码登录。
              离开本页后不再显示，请立刻保存到安全的地方。
            </p>
            <ul className='grid grid-cols-2 gap-2 font-mono text-sm'>
              {flow.codes.map((item) => (
                <li
                  key={item}
                  className='rounded-md border bg-background px-2 py-1 text-center tracking-widest'
                >
                  {item}
                </li>
              ))}
            </ul>
            <div className='flex flex-wrap items-center gap-2'>
              <Button
                type='button'
                variant='outline'
                size='sm'
                onClick={() => void copy(flow.codes.join('\n'), '恢复码')}
              >
                复制全部
              </Button>
              <label className='flex items-center gap-2 text-sm'>
                <input
                  type='checkbox'
                  className='size-4 accent-primary'
                  checked={acknowledged}
                  onChange={(e) => setAcknowledged(e.target.checked)}
                />
                我已妥善保存
              </label>
              <Button
                type='button'
                size='sm'
                className='ms-auto'
                disabled={!acknowledged}
                onClick={reset}
              >
                完成
              </Button>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}
