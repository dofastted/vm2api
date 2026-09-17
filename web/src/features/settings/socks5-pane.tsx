import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

export function Socks5Pane() {
  return (
    <div className='space-y-3'>
      <p className='text-sm text-muted-foreground'>
        名单、绑定、导入在「代理池」。这里只写网关合同。每槽必须绑一条出口；一条默认最多
        5 台。
      </p>
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
