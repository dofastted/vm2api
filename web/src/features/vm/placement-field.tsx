import { useEffect, useRef, useState } from 'react'
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query'
import type {
  ClusterApiNode,
  NodePreflight,
  PreflightCheck,
  SlotImageJob,
} from '@/types/panel-cluster'
import type { RuntimeType } from '@/types/panel-vm'
import { RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { importErrorMessage } from '@/lib/import-errors'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { StatusMark } from '@/components/status-mark'
import { meQueryOptions } from '@/features/auth/queries'
import {
  LINK_STATE_TEXT,
  LINK_TONE,
  remoteLink,
} from '@/features/cluster/model'
import {
  clusterNodesQueryOptions,
  nodePreflightQueryOptions,
  slotImageJobQueryOptions,
  startSlotImageBuild,
} from '@/features/cluster/queries'
import {
  logTail,
  PREFLIGHT_CHECK_LABEL,
  preflightMark,
  type PreflightMark,
} from '@/features/vm/placement'

/** Select 里「本机」的哨兵值；提交时不发 node_id。 */
const LOCAL = '__local__'

const MARK: Record<PreflightMark, { glyph: string; color: string }> = {
  ok: { glyph: '✓', color: 'var(--status-ok)' },
  fail: { glyph: '✗', color: 'var(--status-bad)' },
  warn: { glyph: '!', color: 'var(--status-warn)' },
}

export type Placement = {
  /** 只有 admin 且集群里至少一个远端节点时为 true。 */
  visible: boolean
  nodes: ClusterApiNode[]
  /** 空串 = 本机（提交时不发 node_id）。 */
  nodeId: string
  setNodeId: (id: string) => void
  preflight: UseQueryResult<NodePreflight, Error>
  /** 远端时只有预检明确 `ok === true` 且不在检查中才放行提交。 */
  blocked: boolean
}

/**
 * 创建槽位的「目标节点」状态。不可见时 `nodeId=''`，创建行为与没有集群时完全一致。
 */
export function usePlacement(
  kernel: string,
  runtimeType: RuntimeType = 'docker'
): Placement {
  const me = useQuery(meQueryOptions())
  const isAdmin = me.data?.role === 'admin'
  const nodes = useQuery({
    ...clusterNodesQueryOptions(),
    enabled: isAdmin,
  })
  const items = isAdmin ? nodes.data || [] : []
  const [picked, setPicked] = useState('')
  // 选中的节点被移除后退回本机，避免发一个已不存在的 node_id。
  const nodeId = items.some((n) => n.id === picked) ? picked : ''
  const preflight = useQuery(
    nodePreflightQueryOptions(nodeId, kernel, runtimeType)
  )
  return {
    visible: items.length > 0,
    nodes: items,
    nodeId,
    setNodeId: setPicked,
    preflight,
    blocked: !!nodeId && (preflight.isFetching || preflight.data?.ok !== true),
  }
}

export function PreflightCheckList({ checks }: { checks: PreflightCheck[] }) {
  if (!checks.length) return null
  return (
    <ul className='space-y-0.5 text-xs'>
      {checks.map((c) => {
        const mark = MARK[preflightMark(c)]
        return (
          <li key={c.id} className='flex min-w-0 items-baseline gap-1.5'>
            <span
              className='w-3 shrink-0 text-center font-semibold'
              style={{ color: mark.color }}
              aria-hidden='true'
            >
              {mark.glyph}
            </span>
            <span className='w-12 shrink-0 text-muted-foreground'>
              {PREFLIGHT_CHECK_LABEL[c.id] || c.id}
            </span>
            <span className='min-w-0 break-words'>{c.message}</span>
          </li>
        )
      })}
    </ul>
  )
}

function NodeOption({ node }: { node: ClusterApiNode }) {
  const state = LINK_STATE_TEXT[node.link.state]
  return (
    <span className='flex min-w-0 items-center gap-1.5'>
      <span className='truncate'>{node.label || node.host}</span>
      <span className='truncate text-xs text-muted-foreground'>
        {node.host}
      </span>
      <StatusMark
        tone={{ ...LINK_TONE[remoteLink(node)], text: state, label: state }}
      />
    </span>
  )
}

/** 目标节点选择 + 远端预检 + 镜像准备。`placement.visible` 为 false 时不渲染。 */
export function PlacementField({
  placement,
  kernel,
  gptBlocked,
  runtimeType = 'docker',
}: {
  placement: Placement
  kernel: string
  /** GPT 槽只能建在本机：选了远端时直接提示，不等后端 400。 */
  gptBlocked: boolean
  runtimeType?: RuntimeType
}) {
  const { visible, nodes, nodeId, setNodeId, preflight } = placement
  if (!visible) return null
  return (
    <div className='space-y-1'>
      <Label>目标节点</Label>
      <Select
        value={nodeId || LOCAL}
        onValueChange={(v) => setNodeId(v === LOCAL ? '' : v)}
      >
        <SelectTrigger aria-label='目标节点'>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={LOCAL}>本机</SelectItem>
          {nodes.map((n) => (
            <SelectItem key={n.id} value={n.id}>
              <NodeOption node={n} />
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {nodeId ? (
        <div className='space-y-2 rounded-md border p-2'>
          {gptBlocked ? (
            <p className='text-xs text-[color:var(--status-bad)]'>
              远端节点暂不支持 GPT 槽，请改选本机。
            </p>
          ) : null}
          <div className='flex items-center justify-between gap-2'>
            <span className='text-xs text-muted-foreground'>
              {preflight.isFetching
                ? '预检中…'
                : preflight.data
                  ? preflight.data.ok
                    ? '预检通过'
                    : '预检未通过'
                  : preflight.error
                    ? '预检请求失败'
                    : '等待预检'}
            </span>
            <Button
              size='sm'
              variant='ghost'
              className='h-6 px-2 text-xs'
              disabled={preflight.isFetching}
              onClick={() => void preflight.refetch()}
            >
              <RefreshCw className='size-3' aria-hidden='true' />
              重新检查
            </Button>
          </div>
          {preflight.error && !preflight.isFetching ? (
            <p className='text-xs text-[color:var(--status-bad)]'>
              {importErrorMessage(preflight.error)}
            </p>
          ) : null}
          {preflight.data ? (
            <PreflightCheckList checks={preflight.data.checks} />
          ) : null}
          {preflight.data && !preflight.data.image.present ? (
            <SlotImagePrep
              nodeId={nodeId}
              kernel={kernel}
              runtimeType={runtimeType}
              imageRef={preflight.data.image.ref}
              initialJob={preflight.data.image.job}
              onReady={() => void preflight.refetch()}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function SlotImagePrep({
  nodeId,
  kernel,
  runtimeType,
  imageRef,
  initialJob,
  onReady,
}: {
  nodeId: string
  kernel: string
  runtimeType: RuntimeType
  imageRef: string
  initialJob: SlotImageJob | null
  onReady: () => void
}) {
  const qc = useQueryClient()
  const jobOptions = slotImageJobQueryOptions(nodeId, kernel, true)
  const jobQ = useQuery(jobOptions)
  const job = jobQ.data ?? initialJob
  const running = job?.status === 'running'

  const start = useMutation({
    mutationFn: () => startSlotImageBuild(nodeId, kernel, runtimeType),
    onSuccess: (next) => qc.setQueryData(jobOptions.queryKey, next),
    onError: (e: Error) => toast.error(importErrorMessage(e)),
  })

  // 轮询停下（running → done / failed）是构建结束的唯一信号。
  const seen = useRef('')
  useEffect(() => {
    const st = job?.status || ''
    if (st === 'running') {
      seen.current = 'running'
      return
    }
    if (seen.current !== 'running') return
    seen.current = st
    if (st === 'done') {
      toast.success('镜像已就绪，重新预检')
      onReady()
    } else if (st === 'failed') {
      toast.error('镜像构建失败，见日志')
    }
  }, [job?.status, onReady])

  const logRef = useRef<HTMLPreElement>(null)
  const tail = logTail(job?.log)
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [tail])

  return (
    <div className='space-y-1.5 border-t pt-2'>
      <div className='flex flex-wrap items-center gap-2'>
        <span className='min-w-0 flex-1 text-xs text-muted-foreground'>
          {running
            ? '镜像构建中，每 3s 刷新…'
            : job?.status === 'failed'
              ? '镜像构建失败'
              : '节点上缺少槽位镜像'}
          {imageRef ? (
            <span className='ms-1 font-mono break-all'>{imageRef}</span>
          ) : null}
        </span>
        <Button
          size='sm'
          variant='outline'
          disabled={running || start.isPending}
          loading={start.isPending}
          onClick={() => start.mutate()}
        >
          {running
            ? '准备中…'
            : job?.status === 'failed'
              ? '重新准备'
              : '准备镜像'}
        </Button>
      </div>
      {running || job?.status === 'failed' ? (
        <p className='text-[11px] text-muted-foreground'>
          上传二进制并在节点上 docker build，通常需要几分钟。
        </p>
      ) : null}
      {tail ? (
        <pre
          ref={logRef}
          className='max-h-48 overflow-auto rounded-md border bg-muted/30 p-2 font-mono text-[11px] whitespace-pre-wrap'
        >
          {tail}
        </pre>
      ) : null}
    </div>
  )
}
