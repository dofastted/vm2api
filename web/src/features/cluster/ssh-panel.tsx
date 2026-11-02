import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ClusterApiNode } from '@/types/panel-cluster'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { StatusMark } from '@/components/status-mark'
import { WsTerminal } from '@/components/ws-terminal'
import { DirectLinkConfig } from '@/features/cluster/direct-link-config'
import { DockerTab } from '@/features/cluster/docker-tab'
import { LINK_STATE_TEXT, remoteLinkTone } from '@/features/cluster/model'
import { NodeConfig } from '@/features/cluster/node-config'
import { CLUSTER_NODES_KEY } from '@/features/cluster/queries'

export type SshPanelTab = 'terminal' | 'docker' | 'link'

/** 弹出式节点面板：终端 / Docker / 连接。`node` 跟着节点列表轮询刷新；`tab` 是打开时停在哪一页。 */
export function SshPanel({
  node,
  nodes,
  vmCount,
  tab,
  onOpenChange,
}: {
  node: ClusterApiNode | null
  nodes: ClusterApiNode[]
  vmCount: number | null
  tab?: SshPanelTab
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={!!node} onOpenChange={onOpenChange}>
      <DialogContent className='flex h-[86vh] flex-col gap-3 sm:max-w-5xl'>
        {node ? (
          <PanelBody
            key={`${node.id}:${tab || ''}`}
            node={node}
            nodes={nodes}
            vmCount={vmCount}
            tab={tab}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function PanelBody({
  node,
  nodes,
  vmCount,
  tab,
}: {
  node: ClusterApiNode
  nodes: ClusterApiNode[]
  vmCount: number | null
  tab?: SshPanelTab
}) {
  const ready = node.link.state === 'ready'
  const initial: SshPanelTab =
    tab === 'terminal' && !ready ? 'link' : tab || (ready ? 'terminal' : 'link')
  return (
    <>
      <DialogHeader>
        <DialogTitle className='flex items-center gap-2'>
          <span className='min-w-0 truncate' title={node.label}>
            {node.label}
          </span>
          <StatusMark tone={remoteLinkTone(node)} variant='pill' />
        </DialogTitle>
        <DialogDescription className='font-mono text-xs'>
          {node.username}@{node.host}:{node.port}
        </DialogDescription>
      </DialogHeader>
      <Tabs defaultValue={initial} className='min-h-0 flex-1'>
        <TabsList>
          <TabsTrigger value='terminal' disabled={!ready}>
            终端
          </TabsTrigger>
          <TabsTrigger value='docker'>Docker</TabsTrigger>
          <TabsTrigger value='link'>连接</TabsTrigger>
        </TabsList>
        <TabsContent value='terminal' className='min-h-0 flex-1'>
          {ready ? (
            <WsTerminal
              ticketPath={`/api/panel/cluster/nodes/${node.id}/shell-ticket`}
              socketPath={`/api/panel/cluster/nodes/${node.id}/shell`}
            />
          ) : null}
        </TabsContent>
        <TabsContent value='docker' className='min-h-0 flex-1 overflow-auto'>
          <DockerTab node={node} />
        </TabsContent>
        <TabsContent value='link' className='min-h-0 flex-1 overflow-auto'>
          <LinkTab node={node} nodes={nodes} vmCount={vmCount} />
        </TabsContent>
      </Tabs>
    </>
  )
}

function LinkTab({
  node,
  nodes,
  vmCount,
}: {
  node: ClusterApiNode
  nodes: ClusterApiNode[]
  vmCount: number | null
}) {
  const qc = useQueryClient()
  const reconnect = useMutation({
    mutationFn: () =>
      api(`/api/panel/cluster/nodes/${node.id}/reconnect`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: CLUSTER_NODES_KEY }),
    onError: (err) => toast.error(err.message),
  })
  const jump = node.jump_node_id
    ? nodes.find((n) => n.id === node.jump_node_id)
    : null
  const bridge = node.bridge
  const rows: [string, string][] = [
    ['状态', LINK_STATE_TEXT[node.link.state] || node.link.state],
    [
      '延迟',
      node.link.state === 'ready' && node.health?.latency_ms != null
        ? `${node.health.latency_ms} ms（SSH 通道往返）`
        : '—',
    ],
    ['连接于', node.link.connected_at || '—'],
    ['下次重试', node.link.next_retry_at || '—'],
    ['经由', jump ? `${jump.label} · ${jump.host}` : '直连'],
    ['认证', node.auth_type === 'key' ? '私钥' : '密码'],
    ['固定指纹', `${node.host_key_alg} ${node.host_key_sha256}`],
    node.platform === 'darwin'
      ? ['运行方式', 'macOS 原生（槽位是 launchd 服务，不用 Docker）']
      : [
          'Docker',
          node.health
            ? node.health.docker.ok
              ? '可用'
              : node.health.docker.error || '不可用'
            : '—',
        ],
  ]

  return (
    <div className='space-y-4 text-sm'>
      {node.link.error ? (
        <div className='rounded-md border border-red-3/40 bg-red-3/5 p-2 text-xs'>
          {node.link.error.code} · {node.link.error.message}
        </div>
      ) : null}
      <dl className='grid grid-cols-[88px_1fr] gap-x-3 gap-y-1.5 text-xs'>
        {rows.map(([k, v]) => (
          <div key={k} className='contents'>
            <dt className='text-muted-foreground'>{k}</dt>
            <dd className='font-mono break-all'>{v}</dd>
          </div>
        ))}
      </dl>
      <Button
        size='sm'
        variant='outline'
        disabled={reconnect.isPending}
        onClick={() => reconnect.mutate()}
      >
        立即重连
      </Button>

      <NodeConfig
        node={node}
        vmCount={vmCount}
        dependentCount={nodes.filter((n) => n.jump_node_id === node.id).length}
      />

      <DirectLinkConfig key={node.id} node={node} />

      <div className='space-y-1.5'>
        <div className='text-xs font-medium'>本机 Docker 桥</div>
        {bridge?.listening ? (
          <>
            <p className='text-xs text-muted-foreground'>
              本机 docker CLI 经这条 SSH 连接直接操作远端 daemon：
            </p>
            <pre className='rounded-md border bg-muted/30 p-2 font-mono text-[11px] break-all whitespace-pre-wrap'>
              {`docker -H unix://${bridge.socket_path} ps`}
            </pre>
          </>
        ) : (
          <p className='text-xs text-muted-foreground'>
            未监听{bridge?.error ? `：${bridge.error}` : ''}
          </p>
        )}
      </div>
    </div>
  )
}
