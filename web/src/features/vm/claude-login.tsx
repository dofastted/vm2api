import { useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { Copy, ExternalLink, Keyboard, SquareTerminal } from 'lucide-react'
import { toast } from 'sonner'
import { importErrorMessage } from '@/lib/import-errors'
import { loginAuthCode } from '@/lib/login-terminal'
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
import { prepareLoginTerminal } from './login-terminal-start'

/** Native CC obtains the grant; the existing panel importer remains its owner. */
export function ClaudeLogin({
  vm,
  disabled,
  onLogin,
}: {
  vm: Vm
  disabled?: boolean
  onLogin: () => void
}) {
  const [source, setSource] = useState('bundled')
  const [path, setPath] = useState('')
  const [sessionPath, setSessionPath] = useState('')
  const [resolvedPath, setResolvedPath] = useState('')
  const [open, setOpen] = useState(false)
  const [url, setUrl] = useState('')
  const [code, setCode] = useState('')
  const [connected, setConnected] = useState(false)
  const [imported, setImported] = useState(false)
  const terminal = useRef<LoginTerminalHandle>(null)
  const custom = source === 'custom'
  const validPath =
    !custom ||
    (path.trim().startsWith('/') &&
      !/[\x00-\x1f\x7f]/.test(path) &&
      !path.trim().endsWith('/'))
  const start = useMutation({
    mutationFn: () => prepareLoginTerminal(vm),
    onSuccess: () => {
      setSessionPath(custom ? path.trim() : '')
      setResolvedPath('')
      setUrl('')
      setCode('')
      setImported(false)
      setConnected(false)
      setOpen(true)
    },
    onError: (error: Error) => toast.error(importErrorMessage(error)),
  })
  function submitCode() {
    const value = loginAuthCode(code)
    if (value && terminal.current?.paste(value)) setCode('')
  }
  return (
    <div className='space-y-4'>
      <div className='grid gap-3 sm:grid-cols-[220px_minmax(0,1fr)]'>
        <div className='space-y-2'>
          <Label htmlFor='login-cc-source'>认证调用方</Label>
          <Select
            value={source}
            onValueChange={setSource}
            disabled={disabled || start.isPending}
          >
            <SelectTrigger id='login-cc-source' className='h-11 w-full'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='bundled'>CRAG 包内原生 CC</SelectItem>
              <SelectItem value='custom'>指定原生 CC 路径</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className='space-y-2'>
          <Label htmlFor='login-cc-path'>
            {custom ? '槽内可执行文件路径' : '程序来源'}
          </Label>
          {custom ? (
            <Input
              id='login-cc-path'
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder='/absolute/path/to/claude'
              autoComplete='off'
              spellCheck={false}
              disabled={disabled || start.isPending}
              aria-invalid={!!path && !validPath}
              className='h-11 font-mono text-sm'
            />
          ) : (
            <p
              id='login-cc-path'
              className='flex min-h-11 items-center text-sm text-muted-foreground'
            >
              使用随 CRAG 发布的官方 Claude Code，不跟随推理内核。
            </p>
          )}
        </div>
      </div>
      <div className='flex flex-wrap items-center gap-3'>
        <Button
          disabled={disabled || start.isPending || !validPath}
          loading={start.isPending}
          onClick={() => start.mutate()}
          className='min-h-11'
        >
          <SquareTerminal className='size-4' aria-hidden='true' />
          {start.isPending ? '正在准备终端…' : '打开原生 CC 登录终端'}
        </Button>
        <p className='text-sm text-muted-foreground'>
          路径位于槽内；凭证仍由面板保存、同步与刷新。
        </p>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className='flex h-[calc(100svh-1rem)] w-[calc(100vw-1rem)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:h-[calc(100svh-2rem)] sm:w-[calc(100vw-2rem)] sm:max-w-none'>
          <DialogHeader className='shrink-0 gap-1 border-b px-4 py-4 pr-12 text-left sm:px-6 sm:pr-12'>
            <div className='flex flex-wrap items-center gap-x-3 gap-y-1'>
              <DialogTitle className='text-lg'>Claude Code 授权</DialogTitle>
              <span className='text-sm text-muted-foreground'>
                {vm.name || vm.id}
              </span>
              {imported ? (
                <span
                  role='status'
                  className='text-sm font-medium text-primary'
                >
                  凭证已保存到面板
                </span>
              ) : null}
            </div>
            <DialogDescription>
              在原生 CC 中完成登录。授权成功后，面板自动导入本槽凭证。
            </DialogDescription>
          </DialogHeader>
          <div className='grid min-h-0 min-w-0 flex-1 grid-cols-1 grid-rows-[minmax(300px,1fr)_auto] overflow-y-auto'>
            <section
              aria-label='原生 Claude Code 交互终端'
              className='flex min-h-0 min-w-0 flex-col bg-[#0b0d10] px-3 py-3 text-zinc-100 sm:px-5'
            >
              <div className='mb-2 flex shrink-0 items-center gap-3 text-sm'>
                <div className='min-w-0 flex-1'>
                  <p className='font-mono'>claude auth login</p>
                  <p
                    className='truncate font-mono text-xs text-zinc-400'
                    title={resolvedPath}
                  >
                    {resolvedPath ||
                      sessionPath ||
                      '正在解析 CRAG 包内原生 CC…'}
                  </p>
                </div>
                <Button
                  type='button'
                  variant='ghost'
                  className='h-11 shrink-0 text-zinc-300 hover:bg-zinc-800 hover:text-white'
                  onClick={() => terminal.current?.focus()}
                >
                  <Keyboard className='size-4' aria-hidden='true' />
                  <span className='hidden sm:inline'>聚焦终端</span>
                  <span className='sr-only sm:hidden'>聚焦终端</span>
                </Button>
              </div>
              {open ? (
                <WsTerminal
                  ref={terminal}
                  ticketPath={`/api/panel/vms/${encodeURIComponent(vm.id)}/shell-ticket`}
                  socketPath={`/api/panel/vms/${encodeURIComponent(vm.id)}/shell`}
                  officialLogin
                  loginCliBin={sessionPath}
                  onCliBin={setResolvedPath}
                  onConnectionChange={setConnected}
                  fontSize={16}
                  onAuthUrl={setUrl}
                  onLogin={() => {
                    setImported(true)
                    onLogin()
                    toast.success('原生 CC 登录凭证已保存到面板')
                  }}
                />
              ) : null}
            </section>
            <div className='grid min-w-0 shrink-0 grid-cols-1 gap-5 border-t bg-background px-4 py-4 sm:px-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]'>
              <div className='min-w-0 space-y-2'>
                <Label htmlFor='native-auth-url'>授权链接</Label>
                <div className='flex gap-2'>
                  <Input
                    id='native-auth-url'
                    readOnly
                    value={url}
                    placeholder='等待原生 CC 输出授权链接…'
                    className='h-11 min-w-0 font-mono text-sm'
                  />
                  <Button
                    type='button'
                    variant='outline'
                    disabled={!url}
                    className='h-11 shrink-0'
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(url)
                        toast.success('已复制授权链接')
                      } catch {
                        toast.error('复制失败，请在输入框中选中并复制链接')
                      }
                    }}
                  >
                    <Copy className='size-4' aria-hidden='true' />
                    复制
                  </Button>
                </div>
                {url ? (
                  <a
                    className='inline-flex min-h-8 items-center gap-1.5 text-sm text-primary underline underline-offset-4'
                    href={url}
                    target='_blank'
                    rel='noreferrer'
                  >
                    打开授权页
                    <ExternalLink className='size-3.5' aria-hidden='true' />
                  </a>
                ) : (
                  <p className='text-sm text-muted-foreground'>
                    浏览器须使用本槽绑定的出口。
                  </p>
                )}
              </div>
              <div className='min-w-0 space-y-2'>
                <Label htmlFor='native-auth-code'>
                  授权码{' '}
                  <span className='font-normal text-muted-foreground'>
                    包含 # 后的 state
                  </span>
                </Label>
                <div className='flex items-start gap-2'>
                  <Textarea
                    id='native-auth-code'
                    rows={2}
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                    onKeyDown={(event) => {
                      if (
                        (event.ctrlKey || event.metaKey) &&
                        event.key === 'Enter'
                      ) {
                        event.preventDefault()
                        submitCode()
                      }
                    }}
                    placeholder='粘贴完整 code#state'
                    autoComplete='off'
                    spellCheck={false}
                    className='min-h-11 resize-none font-mono text-sm'
                  />
                  <Button
                    type='button'
                    className='h-11 shrink-0'
                    disabled={!connected || !loginAuthCode(code)}
                    onClick={submitCode}
                  >
                    提交授权码
                  </Button>
                </div>
                <p className='text-sm text-muted-foreground'>
                  {connected
                    ? 'Ctrl / ⌘ + Enter 提交，也可直接在终端输入。'
                    : '终端连接后可提交；未发送的授权码会保留。'}
                </p>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
