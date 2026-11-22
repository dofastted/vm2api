import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { DOCS_URL } from '@/config/repo'
import { Eye, EyeOff, LogIn, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { Logo } from '@/assets/logo'
import { useAuthStore } from '@/stores/auth-store'
import { ApiError, loginRequest, loginTotpRequest } from '@/lib/api'
import { apiBase, sameOriginPanel, setApiBase } from '@/lib/session'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from '@/components/ui/input-otp'
import { Label } from '@/components/ui/label'
import { ThemeSwitch } from '@/components/theme-switch'
import { onboardingQueryOptions } from '@/features/welcome/queries'
import { meQueryOptions } from './queries'
import { resolveSignInDestination } from './sign-in-destination'

const OTP_SLOTS = [0, 1, 2, 3, 4, 5]

/** Standalone sign-in page. */
export function LoginPage() {
  const search = useSearch({ from: '/login' })
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const signIn = useAuthStore((s) => s.signIn)
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [base, setBase] = useState(apiBase())
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  // 两步验证：密码通过后留在本页输验证码，密码不再重发。
  const [challenge, setChallenge] = useState('')
  const [code, setCode] = useState('')
  const [recoveryMode, setRecoveryMode] = useState(false)
  const hideBase = sameOriginPanel()
  const needsCode = !!challenge

  async function completeSignIn(result: { token: string; user: string }) {
    signIn(result.token, result.user)
    // The route guard reads this cache; drop the previous account's views.
    queryClient.removeQueries({ queryKey: meQueryOptions().queryKey })
    // Before anything is awaited: a deep link navigates away right below, so the toast has to come first.
    toast.success('登录成功')
    // A usable `redirect` wins over the welcome guide, so it never waits for the onboarding request.
    const destination = await resolveSignInDestination(
      search.redirect,
      async () => {
        try {
          const onboarding = await queryClient.fetchQuery(
            onboardingQueryOptions(true)
          )
          return Boolean(onboarding.needs_welcome)
        } catch {
          return false
        }
      }
    )
    if (destination.kind === 'redirect') {
      await navigate({ href: destination.href })
      return
    }
    if (destination.kind === 'welcome') {
      await navigate({ to: '/welcome', search: { setup: true } })
      return
    }
    await navigate({ to: '/overview' })
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError('')
    setPending(true)
    try {
      if (hideBase) setApiBase('')
      else setApiBase(base)
      const result = await loginRequest({
        username: username.trim(),
        password,
        base: hideBase ? '' : base.trim().replace(/\/$/, '') || apiBase(),
      })
      if (result.kind === 'totp') {
        setChallenge(result.challenge)
        setCode('')
        setRecoveryMode(false)
        return
      }
      await completeSignIn(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败')
    } finally {
      setPending(false)
    }
  }

  async function submitCode(value: string) {
    const entered = value.trim()
    if (!entered || pending) return
    setError('')
    setPending(true)
    try {
      await completeSignIn(
        await loginTotpRequest({
          challenge,
          code: entered,
          username: username.trim(),
        })
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : '验证失败')
      setCode('')
      // A spent or expired challenge can never succeed: go back to the
      // password step instead of leaving the user typing into a dead one.
      if (
        err instanceof ApiError &&
        (err.code === 'totp_challenge_expired' ||
          err.code === 'totp_challenge_invalid')
      ) {
        setChallenge('')
        setRecoveryMode(false)
      }
    } finally {
      setPending(false)
    }
  }

  function backToPassword() {
    setChallenge('')
    setCode('')
    setRecoveryMode(false)
    setError('')
  }

  return (
    <div className='welcome-theme relative flex min-h-svh flex-col overflow-hidden bg-background text-foreground'>
      <div
        aria-hidden
        className='pointer-events-none absolute inset-0 opacity-20 dark:opacity-[0.08]'
        style={{
          background: [
            'radial-gradient(ellipse 50% 45% at 30% 30%, oklch(0.72 0.18 250 / 70%) 0%, transparent 70%)',
            'radial-gradient(ellipse 40% 40% at 75% 70%, oklch(0.70 0.12 280 / 50%) 0%, transparent 70%)',
          ].join(', '),
        }}
      />

      <header className='relative flex h-16 items-center justify-between px-6'>
        <Link
          to='/welcome'
          className='group flex items-center gap-2.5 rounded-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
        >
          <span className='grid size-7 place-items-center rounded-lg bg-foreground text-background transition-transform duration-300 group-hover:scale-105'>
            <Logo aria-hidden className='size-4' />
          </span>
          <span className='text-sm font-semibold tracking-tight'>vm2api</span>
        </Link>
        <ThemeSwitch />
      </header>

      <main className='relative flex flex-1 items-center justify-center px-6 pb-20'>
        <div className='welcome-fade-up w-full max-w-[22rem]'>
          <h1 className='text-xl font-semibold tracking-tight'>
            {needsCode ? '两步验证' : '登录控制台'}
          </h1>
          {needsCode ? (
            <p className='mt-2 text-sm text-muted-foreground'>
              密码已通过，再输入{' '}
              <span className='font-medium'>{username.trim() || '该账号'}</span>{' '}
              的验证码。
            </p>
          ) : (
            <>
              <p className='mt-2 text-sm text-muted-foreground'>
                第一次使用？看
                <a
                  href={`${DOCS_URL}guide/install`}
                  target='_blank'
                  rel='noreferrer'
                  className='text-foreground underline underline-offset-4'
                >
                  安装文档
                </a>
                ，或回到
                <Link
                  to='/welcome'
                  className='text-foreground underline underline-offset-4'
                >
                  欢迎页
                </Link>
                。
              </p>
              <Link
                to='/crag-purchase'
                className='mt-3 inline-block text-sm underline underline-offset-4'
              >
                免登录购买 CRAG 订阅
              </Link>
            </>
          )}

          {needsCode ? (
            <form
              className='mt-8 space-y-4'
              onSubmit={(event) => {
                event.preventDefault()
                void submitCode(code)
              }}
            >
              <div className='space-y-2'>
                <Label htmlFor='login-totp'>
                  {recoveryMode ? '恢复码' : '验证器验证码'}
                </Label>
                {recoveryMode ? (
                  <>
                    <Input
                      id='login-totp'
                      className='h-10 rounded-lg font-mono tracking-widest'
                      autoComplete='one-time-code'
                      placeholder='XXXXX-XXXXX'
                      autoFocus
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                    />
                    <p className='text-xs text-muted-foreground'>
                      输入绑定时保存的一次性恢复码，用掉后即失效。
                    </p>
                  </>
                ) : (
                  <>
                    <InputOTP
                      id='login-totp'
                      maxLength={6}
                      autoFocus
                      value={code}
                      onChange={setCode}
                      onComplete={(value) => void submitCode(value)}
                    >
                      <InputOTPGroup>
                        {OTP_SLOTS.map((index) => (
                          <InputOTPSlot key={index} index={index} />
                        ))}
                      </InputOTPGroup>
                    </InputOTP>
                    <p className='text-xs text-muted-foreground'>
                      打开验证器 App，输入当前的 6 位数字。
                    </p>
                  </>
                )}
              </div>
              {error ? (
                <p className='text-sm text-destructive' role='alert'>
                  {error}
                </p>
              ) : null}
              <Button
                className='mt-2 h-10 w-full rounded-lg font-medium'
                type='submit'
                disabled={pending || (!recoveryMode && code.length < 6)}
              >
                <ShieldCheck aria-hidden className='size-4' />
                {pending ? '验证中…' : '验证并登录'}
              </Button>
              <div className='flex items-center justify-between text-sm'>
                <button
                  type='button'
                  className='underline underline-offset-4'
                  onClick={() => {
                    setRecoveryMode((v) => !v)
                    setCode('')
                    setError('')
                  }}
                >
                  {recoveryMode ? '用验证器验证码' : '丢了手机？用恢复码'}
                </button>
                <button
                  type='button'
                  className='text-muted-foreground underline underline-offset-4'
                  onClick={backToPassword}
                >
                  返回
                </button>
              </div>
            </form>
          ) : (
            <form className='mt-8 space-y-4' onSubmit={onSubmit}>
              <div className='space-y-2'>
                <Label htmlFor='login-username'>用户名</Label>
                <Input
                  id='login-username'
                  className='h-10 rounded-lg'
                  autoComplete='username'
                  placeholder='输入面板用户名'
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                />
              </div>
              <div className='space-y-2'>
                <Label htmlFor='login-password'>密码</Label>
                <div className='relative'>
                  <Input
                    id='login-password'
                    type={showPassword ? 'text' : 'password'}
                    className='h-10 rounded-lg pe-10'
                    autoComplete='current-password'
                    placeholder='输入密码'
                    autoFocus
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  <button
                    type='button'
                    aria-label={showPassword ? '隐藏密码' : '显示密码'}
                    onClick={() => setShowPassword((v) => !v)}
                    className='absolute inset-y-0 end-0 flex w-10 items-center justify-center rounded-e-lg text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
                  >
                    {showPassword ? (
                      <EyeOff aria-hidden className='size-4' />
                    ) : (
                      <Eye aria-hidden className='size-4' />
                    )}
                  </button>
                </div>
              </div>
              {hideBase ? null : (
                <div className='space-y-2'>
                  <Label htmlFor='login-api-base'>API Base</Label>
                  <Input
                    id='login-api-base'
                    placeholder='http://127.0.0.1:8787'
                    className='h-10 rounded-lg'
                    value={base}
                    onChange={(e) => setBase(e.target.value)}
                  />
                </div>
              )}
              {error ? (
                <p className='text-sm text-destructive' role='alert'>
                  {error}
                </p>
              ) : null}
              <Button
                className='mt-2 h-10 w-full rounded-lg font-medium'
                type='submit'
                disabled={pending}
              >
                <LogIn aria-hidden className='size-4' />
                {pending ? '登录中…' : '登录'}
              </Button>
            </form>
          )}
        </div>
      </main>
    </div>
  )
}
