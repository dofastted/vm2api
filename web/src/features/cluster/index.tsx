import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { VIEW_TITLES } from '@/config/nav'
import type { Vm } from '@/types/panel-vm'
import { toast } from 'sonner'
import { fmtNum, fmtUsd } from '@/lib/format'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { PageHeader } from '@/components/page-header'
import { QueryGate, errorMessage } from '@/components/query-gate'
import { StatCard } from '@/components/stat-card'
import { ClusterSkeleton } from '@/features/cluster/cluster-skeleton'
import { JoinVpsDialog } from '@/features/cluster/join-dialog'
import { LocalBoard } from '@/features/cluster/local-board'
import { MOCK_REMOTES } from '@/features/cluster/mock-remotes'
import {
  buildLocalNode,
  clusterTotals,
  localSpendUsd,
  type ClusterNode,
} from '@/features/cluster/model'
import { RemoteList } from '@/features/cluster/remote-list'
import {
  dashboardQueryOptions,
  usageQueryOptions,
} from '@/features/overview/queries'

export function ClusterPage() {
  const dash = useQuery(dashboardQueryOptions(5000))
  const usage = useQuery(usageQueryOptions(15000))
  const [remotes, setRemotes] = useState<ClusterNode[]>(MOCK_REMOTES)
  const [joinOpen, setJoinOpen] = useState(false)
  const [dropTarget, setDropTarget] = useState<ClusterNode | null>(null)

  const hostName =
    typeof window === 'undefined' ? 'local' : window.location.hostname
  const dashReady = !!dash.data && !dash.data.error && !dash.error
  const local = useMemo(
    () =>
      buildLocalNode({
        host: hostName,
        vms: (dash.data?.vms || []) as Vm[],
        spendUsd: localSpendUsd(dash.data, usage.data),
        available: dashReady,
      }),
    [dash.data, dashReady, hostName, usage.data]
  )
  const nodes = useMemo(() => [local, ...remotes], [local, remotes])
  const totals = clusterTotals(nodes)
  const reachableTone =
    local.link === 'bad'
      ? 'bad'
      : local.link === 'none' || totals.unreachable > 0
        ? 'caution'
        : 'neutral'

  return (
    <PageHeader
      title={VIEW_TITLES.cluster}
      extra={<Button onClick={() => setJoinOpen(true)}>接入 VPS</Button>}
    >
      <span
        className='hidden'
        aria-hidden
        dangerouslySetInnerHTML={{
          __html: `<!--
THESIS: Cluster is host topology, not a slot list. Local VPS is the instrument; remotes are reachability.
OWN-WORLD: Graphite Operate console. Teal only on primary action. StatusMark is the only health language.
FIRST VIEWPORT: Local board with live slot/cred/spend and host meters; remotes wait below as a connection list.
SIGNATURE: IP as identity, link as StatusMark, dead nodes render em-dash not zero.
ANTI-PATTERN: Equal SaaS server cards, VM fleet filters, nested cards, decorative maps.
-->`,
        }}
      />
      <QueryGate
        loading={dash.isLoading && !dash.data}
        error={null}
        skeleton={<ClusterSkeleton />}
      >
        <div className='space-y-3'>
          {dash.error || dash.data?.error ? (
            <Alert variant='destructive'>
              <AlertTitle>本机指标加载失败</AlertTitle>
              <AlertDescription>
                {errorMessage(
                  dash.error || new Error(String(dash.data?.error))
                )}
              </AlertDescription>
            </Alert>
          ) : null}

          <div className='grid grid-cols-2 gap-3 xl:grid-cols-5'>
            <StatCard label='节点' value={fmtNum(totals.nodes)} />
            <StatCard
              label='可达'
              value={`${fmtNum(totals.reachable)} / ${fmtNum(totals.nodes)}`}
              tone={reachableTone}
            />
            <StatCard label='槽位' value={fmtNum(totals.vms)} />
            <StatCard label='在线凭证' value={fmtNum(totals.online)} />
            <div className='col-span-2 xl:col-span-1'>
              <StatCard label='总花费' value={fmtUsd(totals.spend, 2)} />
            </div>
          </div>

          <LocalBoard
            node={local}
            host={dashReady ? dash.data?.host : undefined}
          />

          <RemoteList
            nodes={remotes}
            onJoin={() => setJoinOpen(true)}
            onDisconnect={setDropTarget}
          />
        </div>
      </QueryGate>

      <JoinVpsDialog
        open={joinOpen}
        onOpenChange={setJoinOpen}
        onJoin={(node) => {
          if (remotes.some((row) => row.host === node.host)) {
            toast.error('这个地址已经在列表里')
            return false
          }
          setRemotes((cur) => [...cur, node])
          return true
        }}
      />
      <ConfirmDialog
        open={!!dropTarget}
        onOpenChange={(open) => {
          if (!open) setDropTarget(null)
        }}
        title='断开节点'
        desc={
          dropTarget
            ? `${dropTarget.label} · ${dropTarget.host}。只从本页拿掉示意行，不会改远端。`
            : ''
        }
        confirmText='断开'
        cancelBtnText='取消'
        destructive
        handleConfirm={() => {
          if (!dropTarget) return
          setRemotes((cur) => cur.filter((row) => row.id !== dropTarget.id))
          setDropTarget(null)
          toast.success(`已断开 ${dropTarget.host}`)
        }}
      />
    </PageHeader>
  )
}
