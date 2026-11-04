import { useMemo, useState, type ReactNode } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { Vm, VmKernelSnapshot } from '@/types/panel-vm'
import { toast } from 'sonner'
import { patchVm } from '@/lib/api'
import { isCodexVm } from '@/lib/vm-kind'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { dashboardQueryOptions } from '@/features/overview/queries'
import {
  DATAPLANE_HINT,
  HOP_TRANSPORT_LABEL,
  dataplaneLabel,
} from '@/features/vm/dataplane-contract'
import {
  DEFAULT_RESOLVED_ENGINE,
  inferenceEngineLabel,
  inferenceEnginePatchValue,
  normalizeInferenceEngine,
} from '@/features/vm/engine-contract'
import { isRemoteVm, REMOTE_UNSUPPORTED_TEXT } from '@/features/vm/placement'
import { vmQueryOptions } from '@/features/vm/queries'
import { useVmPerms } from '@/features/vm/vm-perms'

export function VmEngineEditor({
  id,
  vm,
  kernel,
}: {
  id: string
  vm: Vm
  kernel?: VmKernelSnapshot | null
}) {
  const qc = useQueryClient()
  const configured = normalizeInferenceEngine(
    kernel?.configured_engine ?? vm.inference_engine,
    'auto'
  )
  const resolved = normalizeInferenceEngine(
    kernel?.resolved_engine ?? vm.resolved_inference_engine,
    DEFAULT_RESOLVED_ENGINE
  )
  const active = normalizeInferenceEngine(
    kernel?.active_engine ?? vm.runtime?.engine,
    resolved
  )
  const inherits = configured === 'auto'
  const canEdit = useVmPerms().admin
  const remote = isRemoteVm(vm)
  const status = useMemo(
    () => ({
      configured: inferenceEngineLabel(configured),
      resolved: inferenceEngineLabel(resolved),
      active: inferenceEngineLabel(active),
    }),
    [active, configured, resolved]
  )
  const inherit = useMutation({
    mutationFn: () =>
      patchVm(id, { inference_engine: inferenceEnginePatchValue('auto') }),
    onSuccess: async () => {
      toast.success('推理内核已改为跟随全局')
      await Promise.all([
        qc.invalidateQueries({ queryKey: vmQueryOptions(id).queryKey }),
        qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
      ])
    },
    onError: (error: Error) =>
      toast.error(`恢复跟随全局失败：${error.message}`),
  })

  return (
    <CardSection title='推理内核'>
      <div className='grid gap-2 text-sm sm:grid-cols-3'>
        <EngineValue label='已配置' value={status.configured} />
        <EngineValue label='解析后' value={status.resolved} />
        <EngineValue label='当前运行' value={status.active} />
      </div>
      <div className='mt-3 grid gap-2 text-sm sm:grid-cols-2'>
        <EngineValue
          label='数据面'
          value={isCodexVm(vm) ? '—' : dataplaneLabel(vm.resolved_dataplane)}
        />
      </div>
      <p className='mt-3 text-xs leading-relaxed text-muted-foreground'>
        运输固定 {HOP_TRANSPORT_LABEL}。{DATAPLANE_HINT} 本槽可在 cli-node 与
        CRAG v2 之间切换，不改其他槽、不改凭证、不删容器。舰队级 cc / crag
        legacy 仍在{' '}
        <Link to='/wrap' className='underline underline-offset-4'>
          内核页
        </Link>
        。Go HTTP 转发不再启用。
      </p>
      {canEdit && !isCodexVm(vm) ? (
        <VmSlotKernelSwitch id={id} vm={vm} />
      ) : null}
      {inherits || !canEdit ? null : (
        <Button
          className='mt-3'
          variant='outline'
          disabled={inherit.isPending || remote}
          onClick={() => inherit.mutate()}
        >
          {inherit.isPending ? '恢复中…' : '恢复跟随全局'}
        </Button>
      )}
      {remote && canEdit ? (
        <p className='mt-2 text-xs text-muted-foreground'>
          切换推理内核：{REMOTE_UNSUPPORTED_TEXT}
        </p>
      ) : null}
    </CardSection>
  )
}

