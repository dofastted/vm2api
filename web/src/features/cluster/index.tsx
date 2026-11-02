import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { VIEW_TITLES } from '@/config/nav'
import type { ClusterLocalStatus } from '@/types/panel-cluster'
import type { Vm } from '@/types/panel-vm'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { fmtUsd } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { PageHeader } from '@/components/page-header'
import { QueryGate, errorMessage } from '@/components/query-gate'
import { meQueryOptions } from '@/features/auth/queries'
import { ClusterSkeleton } from '@/features/cluster/cluster-skeleton'
import {
  localDetailRows,
  localDetailSummary,
} from '@/features/cluster/connection-rows'
import { JoinVpsDialog } from '@/features/cluster/join-dialog'
import { MachineDetail } from '@/features/cluster/machine-detail'
import { MachineTable } from '@/features/cluster/machine-table'
import {
  buildMachines,
  clusterSummary,
  type ClusterMachine,
} from '@/features/cluster/model'
import {
  CLUSTER_LOCAL_KEY,
  CLUSTER_NODES_KEY,
  clusterLocalQueryOptions,
  clusterNodesQueryOptions,
} from '@/features/cluster/queries'
import { SshPanel, type SshPanelTab } from '@/features/cluster/ssh-panel'
import { vmPoolsQueryOptions } from '@/features/keys/vm-pools-card'
import { dashboardQueryOptions } from '@/features/overview/queries'
import { CreateVmDialog } from '@/features/vm/create-vm-dialog'

const SELECTED_KEY = 'vm2api.cluster.machine'

function readSelected(): string {
  try {
    return localStorage.getItem(SELECTED_KEY) || 'local'
  } catch {
    return 'local'
  }
}

function MiniStat({
  label,
  value,
  hint,
  tone,
}: {
  label: string
  value: string
  hint?: React.ReactNode
  tone?: 'caution' | 'bad'
}) {
  return (
    <Card
      className={cn(
        'gap-0 px-4 py-3 shadow-none',
        tone === 'caution' &&
          'border-l-2 border-l-[color:var(--status-caution)]',
        tone === 'bad' && 'border-l-2 border-l-[color:var(--status-bad)]'
      )}
    >
      <div className='text-xs text-muted-foreground'>{label}</div>
      <div className='field-metric mt-1 text-[22px] leading-tight font-semibold'>
        {value}
      </div>
      {hint ? (
        <div className='mt-0.5 truncate text-[11.5px] text-muted-foreground/90'>
          {hint}
        </div>
      ) : null}
    </Card>
  )
}

function checkedTime(iso: string | null | undefined): string | null {
  const t = iso ? Date.parse(iso) : NaN
  if (!Number.isFinite(t)) return null
  return `${new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })} 测得`
}

