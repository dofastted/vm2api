import { useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { Copy, ExternalLink, Keyboard, SquareTerminal } from 'lucide-react'
import { toast } from 'sonner'
import { importErrorMessage } from '@/lib/import-errors'
import { loginAuthCode, type LoginCommit } from '@/lib/login-terminal'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { type LoginTerminalHandle, WsTerminal } from '@/components/ws-terminal'
import { prepareLoginTerminal } from './login-terminal-start'

/** Native CC obtains the grant; the panel importer remains its owner. */
export function ClaudeLogin({
  vm,
  disabled,
  onLogin,
}: {
  vm: Vm
  disabled?: boolean
  onLogin: (result: LoginCommit) => void | Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [cliBin, setCliBin] = useState('')
  const [url, setUrl] = useState('')
  const [callback, setCallback] = useState('')
  const [connected, setConnected] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [committed, setCommitted] = useState(false)
  const terminal = useRef<LoginTerminalHandle>(null)
  const root = `/api/panel/vms/${encodeURIComponent(vm.id)}`
  const start = useMutation({ mutationFn: () => prepareLoginTerminal(vm) })
  const code = loginAuthCode(callback)
  const usableUrl = connected && !committed ? url : ''

  function changeOpen(next: boolean) {
    setOpen(next)
    setCallback('')
    if (next) {
      setCommitted(false)
      resetConnection()
      start.mutate()
    }
  }

  function resetConnection() {
    setConnected(false)
    setCliBin('')
    setUrl('')
    setSubmitted(false)
  }

  function submitCode() {
    if (!usableUrl || !code || submitted || !terminal.current?.paste(code)) {
      return
    }
    setCallback('')
    setSubmitted(true)
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <div className='space-y-2'>
        <p className='text-xs text-muted-foreground'>
          使用随 CRAG 发布的原生 Claude Code 授权，凭证由面板保存和同步。
        </p>
        <DialogTrigger asChild>
          <Button
            type='button'
            size='sm'
            disabled={disabled || start.isPending}
          >
            <SquareTerminal className='size-4' aria-hidden='true' />
            生成授权链接
          </Button>
        </DialogTrigger>
      </div>
      <DialogContent
        className='flex max-h-[calc(100dvh-1rem)] w-[calc(100%-1rem)] min-w-0 flex-col gap-0 overflow-y-auto p-0 sm:max-w-5xl'
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader className='shrink-0 gap-2 border-b px-4 py-4 pe-12 text-start sm:ps-6'>
          <DialogTitle>Claude Code 授权</DialogTitle>
          <DialogDescription className='wrap-anywhere'>
            {vm.name || vm.id}：打开链接完成授权，然后将授权码粘贴回来。
          </DialogDescription>
          {committed ? (
            <p role='status' className='text-sm font-medium text-primary'>
              凭证已保存并同步到槽位，可以关闭此窗口。
            </p>
          ) : null}
        </DialogHeader>
        <div className='grid min-w-0 shrink-0 gap-4 px-4 py-4 sm:px-6 md:grid-cols-2'>
          <div className='min-w-0 space-y-2'>
            <Label htmlFor='native-auth-url'>授权链接</Label>
            <Input
              id='native-auth-url'
              readOnly
              value={usableUrl}
              placeholder={committed ? '授权已完成' : '等待原生 CC 输出链接…'}
              className='h-10 min-w-0 font-mono text-base md:text-sm'
            />
            <div className='flex flex-wrap items-center gap-2'>
              <Button
                type='button'
                size='sm'
                variant='outline'
                disabled={!usableUrl}
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(usableUrl)
                    toast.success('已复制授权链接')
                  } catch {
                    toast.error('复制失败，请选中输入框中的链接手动复制')
                  }
                }}
              >
                <Copy className='size-4' aria-hidden='true' />
                复制链接
              </Button>
              {usableUrl ? (
                <Button asChild size='sm' variant='outline'>
                  <a href={usableUrl} target='_blank' rel='noreferrer'>
                    <ExternalLink className='size-4' aria-hidden='true' />
                    打开授权页
                  </a>
                </Button>
              ) : null}
            </div>
            <p className='text-xs text-muted-foreground'>
              在使用本槽绑定出口的浏览器中打开链接。
            </p>
          </div>
          <form
            className='min-w-0 space-y-2'
            onSubmit={(event) => {
              event.preventDefault()
              submitCode()
            }}
          >
            <Label htmlFor='native-auth-code'>授权码或回调链接</Label>
            <Input
              id='native-auth-code'
              type='password'
              value={callback}
              onChange={(event) => setCallback(event.target.value)}
              placeholder='完整 code#state 或回调链接'
              autoComplete='off'
              spellCheck={false}
              disabled={submitted || committed}
              aria-invalid={!!callback.trim() && !code}
              aria-describedby='native-auth-code-help'
              className='h-10 min-w-0 font-mono text-base md:text-sm'
            />
            <Button
              type='submit'
              size='sm'
              disabled={!usableUrl || !code || submitted}
            >
              {submitted ? '正在等待凭证确认…' : '提交授权码'}
            </Button>
            <p
              id='native-auth-code-help'
              role='status'
              className='text-xs text-muted-foreground'
            >
              {callback.trim() && !code
                ? '需要包含 state 的完整授权码，或 Claude 授权页返回的回调链接。'
                : submitted
                  ? '面板确认保存并同步前，请保持窗口打开。'
                  : '可按 Enter 提交，也可直接在下方终端输入。'}
            </p>
          </form>
        </div>
        <section
          aria-label='原生 Claude Code 交互终端'
          className='flex h-[clamp(14rem,48dvh,34rem)] min-h-0 w-full min-w-0 shrink-0 flex-col border-t bg-[#0b0d10] px-3 py-3 text-zinc-100 sm:px-5'
        >
          <div className='mb-2 flex shrink-0 items-center gap-3 text-sm'>
            <div className='min-w-0 flex-1'>
              <p className='font-mono'>claude auth login</p>
              {cliBin ? (
                <p
                  className='truncate font-mono text-xs text-zinc-400'
                  title={cliBin}
                >
                  {cliBin}
                </p>
              ) : null}
            </div>
            {open && start.isSuccess ? (
              <Button
                type='button'
                variant='ghost'
                className='shrink-0 text-zinc-300 hover:bg-zinc-800 hover:text-white'
                onClick={() => terminal.current?.focus()}
              >
                <Keyboard className='size-4' aria-hidden='true' />
                <span className='sr-only sm:not-sr-only'>聚焦终端</span>
              </Button>
            ) : null}
          </div>
          {start.isError ? (
            <div className='space-y-2'>
              <p role='alert' className='text-sm wrap-anywhere'>
                {importErrorMessage(start.error)}
              </p>
              <Button type='button' size='sm' onClick={() => start.mutate()}>
                重试准备终端
              </Button>
            </div>
          ) : open && start.isSuccess ? (
            <WsTerminal
              ref={terminal}
              ticketPath={`${root}/shell-ticket`}
              socketPath={`${root}/shell`}
              officialLogin
              fontSize={14}
              onCliBin={setCliBin}
              onConnectionChange={(next) => {
                setConnected(next)
                if (!next) setSubmitted(false)
              }}
              canReconnect={!committed}
              onReconnect={resetConnection}
              onAuthUrl={(next) => {
                setUrl(next)
                setSubmitted(false)
              }}
              onLogin={(result) => {
                setSubmitted(false)
                setCommitted(true)
                setCallback('')
                void onLogin(result)
              }}
            />
          ) : (
            <p role='status' className='text-sm text-zinc-300'>
              正在准备登录终端…
            </p>
          )}
        </section>
      </DialogContent>
    </Dialog>
  )
}
