import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { VmProxySnap } from '@/types/panel-vm'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
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
import { dashboardQueryOptions } from '@/features/overview/queries'
import { proxiesQueryOptions } from '@/features/proxies/queries'
import { type ProxyEditResult, editOutcome } from './proxy-results'
import { proxyBoundIds } from './proxy-sort'

/** 与网关 PROXY_LABEL_MAX 一致。 */
const PROXY_LABEL_MAX = 64

type EditResult = ProxyEditResult & { proxy?: VmProxySnap }

/**
 * 编辑单条代理。账密**不预填** —— 后端不返回账密（只给 has_auth 布尔），
 * 所以留空的语义是「不修改」，与网关 `PUT /proxies/:id` 的按键存在性判定一致。
 */
export function ProxyEditDialog({
  proxy,
  onOpenChange,
}: {
  /** null 时关闭。传入即打开并以该条为编辑目标。 */
  proxy: VmProxySnap | null
  onOpenChange: (open: boolean) => void
}) {
  const qc = useQueryClient()
  const [scheme, setScheme] = useState('socks5')
  const [host, setHost] = useState('')
  const [port, setPort] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [clearAuth, setClearAuth] = useState(false)
  const [label, setLabel] = useState('')
  const [domainForward, setDomainForward] = useState(false)

  const boundCount = proxyBoundIds(proxy || undefined).length
  // 代理名称只影响显示：只改名称时网关不会重载已绑槽位的 worker。
  const labelChanged = label.trim() !== String(proxy?.label || '')
  const localProxy = proxy?.kind === 'local' || proxy?.scheme === 'local'

  // 按 id 重置，而不是按对象身份。代理页每次 refetch 都会产出新的 proxy 对象，
  // 若依赖对象引用，编辑期间的一次后台刷新就会把用户正在输入的账密清空。
  const proxyId = proxy?.id || ''
  useEffect(() => {
    if (!proxyId) return
    setScheme(
      proxy?.scheme === 'socks5h' ? 'socks5' : proxy?.scheme || 'socks5'
    )
    setHost(String(proxy?.host || ''))
    setPort(String(proxy?.port || ''))
    setUsername('')
    setPassword('')
    setClearAuth(false)
    setLabel(String(proxy?.label || ''))
    setDomainForward(proxy?.domain_forward === true)
    // proxy 的其余字段刻意不入依赖：只有换了目标才该重置表单。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proxyId])

  const save = useMutation({
    mutationFn: () => {
      // 只发真正改动的键：网关按「键是否存在」区分「不动」与「清空」，
      // 无脑全量提交会把留空的账密框当成清除指令。
      const patch: Record<string, unknown> = {}
      if (
        !localProxy &&
        scheme !==
          (proxy?.scheme === 'socks5h' ? 'socks5' : proxy?.scheme || 'socks5')
      )
        patch.scheme = scheme
      if (host.trim() && host.trim() !== proxy?.host) patch.host = host.trim()
      if (port.trim() && port.trim() !== String(proxy?.port ?? '')) {
        patch.port = Number(port.trim())
      }
      if (clearAuth) {
        patch.username = ''
      } else {
        if (username.trim()) patch.username = username.trim()
        if (password) patch.password = password
      }
      if (labelChanged) patch.label = label.trim()
      if (!localProxy && domainForward !== (proxy?.domain_forward === true)) {
        patch.domain_forward = domainForward
      }
      return api<EditResult>(
        `/api/panel/proxies/${encodeURIComponent(String(proxy?.id || ''))}`,
        { method: 'PUT', body: JSON.stringify(patch) }
      )
    },
    onSuccess: async (data) => {
      // 池已经改了，只是部分槽位或出口转发没跟上 —— 说清楚而不是笼统报成功。
      const out = editOutcome(data)
      toast[out.level](out.text)
      onOpenChange(false)
      await Promise.all([
        qc.invalidateQueries({ queryKey: proxiesQueryOptions().queryKey }),
        qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
      ])
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const portNum = Number(port.trim())
  // 空值也算不合法：清空输入框并不表示「删除端口」，而且清空后 patch 里既不
  // 会带 host/port 也不带账密，提交出去只会换回一个 no_editable_fields 400。
  const portBad =
    !port.trim() || !Number.isInteger(portNum) || portNum < 1 || portNum > 65535
  const hostBad = !host.trim()
  // SOCKS5 没有「只有密码」的认证方式，后端 socks5Record() 见用户名为空就把
  // 密码一并丢掉。原本无账密的代理若只填密码，网关会以
  // password_without_username 拒掉 —— 在这里先拦住，别让用户白填一遍。
  const passwordWithoutUser =
    !clearAuth && !!password && !username.trim() && !proxy?.has_auth
  const connectionChanged =
    !localProxy &&
    !(
      scheme ===
        (proxy?.scheme === 'socks5h' ? 'socks5' : proxy?.scheme || 'socks5') &&
      host.trim() === String(proxy?.host || '') &&
      port.trim() === String(proxy?.port ?? '') &&
      !username.trim() &&
      !password &&
      !clearAuth
    )
  const domainChanged =
    !localProxy && domainForward !== (proxy?.domain_forward === true)
  const nothingChanged = !connectionChanged && !labelChanged && !domainChanged

  return (
    <Dialog open={!!proxy} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>编辑代理</DialogTitle>
        </DialogHeader>
        <div className='space-y-3'>
          <div className='space-y-1'>
            <Label>代理名称</Label>
            <Input
              value={label}
              maxLength={PROXY_LABEL_MAX}
              onChange={(e) => setLabel(e.target.value)}
              placeholder='如：东京-2 号机、xx 机房'
            />
          </div>
          {!localProxy && (
            <div className='space-y-1'>
              <Label htmlFor='proxy-scheme'>代理类型</Label>
              <Select value={scheme} onValueChange={setScheme}>
                <SelectTrigger id='proxy-scheme'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='socks5'>SOCKS5</SelectItem>
                  <SelectItem value='http'>HTTP</SelectItem>
                  <SelectItem value='https'>HTTPS</SelectItem>
                </SelectContent>
              </Select>
              {scheme !== 'socks5' && (
                <p className='text-xs text-muted-foreground'>
                  需要支持 CONNECT 隧道。HTTPS
                  类型会加密到代理服务器的连接并验证证书。
                </p>
              )}
            </div>
          )}
          <div className='grid gap-3 sm:grid-cols-[2fr_1fr]'>
            <div className='space-y-1'>
              <Label>主机</Label>
              <Input
                value={host}
                onChange={(e) => setHost(e.target.value)}
                aria-invalid={hostBad}
              />
            </div>
            <div className='space-y-1'>
              <Label>端口</Label>
              <Input
                value={port}
                inputMode='numeric'
                onChange={(e) => setPort(e.target.value)}
                aria-invalid={portBad}
              />
            </div>
          </div>
          {hostBad ? (
            <p className='text-xs text-[color:var(--status-bad)]'>
              主机不能为空。
            </p>
          ) : null}
          {portBad ? (
            <p className='text-xs text-[color:var(--status-bad)]'>
              端口需在 1–65535 之间。
            </p>
          ) : null}

          <div className='space-y-1'>
            <Label>用户名</Label>
            <Input
              value={username}
              disabled={clearAuth}
              onChange={(e) => setUsername(e.target.value)}
              placeholder={proxy?.has_auth ? '留空则不修改' : '（当前无账密）'}
            />
          </div>
          <div className='space-y-1'>
            <Label>密码</Label>
            <Input
              type='password'
              value={password}
              disabled={clearAuth}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={proxy?.has_auth ? '留空则不修改' : '（当前无账密）'}
            />
          </div>
          {proxy?.has_auth ? (
            <label className='flex items-center gap-2 text-sm'>
              <input
                type='checkbox'
                checked={clearAuth}
                onChange={(e) => {
                  setClearAuth(e.target.checked)
                  // 勾上就把两个框清空：留着已输入的账密既不会提交（patch 只发
                  // username: ''），取消勾选后又会突然复活，看着像输入被吞了。
                  if (e.target.checked) {
                    setUsername('')
                    setPassword('')
                  }
                }}
              />
              清除账密（改为免认证）
            </label>
          ) : null}

          <p className='text-xs text-muted-foreground'>
            账密不会回显。留空表示保持原值。
          </p>
          {localProxy ? null : (
            <label className='flex items-center gap-2 text-sm'>
              <input
                type='checkbox'
                checked={domainForward}
                onChange={(e) => setDomainForward(e.target.checked)}
              />
              域名转发（IPv6-only 出口按主机名 CONNECT，不回落 IPv4）
            </label>
          )}
          {passwordWithoutUser ? (
            <p className='text-xs text-[color:var(--status-bad)]'>
              只填密码不生效，请同时填写用户名。
            </p>
          ) : null}
          {boundCount && connectionChanged ? (
            <p className='text-xs text-[color:var(--status-caution)]'>
              保存后将自动更新已绑定的 {boundCount}{' '}
              台槽位，现有连接可能短暂中断。
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant='outline' onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            onClick={() => save.mutate()}
            disabled={
              save.isPending ||
              hostBad ||
              portBad ||
              nothingChanged ||
              passwordWithoutUser
            }
            loading={save.isPending}
          >
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
