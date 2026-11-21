import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  ClusterApiNode,
  DockerContainer,
  DockerContainerInput,
  DockerInstallJob,
  DockerLogs,
} from '@/types/panel-cluster'
import type { Vm } from '@/types/panel-vm'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { StatusMark } from '@/components/status-mark'
import {
  CLUSTER_NODES_KEY,
  dockerContainersQueryOptions,
  dockerInfoQueryOptions,
  jsonBody,
} from '@/features/cluster/queries'
import { vmsListQueryOptions } from '@/features/vm/queries'

const STATE_TONE: Record<string, { key: string; cls: string; text: string }> = {
  running: { key: 'ok', cls: 'ok', text: '运行中' },
  restarting: { key: 'caution', cls: 'caution', text: '重启中' },
  paused: { key: 'caution', cls: 'caution', text: '已暂停' },
  created: { key: 'none', cls: 'none', text: '已创建' },
  exited: { key: 'off', cls: 'off', text: '已停止' },
  dead: { key: 'bad', cls: 'bad', text: '异常' },
}

/** 与节点槽位容器名一致：`vm-14` → `kin-14`。 */
function slotContainerName(vmId: string) {
  return `kin-${vmId.replace(/^vm-/, '')}`
}

/** 槽位已登记但节点上还没有容器时，Docker 表仍要能看到它。 */
function absentSlotRow(vm: Vm): DockerContainer & { absent: true } {
  return {
    id: `slot:${vm.id}`,
    name: slotContainerName(vm.id),
    image: vm.kernel || '—',
    state: 'created',
    status:
      vm.status === 'running'
        ? '记录为运行，节点上没有容器'
        : '槽位已登记，容器未创建',
    created_at: typeof vm.created_at === 'string' ? vm.created_at : null,
    ports: [],
    managed: true,
    vm_id: vm.id,
    role: 'slot',
    absent: true,
  }
}
export function DockerTab({ node }: { node: ClusterApiNode }) {
  const qc = useQueryClient()
  const ready = node.link.state === 'ready'
  const dockerOk = ready && node.health?.docker.ok === true
  const info = useQuery(dockerInfoQueryOptions(node.id, dockerOk))
  const containers = useQuery(dockerContainersQueryOptions(node.id, dockerOk))
  const slots = useQuery(vmsListQueryOptions())
  const [logsFor, setLogsFor] = useState<string | null>(null)
  const [removeTarget, setRemoveTarget] = useState<string | null>(null)
  const base = `/api/panel/cluster/nodes/${node.id}/docker`
  const refresh = () =>
    qc.invalidateQueries({ queryKey: ['panel', 'cluster', node.id, 'docker'] })

  const action = useMutation({
    mutationFn: ({ id, act }: { id: string; act: string }) =>
      act === 'remove'
        ? api(`${base}/containers/${encodeURIComponent(id)}`, {
            method: 'DELETE',
          })
        : api(`${base}/containers/${encodeURIComponent(id)}/${act}`, {
            method: 'POST',
          }),
    onSuccess: refresh,
    onError: (err) => toast.error(err.message),
  })

  const install = useMutation({
    mutationFn: () =>
      api<DockerInstallJob>(`${base}/install`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: CLUSTER_NODES_KEY }),
    onError: (err) => toast.error(err.message),
  })

  if (node.platform === 'darwin') {
    return (
      <p className='text-sm text-muted-foreground'>
        macOS 原生节点不使用 Docker：槽位以 SSH 用户的 launchd 服务运行。
      </p>
    )
  }

  if (!ready) {
    return (
      <p className='text-sm text-muted-foreground'>
        节点未连接，Docker 不可操作。
      </p>
    )
  }

  if (!dockerOk) {
    const job = node.install
    return (
      <div className='space-y-3 text-sm'>
        <p className='text-muted-foreground'>
          {node.health?.docker.ok === false
            ? `远端 Docker 不可用${node.health.docker.error ? `：${node.health.docker.error}` : ''}`
            : '正在检测远端 Docker'}
        </p>
        <Button
          onClick={() => install.mutate()}
          disabled={install.isPending || job?.status === 'running'}
        >
          {job?.status === 'running' ? '安装中…' : '安装 Docker'}
        </Button>
        <p className='text-xs text-muted-foreground'>
          走 get.docker.com，并把 {node.username} 加入 docker
          组；完成后自动重连。非 root 用户需要免密 sudo。
        </p>
        {job ? (
          <pre className='max-h-64 overflow-auto rounded-md border bg-muted/30 p-2 text-[11px] whitespace-pre-wrap'>
            {job.status === 'running'
              ? job.log || '…'
              : `${job.status === 'done' ? '完成' : `失败（exit ${job.exit_code ?? '—'}）`}\n${job.log}`}
          </pre>
        ) : null}
      </div>
    )
  }

  // 同一 VM 的槽位与出口挨着：kin-02 → kin-02-egress；其余容器按名字排在后面。
  // 节点上还没容器的槽位也要出现，否则管理页看起来像这台 VPS 没有这个 VM。
  const live = containers.data || []
  const seen = new Set(
    live.flatMap((c) => [c.vm_id, c.name].filter((v): v is string => !!v))
  )
  const missing = (slots.data?.items || [])
    .filter((vm) => vm.node_id === node.id)
    .filter((vm) => !seen.has(vm.id) && !seen.has(slotContainerName(vm.id)))
    .map(absentSlotRow)
  const items = [...missing, ...live].sort((a, b) => {
    const ka = a.vm_id
      ? `0${a.vm_id}${a.role === 'egress' ? '1' : '0'}`
      : `1${a.name}`
    const kb = b.vm_id
      ? `0${b.vm_id}${b.role === 'egress' ? '1' : '0'}`
      : `1${b.name}`
    return ka.localeCompare(kb)
  })

  return (
    <div className='space-y-4'>
      <div className='flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground'>
        <span>Docker {info.data?.version || '—'}</span>
        <span>{info.data?.os || '—'}</span>
        <span>
          {info.data?.cpus ?? '—'} CPU ·{' '}
          {info.data?.mem_bytes
            ? `${(info.data.mem_bytes / 1024 ** 3).toFixed(1)} GiB`
            : '—'}
        </span>
        <span>
          运行 {info.data?.running ?? '—'} / {info.data?.containers ?? '—'}
        </span>
      </div>

      <CreateContainerForm base={base} onCreated={refresh} />

      <div className='overflow-x-auto rounded-md border'>
        <table className='w-full min-w-[640px] text-sm'>
          <thead className='bg-muted/30 text-[11px] text-muted-foreground'>
            <tr>
              <th className='px-3 py-1.5 text-left font-medium'>容器</th>
              <th className='px-3 py-1.5 text-left font-medium'>镜像</th>
              <th className='px-3 py-1.5 text-left font-medium'>状态</th>
              <th className='px-3 py-1.5 text-left font-medium'>端口</th>
              <th className='px-3 py-1.5 text-right font-medium'>操作</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td
                  colSpan={5}
                  className='px-3 py-6 text-center text-xs text-muted-foreground'
                >
                  {containers.isLoading
                    ? '加载中…'
                    : containers.error
                      ? containers.error.message
                      : '还没有容器'}
                </td>
              </tr>
            ) : (
              items.map((c) => {
                const absent = 'absent' in c && c.absent
                // A crash-looping container reports `restarting`; it still needs 停止, not 启动.
                const running =
                  c.state === 'running' || c.state === 'restarting'
                const busy = action.isPending && action.variables?.id === c.id
                return (
                  <tr key={c.id} className='border-t border-border/40'>
                    <td className='px-3 py-1.5'>
                      <div className='flex items-center gap-1.5 font-medium'>
                        <span className={c.role === 'egress' ? 'pl-3' : ''}>
                          {c.name}
                        </span>
                        {c.vm_id ? (
                          <span className='rounded-[4px] border border-border/70 px-1 text-[10px] leading-4 font-normal text-muted-foreground'>
                            {c.role === 'egress' ? `${c.vm_id} 出口` : c.vm_id}
                          </span>
                        ) : null}
                      </div>
                      <div className='font-mono text-[10px] text-muted-foreground'>
                        {absent ? '—' : c.id.slice(0, 12)}
                      </div>
                    </td>
                    <td className='px-3 py-1.5 text-xs'>{c.image}</td>
                    <td className='px-3 py-1.5'>
                      <div className='flex items-center gap-1.5'>
                        <StatusMark
                          tone={
                            STATE_TONE[c.state] || {
                              key: 'none',
                              cls: 'none',
                              text: c.state,
                            }
                          }
                        />
                        <span className='text-[11px] text-muted-foreground'>
                          {c.status}
                        </span>
                      </div>
                    </td>
                    <td className='px-3 py-1.5 font-mono text-[11px]'>
                      {c.ports.join(' ') || '—'}
                    </td>
                    <td className='px-3 py-1.5 text-right whitespace-nowrap'>
                      {absent ? (
                        <span className='text-[11px] text-muted-foreground'>
                          无容器
                        </span>
                      ) : (
                        <>
                          {(running
                            ? (['stop', 'restart'] as const)
                            : (['start'] as const)
                          ).map((act) => (
                            <Button
                              key={act}
                              size='sm'
                              variant='ghost'
                              className='h-7 px-2 text-xs'
                              disabled={busy}
                              onClick={() => action.mutate({ id: c.id, act })}
                            >
                              {act === 'stop'
                                ? '停止'
                                : act === 'restart'
                                  ? '重启'
                                  : '启动'}
                            </Button>
                          ))}
                          <Button
                            size='sm'
                            variant='ghost'
                            className='h-7 px-2 text-xs'
                            onClick={() =>
                              setLogsFor(logsFor === c.id ? null : c.id)
                            }
                          >
                            日志
                          </Button>
                          <Button
                            size='sm'
                            variant='ghost'
                            className='h-7 px-2 text-xs text-red-3'
                            disabled={busy}
                            onClick={() => setRemoveTarget(c.id)}
                          >
                            删除
                          </Button>
                        </>
                      )}
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      {logsFor ? <ContainerLogs base={base} id={logsFor} /> : null}

      <ConfirmDialog
        open={!!removeTarget}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null)
        }}
        title='删除容器'
        desc='强制删除容器及其匿名卷，远端立即生效。'
        confirmText='删除'
        cancelBtnText='取消'
        destructive
        handleConfirm={() => {
          if (!removeTarget) return
          action.mutate({ id: removeTarget, act: 'remove' })
          if (logsFor === removeTarget) setLogsFor(null)
          setRemoveTarget(null)
        }}
      />
    </div>
  )
}