function kernelLabel(vm: Vm) {
  if (
    vm.resolved_dataplane === 'crag' &&
    vm.resolved_crag_kernel_version === 'v2'
  )
    return 'CRAG v2'
  if (vm.resolved_dataplane === 'crag') return 'crag legacy'
  if (vm.resolved_dataplane === 'cc') return 'cc-node'
  return 'cli-node'
}

export function VmSlotKernelSwitch({
  id,
  vm,
  flush = false,
}: {
  id: string
  vm: Vm
  flush?: boolean
}) {
  return (
    <SlotKernelSwitch
      id={id}
      vm={vm}
      remote={isRemoteVm(vm)}
      flush={flush}
    />
  )
}

function SlotKernelSwitch({
  id,
  vm,
  remote,
  flush,
}: {
  id: string
  vm: Vm
  remote: boolean
  flush: boolean
}) {
  const qc = useQueryClient()
  const [pending, setPending] = useState<'wrap' | 'v2' | null>(null)
  const kvm = vm.runtime_type === 'kvm'
  const blocked = remote || kvm
  const onV2 =
    vm.resolved_dataplane === 'crag' && vm.resolved_crag_kernel_version === 'v2'
  const onCli =
    vm.resolved_dataplane == null || vm.resolved_dataplane === 'wrap'
  const switchKernel = useMutation({
    mutationFn: (next: 'wrap' | 'v2') =>
      patchVm(
        id,
        next === 'v2'
          ? { dataplane: 'crag', crag_kernel_version: 'v2' }
          : { dataplane: 'wrap', crag_kernel_version: '' }
      ),
    onSuccess: async (_data, next) => {
      toast.success(
        next === 'v2' ? '本槽已切到 CRAG v2' : '本槽已切回 cli-node'
      )
      setPending(null)
      await Promise.all([
        qc.invalidateQueries({ queryKey: vmQueryOptions(id).queryKey }),
        qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
      ])
    },
    onError: (error: Error) => {
      toast.error(error.message)
      setPending(null)
    },
  })
  return (
    <div className={flush ? 'space-y-2' : 'mt-3 space-y-2'}>
      <div className='flex flex-wrap gap-2'>
        <Button
          variant='outline'
          disabled={blocked || switchKernel.isPending || onCli}
          onClick={() => setPending('wrap')}
        >
          本槽切回 cli-node
        </Button>
        <Button
          variant='outline'
          disabled={blocked || switchKernel.isPending || onV2}
          onClick={() => setPending('v2')}
        >
          本槽切到 CRAG v2
        </Button>
      </div>
      <p className='text-xs text-muted-foreground'>
        当前 {kernelLabel(vm)}。只改这一槽。cli-node 留在盘上。没有 CRAG v2
        包时拒绝切换，原内核不动。
      </p>
      {blocked ? (
        <p className='text-xs text-muted-foreground'>
          {remote
            ? `CRAG v2：${REMOTE_UNSUPPORTED_TEXT}`
            : 'KVM 槽不运行 CRAG v2'}
        </p>
      ) : null}
      <ConfirmDialog
        open={pending != null}
        onOpenChange={(open) => {
          if (!open && !switchKernel.isPending) setPending(null)
        }}
        title={pending === 'v2' ? '本槽切到 CRAG v2？' : '本槽切回 cli-node？'}
        desc={
          pending === 'v2'
            ? '重启本槽内核。不 docker rm，不改凭证，不影响其他槽。cli-node 保留，可再切回。'
            : '铺回 wrap kernel 和 cli-node，并重启本槽内核。CRAG v2 文件留在盘上但不再 exec。'
        }
        cancelBtnText='取消'
        confirmText='切换'
        isLoading={switchKernel.isPending}
        handleConfirm={() => {
          if (pending) switchKernel.mutate(pending)
        }}
      />
    </div>
  )
}

function CardSection({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  return (
    <section className='rounded-md border p-4'>
      <h3 className='mb-3 text-sm font-medium'>{title}</h3>
      {children}
    </section>
  )
}

function EngineValue({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className='text-xs text-muted-foreground'>{label}</div>
      <div className='mt-1 font-medium'>{value}</div>
    </div>
  )
}
