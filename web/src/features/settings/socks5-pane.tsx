import { useMutation, useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { SettingRow } from '@/components/setting-row'
import {
  proxiesQueryOptions,
  useRefreshProxies,
} from '@/features/proxies/queries'

export function Socks5Pane() {
  const pool = useQuery(proxiesQueryOptions())
  const refresh = useRefreshProxies()
  const ipv6 = useMutation({
    mutationFn: (enabled: boolean) =>
      api<{
        egress?: {
          ok: boolean
          proxy_id: string
          vm_id?: string
          error?: string
        }[]
      }>('/api/panel/proxies/config', {
        method: 'PUT',
        body: JSON.stringify({ ipv6_enabled: enabled }),
      }),
    onSuccess: async (data, enabled) => {
      const failed = (data.egress || []).filter((exit) => !exit.ok)
      if (failed.length) {
        toast.warning(
          `IPv6 设置已保存，${failed.length} 个出口未同步：${failed.map((exit) => exit.vm_id || exit.proxy_id).join('、')}。恢复节点连接后重试。`
        )
      } else {
        toast.success(
          enabled
            ? 'IPv6 代理出口已开启'
            : 'IPv6 代理出口已关闭，现有连接已断开'
        )
      }
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const enabled = ipv6.isPending
    ? ipv6.variables
    : pool.data?.config?.ipv6_enabled === true
  return (
    <div className='space-y-3'>
      <p className='text-sm text-muted-foreground'>
        名单、绑定、导入在「代理池」。这里只写网关合同。每槽必须绑一条出口；一条默认最多
        5 台。
      </p>
      <Card>
        <CardHeader>
          <CardTitle>IPv6 代理出口</CardTitle>
        </CardHeader>
        <CardContent>
          <SettingRow
            label='启用 IPv6'
            desc='默认关闭。开启后允许探测、绑定和使用 IPv6 地址的 SOCKS5 代理；关闭会断开对应出口的现有连接，但保留槽位、绑定和探测历史。槽位网桥仍为 IPv4，DNS 和路由策略不变。'
          >
            <Switch
              checked={enabled}
              disabled={!pool.data || ipv6.isPending}
              onCheckedChange={(checked) => ipv6.mutate(checked)}
              aria-label='启用 IPv6 代理出口'
            />
          </SettingRow>
          {pool.error ? (
            <p role='alert' className='text-sm text-red-3'>
              {pool.error.message}
            </p>
          ) : null}
          <p className='mt-3 text-sm text-muted-foreground'>
            IPv6 地址请使用 <code>[2001:db8::1]:1080</code> 或完整 SOCKS5
            URL。代理池和槽位网络状态会区分“IPv6 已关闭”与探测失败。
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>远程 SOCKS5</CardTitle>
        </CardHeader>
        <CardContent className='space-y-2 text-sm text-muted-foreground'>
          <p>
            一条 SOCKS5 起一台透明网关。egress
            是虚拟机的默认路由。槽内只推理，不 Dial SOCKS、不设 HTTPS_PROXY。
          </p>
          <p>
            住宅 NAT 大约 15 分钟掐空闲 TCP。网关 7 分钟无字节拆两边，并开 15s
            keepalive。
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>本地出口</CardTitle>
        </CardHeader>
        <CardContent className='space-y-2 text-sm text-muted-foreground'>
          <p>
            代理池可添加「本地出口」。槽走宿主机默认路由出网，不经远程
            SOCKS5，也不启 kin-egress。适合本机调试或宿主机本身就是出口。
          </p>
          <p>探测只看本机 Docker 网是否在。绑定方式与 SOCKS5 相同。</p>
        </CardContent>
      </Card>
    </div>
  )
}