function CreateContainerForm({
  base,
  onCreated,
}: {
  base: string
  onCreated: () => void
}) {
  const [image, setImage] = useState('')
  const [name, setName] = useState('')
  const [ports, setPorts] = useState('')
  const [env, setEnv] = useState('')
  const [restart, setRestart] =
    useState<NonNullable<DockerContainerInput['restart']>>('unless-stopped')

  const create = useMutation({
    mutationFn: () =>
      api<{ id: string }>(
        `${base}/containers`,
        jsonBody({
          image: image.trim(),
          name: name.trim() || undefined,
          ports: ports
            .split(/[\n,]/)
            .map((s) => s.trim())
            .filter(Boolean),
          env: env
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean),
          restart,
        } satisfies DockerContainerInput)
      ),
    onSuccess: () => {
      toast.success('容器已创建并启动')
      setImage('')
      setName('')
      setPorts('')
      setEnv('')
      onCreated()
    },
    onError: (err) => toast.error(err.message),
  })

  return (
    <div className='grid grid-cols-12 gap-2 rounded-md border p-3'>
      <div className='col-span-12 space-y-1 sm:col-span-4'>
        <Label className='text-xs'>镜像</Label>
        <Input
          placeholder='nginx:alpine'
          spellCheck={false}
          value={image}
          onChange={(e) => setImage(e.target.value)}
        />
      </div>
      <div className='col-span-6 space-y-1 sm:col-span-3'>
        <Label className='text-xs'>名称</Label>
        <Input
          placeholder='可选'
          spellCheck={false}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className='col-span-6 space-y-1 sm:col-span-3'>
        <Label className='text-xs'>端口</Label>
        <Input
          placeholder='8080:80, 8443:443'
          spellCheck={false}
          value={ports}
          onChange={(e) => setPorts(e.target.value)}
        />
      </div>
      <div className='col-span-12 space-y-1 sm:col-span-2'>
        <Label className='text-xs'>重启</Label>
        <Select
          value={restart}
          onValueChange={(v) => setRestart(v as typeof restart)}
        >
          <SelectTrigger className='w-full'>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value='unless-stopped'>unless-stopped</SelectItem>
            <SelectItem value='always'>always</SelectItem>
            <SelectItem value='on-failure'>on-failure</SelectItem>
            <SelectItem value='no'>no</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className='col-span-12 space-y-1 sm:col-span-10'>
        <Label className='text-xs'>环境变量</Label>
        <Textarea
          placeholder={'KEY=value，每行一个'}
          spellCheck={false}
          className='h-16 font-mono text-[11px]'
          value={env}
          onChange={(e) => setEnv(e.target.value)}
        />
      </div>
      <div className='col-span-12 flex items-end sm:col-span-2'>
        <Button
          className='w-full'
          disabled={!image.trim() || create.isPending}
          onClick={() => create.mutate()}
        >
          {create.isPending ? '创建中…' : '创建并启动'}
        </Button>
      </div>
    </div>
  )
}

function ContainerLogs({ base, id }: { base: string; id: string }) {
  const logs = useQuery({
    queryKey: ['panel', 'cluster', base, 'logs', id] as const,
    queryFn: () =>
      api<DockerLogs>(
        `${base}/containers/${encodeURIComponent(id)}/logs?tail=300`
      ),
    refetchInterval: 5000,
    refetchOnWindowFocus: false,
    retry: false,
  })
  return (
    <div className='space-y-1'>
      <div className='text-xs text-muted-foreground'>
        日志 · {id.slice(0, 12)} · 最近 300 行
      </div>
      <pre className='max-h-72 overflow-auto rounded-md border bg-[#0b0d10] p-2 font-mono text-[11px] text-neutral-200'>
        {logs.isLoading
          ? '加载中…'
          : logs.error
            ? logs.error.message
            : (logs.data?.lines || []).map((line, i) => (
                <span
                  key={i}
                  className={cn(line.stream === 'stderr' && 'text-amber-300')}
                >
                  {line.text}
                </span>
              ))}
      </pre>
    </div>
  )
}
