import type { HostStats } from '@/types/panel-overview'
import { fmtNum, fmtUsd } from '@/lib/format'
import { StatusMark } from '@/components/status-mark'
import {
  formatNodeMetric,
  isLiveLink,
  LINK_TONE,
  type ClusterNode,
} from '@/features/cluster/model'
import { HostColumn } from '@/features/overview/host-column'
import { PanelCard, StatCell } from '@/features/overview/panel-card'

export function LocalBoard({
  node,
  host,
}: {
  node: ClusterNode
  host: HostStats | undefined
}) {
  const live = isLiveLink(node.link)
  return (
    <PanelCard
      title='本机'
      meta={node.host}
      action={<StatusMark tone={LINK_TONE[node.link]} variant='pill' />}
    >
      <div className='flex flex-col lg:flex-row'>
        <div className='min-w-0 flex-1'>
          <div className='grid grid-cols-2 gap-px bg-border/60 sm:grid-cols-4'>
            <StatCell
              label='槽位'
              value={formatNodeMetric(node, node.vmCount, fmtNum)}
            />
            <StatCell
              label='凭证'
              value={formatNodeMetric(node, node.credCount, fmtNum)}
            />
            <StatCell
              label='在线凭证'
              value={formatNodeMetric(node, node.onlineCredCount, fmtNum)}
            />
            <StatCell
              label='总花费'
              value={formatNodeMetric(node, node.spendUsd, (n) => fmtUsd(n, 2))}
            />
          </div>
        </div>
        {live ? (
          <div className='px-4 py-3'>
            <HostColumn host={host} />
          </div>
        ) : null}
      </div>
    </PanelCard>
  )
}
