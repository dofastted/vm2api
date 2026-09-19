import { fmtNum, fmtUsd } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/empty-state'
import { StatusMark } from '@/components/status-mark'
import {
  formatNodeMetric,
  isLiveLink,
  LINK_LATENCY_WARN_MS,
  LINK_TONE,
  type ClusterNode,
} from '@/features/cluster/model'
import { PanelCard } from '@/features/overview/panel-card'

const COL = {
  name: 'min-w-[108px] flex-[1.1] pl-3',
  host: 'min-w-[132px] flex-[1.3]',
  link: 'min-w-[128px] flex-[1.1]',
  metric: 'min-w-[64px] flex-[0.7] text-right',
  spend: 'min-w-[88px] flex-[0.9] pr-2 text-right',
  action: 'w-14 shrink-0 pr-2 text-right',
}

export function RemoteList({
  nodes,
  onJoin,
  onDisconnect,
}: {
  nodes: ClusterNode[]
  onJoin: () => void
  onDisconnect: (node: ClusterNode) => void
}) {
  return (
    <PanelCard
      title='扩展节点'
      meta='多台 VPS 把槽位扩进当前项目'
      action={
        <Button size='sm' variant='outline' onClick={onJoin}>
          接入
        </Button>
      }
    >
      {nodes.length === 0 ? (
        <EmptyState
          reason='还没有扩展节点。接入一台 VPS，把它上面的槽位并进这台控制台。'
          actionLabel='接入 VPS'
          onAction={onJoin}
        />
      ) : (
        <div className='overflow-x-auto'>
          <div className='min-w-[760px]'>
            <div className='flex h-8 items-center border-b bg-muted/30 text-[11px] font-medium tracking-wide text-muted-foreground/80'>
              <div className={COL.name}>节点</div>
              <div className={COL.host}>IP</div>
              <div className={COL.link}>链路</div>
              <div className={COL.metric}>槽位</div>
              <div className={COL.metric}>凭证</div>
              <div className={COL.metric}>在线</div>
              <div className={COL.spend}>花费</div>
              <div className={COL.action} />
            </div>
            {nodes.map((node) => {
              const live = isLiveLink(node.link)
              const lat =
                live && node.latencyMs != null
                  ? `${Math.round(node.latencyMs)}ms`
                  : ''
              const latHot =
                live &&
                node.latencyMs != null &&
                node.latencyMs > LINK_LATENCY_WARN_MS
              return (
                <div
                  key={node.id}
                  className='flex h-9 items-center border-b border-border/40 text-sm last:border-b-0 hover:bg-muted/50'
                >
                  <div
                    className={cn(
                      COL.name,
                      'flex min-w-0 items-center gap-1.5'
                    )}
                  >
                    <span className='truncate font-medium'>{node.label}</span>
                    {node.synthetic ? (
                      <span className='shrink-0 text-[10px] text-muted-foreground'>
                        示意
                      </span>
                    ) : null}
                  </div>
                  <div className={cn(COL.host, 'field-host truncate text-xs')}>
                    {node.host}
                  </div>
                  <div className={cn(COL.link, 'flex items-center gap-1.5')}>
                    <StatusMark tone={LINK_TONE[node.link]} />
                    {lat ? (
                      <span
                        className={cn(
                          'field-metric shrink-0 text-[11px]',
                          latHot ? 'text-caution-3' : 'text-muted-foreground'
                        )}
                      >
                        {lat}
                      </span>
                    ) : null}
                  </div>
                  <div className={cn(COL.metric, 'field-metric')}>
                    {formatNodeMetric(node, node.vmCount, fmtNum)}
                  </div>
                  <div className={cn(COL.metric, 'field-metric')}>
                    {formatNodeMetric(node, node.credCount, fmtNum)}
                  </div>
                  <div className={cn(COL.metric, 'field-metric')}>
                    {formatNodeMetric(node, node.onlineCredCount, fmtNum)}
                  </div>
                  <div className={cn(COL.spend, 'field-metric')}>
                    {formatNodeMetric(node, node.spendUsd, (n) => fmtUsd(n, 2))}
                  </div>
                  <div className={COL.action}>
                    <Button
                      size='sm'
                      variant='ghost'
                      className='h-7 px-2 text-xs'
                      onClick={() => onDisconnect(node)}
                    >
                      断开
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </PanelCard>
  )
}
