import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { VmProxySnap } from '@/types/panel-vm'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { importErrorMessage } from '@/lib/import-errors'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { StatusMark } from '@/components/status-mark'
import { dashboardQueryOptions } from '@/features/overview/queries'
import {
  proxyBindLimit,
  proxyBoundIds,
  proxyIsInvalid,
  proxyOptionLabel,
  proxyStatusLabel,
  proxyHostText,
  readPositive,
  sortedProxiesByAvailability,
} from '@/features/proxies/proxy-sort'
import { proxiesQueryOptions } from '@/features/proxies/queries'

type ImportResp = {
  added?: number
  skipped?: number
  bound?: { id?: string; bound_vm_id?: string }
  items?: VmProxySnap[]
}

/**
 * 从粘贴文本首行取出 host:port，用来在池里找回「已存在所以没被 import 新建」的那条。
 *
 * 刻意只取 host/port：账密部分解析出来也无处可用，取了反而多一个能泄漏的变量。
 * 对齐 index.html:8065 parseImportSocksHint()。
 */
function parseSocksHint(text: string): { host: string; port: string } | null {
  const line =
    String(text || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find(Boolean) || ''
  if (!line) return null
  try {
    if (/^socks5h?:\/\//i.test(line)) {
      const url = new URL(line)
      return {
        host: url.hostname.replace(/^\[|\]$/g, ''),
        port: url.port || '1080',
      }
    }
    const bracketed = line.match(/^(\[[^\]]+\]):(\d+)/)
    if (bracketed) {
      const url = new URL(`socks5://${bracketed[1]}:${bracketed[2]}`)
      return { host: url.hostname.slice(1, -1), port: url.port }
    }
  } catch {
    return null
  }
  const parts = line.split(':')
  if (parts.length >= 2 && parts[0] && /^\d+$/.test(parts[1])) {
    return { host: parts[0], port: parts[1] }
  }
  return null
}

/**
 * 导入流程第 2 步：给指定槽绑一条 SOCKS5。
 *
 * 两条路都通向「绑到本槽」——下拉选池中现成的，或粘贴新行直接导入并绑定。
 * 对齐 index.html 第 2 步（renderImport 的 import-block 之二）。
 */