export function ClusterPage() {
  const qc = useQueryClient()
  const dash = useQuery(dashboardQueryOptions(5000))
  const me = useQuery(meQueryOptions())
  const cluster = useQuery(clusterNodesQueryOptions())
  const localLink = useQuery(clusterLocalQueryOptions())
  const pools = useQuery(vmPoolsQueryOptions())
  const canManage = me.data?.role === 'admin'
  const apiNodes = useMemo(() => cluster.data || [], [cluster.data])
  const dashVms = useMemo(() => (dash.data?.vms || []) as Vm[], [dash.data])
  const dashReady = !!dash.data && !dash.data.error && !dash.error
  const hostName =
    typeof window === 'undefined' ? 'local' : window.location.hostname

  const machines = useMemo(
    () =>
      buildMachines({
        hostname: hostName,
        vms: dashVms,
        nodes: apiNodes,
        host: dashReady ? dash.data?.host : undefined,
        status: localLink.data,
        available: dashReady,
      }),
    [apiNodes, dash.data?.host, dashReady, dashVms, hostName, localLink.data]
  )
  const summary = clusterSummary(machines)
  const poolOf = useMemo(() => {
    const map = new Map<string, string>()
    for (const p of pools.data?.pools || []) {
      for (const id of p.vm_ids || []) map.set(id, p.name)
    }
    return map
  }, [pools.data])

  const [selected, setSelected] = useState(readSelected)
  const current: ClusterMachine | undefined =
    machines.find((m) => m.id === selected) || machines[0]
  const select = (id: string) => {
    setSelected(id)
    try {
      localStorage.setItem(SELECTED_KEY, id)
    } catch {
      // 无痕窗口等读写不了就只记在本页
    }
  }

  const [joinOpen, setJoinOpen] = useState(false)
  const [panel, setPanel] = useState<{ id: string; tab: SshPanelTab } | null>(
    null
  )
  const [dropTarget, setDropTarget] = useState<ClusterMachine | null>(null)
  const [createOn, setCreateOn] = useState<ClusterMachine | null>(null)
  const panelNode = apiNodes.find((n) => n.id === panel?.id) || null

  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`/api/panel/cluster/nodes/${id}`, { method: 'DELETE' }),
    onSuccess: (_data, id) => {
      toast.success('已移除节点')
      if (panel?.id === id) setPanel(null)
      qc.invalidateQueries({ queryKey: CLUSTER_NODES_KEY })
    },
    onError: (err) => toast.error(err.message),
  })
  const refreshLocal = useMutation({
    mutationFn: () =>
      api<ClusterLocalStatus>('/api/panel/cluster/local?refresh=1'),
    onSuccess: (data) => qc.setQueryData(CLUSTER_LOCAL_KEY, data),
    onError: (err) => toast.error(err.message),
  })

  // 只有主控有：节点的 SSH / 直连 / Docker / 指纹都在「连接设置」里，底下不再重复一份。
  const localDetails = {
    rows: localLink.data
      ? localDetailRows({
          status: localLink.data,
          host: dashReady ? dash.data?.host : undefined,
          nodes: apiNodes,
        })
      : null,
    summary: localLink.data ? localDetailSummary(localLink.data) : '',
    checkedAt: checkedTime(localLink.data?.checked_at),
    error: localLink.error ? localLink.error.message : null,
  }

  const today = Number(
    dash.data?.billing?.today?.total_cost ??
      machines.reduce((sum, m) => sum + m.todayUsd, 0)
  )
  const total = dash.data?.billing?.total?.total_cost

  return (
    <PageHeader
      title={VIEW_TITLES.cluster}
      extra={
        canManage ? (
          <Button onClick={() => setJoinOpen(true)}>接入 VPS</Button>
        ) : undefined
      }
    >
      <span
        className='hidden'
        aria-hidden
        dangerouslySetInnerHTML={{
          __html: `<!--
THESIS: Cluster is the machines that run slots. Every machine, control host included, is one row on the same scale.
FIRST VIEWPORT: Machine table (link, load, memory, disk, slots, room left, today) then the selected machine's slots.
LINK: state first (down / fell back to SSH), latency only when really slow; slot traffic rides the direct link.
ROOM: by slot memory quota, not current use — KVM guests fill what they were given.
ANTI-PATTERN: Local board vs remote table, lifetime spend per host, one-sample latency alarms, remove beside manage on every row.
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
          {cluster.error ? (
            <Alert variant='destructive'>
              <AlertTitle>节点列表加载失败</AlertTitle>
              <AlertDescription>{errorMessage(cluster.error)}</AlertDescription>
            </Alert>
          ) : null}

          <div className='grid grid-cols-2 gap-3 xl:grid-cols-4'>
            <MiniStat
              label='机器'
              value={String(summary.machines)}
              hint={
                summary.offline ? (
                  <span className='text-[color:var(--status-bad)]'>
                    {summary.offline} 台连不上
                  </span>
                ) : summary.online === summary.machines ? (
                  '全部在线'
                ) : (
                  `${summary.online} 台在线`
                )
              }
              tone={summary.offline ? 'bad' : undefined}
            />
            <MiniStat
              label='槽位'
              value={String(summary.slots)}
              hint={[
                `接单中 ${summary.on}`,
                `受限 ${summary.restricted}`,
                summary.stopped ? `停 ${summary.stopped}` : '',
              ]
                .filter(Boolean)
                .join(' · ')}
            />
            <MiniStat
              label='还能放'
              value={summary.fit == null ? '—' : `${summary.fit} 台`}
              hint={
                summary.fit == null
                  ? '内存读数还没到'
                  : summary.fitBy.length
                    ? `按 2G 槽算，${summary.fitBy.map((x) => `${x.name} ${x.fit}`).join(' · ')}`
                    : '按 2G 槽算，每台都满了'
              }
              tone={summary.fit === 0 ? 'caution' : undefined}
            />
            <MiniStat
              label='今日花费'
              value={fmtUsd(today, 2)}
              hint={total != null ? `累计 ${fmtUsd(total, 2)}` : undefined}
            />
          </div>

          <Card className='gap-0 overflow-hidden py-0 shadow-none'>
            <div className='flex min-h-11 items-center gap-2 border-b px-4 py-2'>
              <h3 className='text-[13px] font-semibold'>机器</h3>
              <span className='text-[11px] text-muted-foreground'>
                每 30 秒体检一次 · 点一行看这台的槽
              </span>
            </div>
            <MachineTable
              machines={machines}
              selectedId={current?.id || 'local'}
              onSelect={select}
            />
          </Card>

          <Card className='gap-0 overflow-hidden py-0 shadow-none'>
            <MachineDetail
              machines={machines}
              selectedId={current?.id || 'local'}
              onSelect={select}
              poolNameOf={(id) => poolOf.get(id) || null}
              canManage={canManage}
              localDetails={localDetails}
              localRefresh={{
                pending: refreshLocal.isPending,
                run: () => refreshLocal.mutate(),
              }}
              onOpenNode={(id, tab) => setPanel({ id, tab })}
              onRemove={setDropTarget}
              onCreate={setCreateOn}
            />
          </Card>
        </div>
      </QueryGate>

      <JoinVpsDialog
        open={joinOpen}
        onOpenChange={setJoinOpen}
        nodes={apiNodes}
        onJoined={(node) => {
          qc.invalidateQueries({ queryKey: CLUSTER_NODES_KEY })
          select(node.id)
          setPanel({ id: node.id, tab: 'link' })
        }}
      />
      <SshPanel
        node={panelNode}
        nodes={apiNodes}
        tab={panel?.tab}
        vmCount={
          dashReady
            ? dashVms.filter((vm) => vm.node_id === panel?.id).length
            : null
        }
        onOpenChange={(open) => {
          if (!open) setPanel(null)
        }}
      />
      <CreateVmDialog
        open={!!createOn}
        onOpenChange={(open) => {
          if (!open) setCreateOn(null)
        }}
        nodeId={createOn?.role === 'remote' ? createOn.id : undefined}
      />
      <ConfirmDialog
        open={!!dropTarget}
        onOpenChange={(open) => {
          if (!open) setDropTarget(null)
        }}
        title='移除节点'
        desc={
          dropTarget
            ? `${dropTarget.name} · ${dropTarget.address}。断开 SSH、删除本地凭证与 Docker 桥；远端容器保持运行。`
            : ''
        }
        confirmText='移除'
        cancelBtnText='取消'
        destructive
        handleConfirm={() => {
          if (!dropTarget) return
          remove.mutate(dropTarget.id)
          setDropTarget(null)
        }}
      />
    </PageHeader>
  )
}