export function ImportProxyStep({ vmId }: { vmId: string }) {
  const px = useQuery(proxiesQueryOptions())
  const qc = useQueryClient()
  const pasteRef = useRef<HTMLTextAreaElement>(null)
  const [busy, setBusy] = useState(false)

  const proxies = px.data?.proxies || []
  const tot = (px.data?.totals || {}) as Record<string, unknown>
  const cfg = (px.data?.config || {}) as Record<string, unknown>
  // 回落序对齐 proxies 页：totals 先于 config，见 features/proxies/index.tsx:67。
  const poolLimit = readPositive(
    tot,
    'bind_limit',
    readPositive(cfg, 'bind_limit', 5)
  )
  // 「马上能用的排前面」——健康 → 有余位 → 余位多 → 延迟低。原始顺序是后端
  // 的入库序，直接铺出来会把失效和绑满的混在中间，选起来要靠眼睛筛。
  const options = sortedProxiesByAvailability(proxies, vmId, poolLimit)
  const bound = proxies.find((p) => proxyBoundIds(p).includes(vmId)) || null

  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: proxiesQueryOptions().queryKey }),
      qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
    ])

  const bindOne = useMutation({
    mutationFn: (id: string) =>
      api(`/api/panel/proxies/${encodeURIComponent(id)}/bind`, {
        method: 'POST',
        body: JSON.stringify({ vm_id: vmId }),
      }),
    onSuccess: async () => {
      toast.success('已绑到本槽')
      await refresh()
    },
    onError: (error: Error) => toast.error(importErrorMessage(error)),
  })

  /**
   * 落地粘贴框。返回是否成功绑上——onBlur 与显式按钮共用这一条路径，
   * 保证「粘了但没点按钮就去换票」不会走旧代理（对齐 index 的 ensureImportProxy）。
   */
  async function flushPaste() {
    const el = pasteRef.current
    const text = (el?.value || '').trim()
    if (!text) return true
    if (!vmId) {
      toast.error('请先选择空槽')
      return false
    }
    setBusy(true)
    try {
      const d = await api<ImportResp>('/api/panel/proxies/import', {
        method: 'POST',
        body: JSON.stringify({ text, bind_vm_id: vmId }),
      })
      if (el) el.value = ''
      if (d.bound?.id || d.bound?.bound_vm_id) {
        toast.success('已写入 SOCKS5 并绑到本槽')
        await refresh()
        return true
      }
      // 这条代理池里已经有了，后端不会重复新建，也就没有 bound —— 自己找回来再绑。
      await refresh()
      const hint = parseSocksHint(text)
      const existing =
        d.items?.[0] ||
        (hint
          ? proxies.find(
              (p) => p.host === hint.host && String(p.port) === hint.port
            )
          : undefined)
      if (existing?.id) {
        await api(
          `/api/panel/proxies/${encodeURIComponent(existing.id)}/bind`,
          {
            method: 'POST',
            body: JSON.stringify({ vm_id: vmId }),
          }
        )
        toast.success('该条已在池中，已绑到本槽')
        await refresh()
        return true
      }
      toast.error('未能绑到本槽')
      return false
    } catch (error) {
      toast.error(importErrorMessage(error as Error))
      return false
    } finally {
      setBusy(false)
    }
  }

  const pending = busy || bindOne.isPending

  return (
    <div className='space-y-3'>
      <div className='flex flex-wrap items-center gap-2'>
        <Select
          value={bound?.id || ''}
          onValueChange={(id) => bindOne.mutate(id)}
          disabled={pending || !proxies.length}
        >
          <SelectTrigger
            className='min-w-[220px] flex-1'
            aria-label='选择 SOCKS5'
          >
            <SelectValue
              placeholder={
                proxies.length
                  ? bound
                    ? '已绑定，可改选'
                    : '选择 SOCKS5'
                  : '代理池为空'
              }
            />
          </SelectTrigger>
          <SelectContent>
            {options.map((p) => {
              const here = proxyBoundIds(p).includes(vmId)
              const full =
                !here && proxyBoundIds(p).length >= proxyBindLimit(p, poolLimit)
              const bad = proxyIsInvalid(p)
              return (
                <SelectItem
                  key={p.id}
                  value={p.id || ''}
                  disabled={!here && (full || bad)}
                >
                  {proxyOptionLabel(p, poolLimit)}
                  {full ? ' · 已绑满' : ''}
                </SelectItem>
              )
            })}
          </SelectContent>
        </Select>
        {bound ? (
          <StatusMark
            tone={{
              key: 'proxy',
              text: `${proxyHostText(bound)} · ${proxyStatusLabel(bound)}${
                bound.latency_ms != null ? ` ${bound.latency_ms}ms` : ''
              }`,
              cls: bound.blocked_reason
                ? 'off'
                : proxyIsInvalid(bound)
                  ? 'bad'
                  : 'ok',
            }}
            variant='pill'
          />
        ) : null}
      </div>

      <div className='space-y-2'>
        <Textarea
          ref={pasteRef}
          rows={2}
          aria-label='粘贴 SOCKS5'
          placeholder={'host:port:user:pass\nsocks5://user:pass@host:1080'}
          onBlur={() => void flushPaste()}
        />
        <Button
          size='sm'
          variant='outline'
          disabled={pending}
          loading={pending}
          onClick={() => void flushPaste()}
        >
          导入并绑定
        </Button>
      </div>

      <p className='text-xs text-muted-foreground'>
        账密只入库不回显。换票前会先落地未提交的粘贴，避免还走旧代理。
      </p>
    </div>
  )
}
