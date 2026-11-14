import { useMemo, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { Vm, VmKernelSnapshot } from '@/types/panel-vm'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { activateVmCragLicense, isApiError, patchVm } from '@/lib/api'
import { isCodexVm } from '@/lib/vm-kind'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { dashboardQueryOptions } from '@/features/overview/queries'
import {
  CragLicenseEditor,
  CragLicenseSummary,
  cragLicenseErrorMessage,
} from '@/features/vm/crag-license-editor'
import {
  kernelRouteHint,
  kernelRouteLabel,
} from '@/features/vm/dataplane-contract'
import {
  DEFAULT_RESOLVED_ENGINE,
  inferenceEngineLabel,
  inferenceEnginePatchValue,
  normalizeInferenceEngine,
} from '@/features/vm/engine-contract'
import { isRemoteVm, REMOTE_UNSUPPORTED_TEXT } from '@/features/vm/placement'
import {
  vmCragLicenseQueryOptions,
  vmQueryOptions,
  vmsListQueryOptions,
} from '@/features/vm/queries'
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
          value={
            isCodexVm(vm)
              ? '—'
              : kernelRouteLabel(
                  vm.resolved_dataplane,
                  vm.resolved_crag_kernel_version
                )
          }
        />
      </div>
      <p className='mt-3 text-xs leading-relaxed text-muted-foreground'>
        {kernelRouteLabel(
          vm.resolved_dataplane,
          vm.resolved_crag_kernel_version
        )}
        。
        {kernelRouteHint(
          vm.resolved_dataplane,
          vm.resolved_crag_kernel_version
        )}{' '}
        本槽可在 cli-node 与 CRAG v2
        之间切换。运行中切换会重启内核，必要时重建容器；保留凭证和数据，不影响其他槽。
        舰队级 cc / crag legacy 仍在{' '}
        <Link to='/wrap' className='underline underline-offset-4'>
          内核页
        </Link>
        。Go HTTP 转发不再启用。
      </p>
      {canEdit && !isCodexVm(vm) ? (
        <SlotKernelSwitch key={id} id={id} vm={vm} remote={remote} />
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
      {remote && canEdit && !inherits ? (
        <p className='mt-2 text-xs text-muted-foreground'>
          恢复跟随全局：{REMOTE_UNSUPPORTED_TEXT}
        </p>
      ) : null}
    </CardSection>
  )
}

type SlotKernelTarget = 'wrap' | 'v2'

function slotKernelLabel(next: SlotKernelTarget) {
  return next === 'v2' ? 'CRAG v2' : 'cli-node'
}

function kernelSwitchSuccess(next: SlotKernelTarget, status?: string) {
  const label = slotKernelLabel(next)
  if (status === 'stopped') {
    return `本槽内核配置已切换为 ${label}；VM 保持停止，下次启动生效。`
  }
  return `本槽已切换到 ${label}${status === 'running' ? '，内核重启完成' : ''}。`
}

function SlotKernelSwitch({
  id,
  vm,
  remote,
}: {
  id: string
  vm: Vm
  remote: boolean
}) {
  const qc = useQueryClient()
  const [pending, setPending] = useState<SlotKernelTarget | null>(null)
  const [licenseOpen, setLicenseOpen] = useState(false)
  const [switchAfterActivation, setSwitchAfterActivation] = useState(false)
  const [checkingLicense, setCheckingLicense] = useState(false)
  const [registrationCode, setRegistrationCode] = useState('')
  const switchToastId = `vm-kernel-switch-${id}`
  const kvm = ['kvm', 'qemu', 'libvirt'].includes(
    String(vm.runtime?.type || vm.runtime_type || '')
      .trim()
      .toLowerCase()
  )
  const blocked = vm.node_platform === 'darwin'
  const onV2 =
    vm.resolved_dataplane === 'crag' && vm.resolved_crag_kernel_version === 'v2'
  const onCli =
    vm.resolved_dataplane == null || vm.resolved_dataplane === 'wrap'
  const licenseQuery = useQuery({
    ...vmCragLicenseQueryOptions(id),
    enabled: !blocked,
  })
  const activateLicense = useMutation({
    // Keep the registration code out of cached mutation variables.
    mutationFn: () => activateVmCragLicense(id, registrationCode.trim()),
    onSuccess: async (data) => {
      qc.setQueryData(vmCragLicenseQueryOptions(id).queryKey, data)
      setRegistrationCode('')
      if (!data.license.valid || data.license.status !== 'valid') {
        toast.error('授权未生效，请检查下方状态并联系授权方。')
        return
      }
      toast.success('CRAG 授权已激活')
      if (switchAfterActivation && !onV2) setPending('v2')
      await Promise.all([
        qc.invalidateQueries({ queryKey: vmQueryOptions(id).queryKey }),
        qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
      ])
    },
  })

  async function requestV2() {
    setSwitchAfterActivation(true)
    setCheckingLicense(true)
    try {
      const data = await qc.fetchQuery(vmCragLicenseQueryOptions(id))
      if (data.license.valid && data.license.status === 'valid') {
        setPending('v2')
      } else {
        setLicenseOpen(true)
      }
    } catch {
      setLicenseOpen(true)
    } finally {
      setCheckingLicense(false)
    }
  }
  const switchKernel = useMutation({
    mutationFn: (next: SlotKernelTarget) =>
      patchVm(
        id,
        next === 'v2'
          ? { dataplane: 'crag', crag_kernel_version: 'v2' }
          : { dataplane: 'wrap', crag_kernel_version: '' }
      ),
    onMutate: (next) => {
      toast.loading(`正在切换到 ${slotKernelLabel(next)}…`, {
        id: switchToastId,
        description:
          vm.status === 'running'
            ? '正在重启本槽内核，请勿重复操作。'
            : '正在保存内核配置，VM 不会因此启动。',
      })
    },
    onSuccess: (_data, next) => {
      toast.success(kernelSwitchSuccess(next, vm.status), {
        id: switchToastId,
        description: undefined,
      })
      setPending(null)
    },
    onError: (error: Error) => {
      if (isApiError(error) && error.code.startsWith('license_')) {
        toast.error(cragLicenseErrorMessage(error), {
          id: switchToastId,
          description: undefined,
        })
        setLicenseOpen(true)
        setSwitchAfterActivation(true)
        void qc.invalidateQueries({
          queryKey: vmCragLicenseQueryOptions(id).queryKey,
        })
      } else {
        toast.error(`内核切换未完成：${error.message}`, {
          id: switchToastId,
          description: '请先核对当前内核、VM 运行和调度状态，再重试。',
        })
      }
      setPending(null)
    },
    // A failed restart can still persist the new policy. Refresh both outcomes.
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: vmQueryOptions(id).queryKey }),
        qc.invalidateQueries({ queryKey: vmsListQueryOptions().queryKey }),
        qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
      ]),
  })
  const target = pending ?? switchKernel.variables ?? 'wrap'
  const switchError = switchKernel.error
  const switchErrorMessage =
    isApiError(switchError) && switchError.code.startsWith('license_')
      ? cragLicenseErrorMessage(switchError)
      : switchError?.message
  const busy =
    checkingLicense || switchKernel.isPending || activateLicense.isPending
  return (
    <div className='mt-3 space-y-2'>
      <div className='flex flex-wrap gap-2'>
        <Button
          variant='outline'
          disabled={blocked || busy || onCli}
          aria-busy={switchKernel.isPending && target === 'wrap'}
          onClick={() => setPending('wrap')}
        >
          {switchKernel.isPending && target === 'wrap'
            ? '正在切回 cli-node…'
            : '本槽切回 cli-node'}
        </Button>
        <Button
          variant='outline'
          disabled={blocked || busy || onV2}
          aria-busy={
            checkingLicense || (switchKernel.isPending && target === 'v2')
          }
          onClick={() => void requestV2()}
        >
          {checkingLicense
            ? '正在检查授权…'
            : switchKernel.isPending && target === 'v2'
              ? '正在切换到 CRAG v2…'
              : '本槽切到 CRAG v2'}
        </Button>
        {!blocked ? (
          <Button
            variant='outline'
            disabled={busy}
            aria-expanded={licenseOpen}
            aria-controls={`crag-license-${id}`}
            onClick={() => {
              setSwitchAfterActivation(false)
              setLicenseOpen(!licenseOpen)
              setRegistrationCode('')
              activateLicense.reset()
            }}
          >
            CRAG 授权 / 续期
          </Button>
        ) : null}
      </div>
      {switchKernel.isPending ||
      switchKernel.isSuccess ||
      switchKernel.isError ? (
        <Alert
          role={switchKernel.isError ? 'alert' : 'status'}
          aria-live={switchKernel.isError ? 'assertive' : 'polite'}
          aria-atomic='true'
          variant={switchKernel.isError ? 'destructive' : 'default'}
        >
          {switchKernel.isPending ? (
            <Loader2
              aria-hidden='true'
              className='size-4 animate-spin motion-reduce:animate-none'
            />
          ) : null}
          <AlertTitle>
            {switchKernel.isPending
              ? `正在切换到 ${slotKernelLabel(target)}…`
              : switchKernel.isError
                ? '内核切换未完成'
                : '内核切换完成'}
          </AlertTitle>
          <AlertDescription className='break-words'>
            {switchKernel.isPending
              ? '请勿重复操作。正在等待服务端完成切换，并刷新 VM 运行和调度状态。'
              : switchKernel.isError
                ? `${switchErrorMessage} 请先核对当前内核、VM 运行和调度状态，再重试；也可在“恢复服务”中查看诊断。`
                : kernelSwitchSuccess(
                    switchKernel.variables ?? target,
                    vm.status
                  )}
          </AlertDescription>
        </Alert>
      ) : null}
      <p className='text-xs text-muted-foreground'>
        当前{' '}
        {kernelRouteLabel(
          vm.resolved_dataplane,
          vm.resolved_crag_kernel_version
        )}
        。只改这一槽。cli-node 留在盘上。没有 CRAG v2 包时拒绝切换，原内核不动。
      </p>
      {blocked ? (
        <p className='text-xs text-muted-foreground'>
          macOS 原生节点不运行 CRAG v2
        </p>
      ) : null}
      {!blocked ? (
        <div id={`crag-license-${id}`} className='min-w-0 pt-2'>
          {licenseOpen ? (
            <CragLicenseEditor
              data={licenseQuery.data}
              loading={licenseQuery.isFetching}
              loadError={licenseQuery.error}
              activationError={activateLicense.error}
              registrationCode={registrationCode}
              activating={activateLicense.isPending}
              onChange={(code) => {
                setRegistrationCode(code)
                activateLicense.reset()
              }}
              onRefresh={() => {
                void licenseQuery.refetch()
              }}
              onActivate={() => activateLicense.mutate()}
              onClose={() => {
                setLicenseOpen(false)
                setRegistrationCode('')
                setSwitchAfterActivation(false)
                activateLicense.reset()
              }}
            />
          ) : licenseQuery.isError ? (
            <p role='alert' className='text-sm text-destructive'>
              {cragLicenseErrorMessage(licenseQuery.error)} 打开“CRAG 授权 /
              续期”可重试。
            </p>
          ) : licenseQuery.data ? (
            <CragLicenseSummary license={licenseQuery.data.license} />
          ) : (
            <p role='status' className='text-sm text-muted-foreground'>
              正在读取 CRAG 授权状态…
            </p>
          )}
        </div>
      ) : null}
      <ConfirmDialog
        open={pending != null || switchKernel.isPending}
        onOpenChange={(open) => {
          if (!open && !switchKernel.isPending) setPending(null)
        }}
        title={`本槽切换到 ${slotKernelLabel(target)}？`}
        desc={
          <div className='space-y-2'>
            <p>
              {vm.status !== 'running'
                ? '仅修改本槽内核配置，VM 保持当前停机状态，下次启动生效。'
                : kvm
                  ? '切换并重启本槽内核，保留 KVM 虚拟机和磁盘。'
                  : remote
                    ? '重建本槽容器以更换内核命令，并等待内核就绪。'
                    : '切换并重启本槽内核，必要时重建容器。'}
              保留凭证和数据，不影响其他槽；原有调度关闭设置不变。
            </p>
            {switchKernel.isPending ? (
              <p role='status' aria-live='polite'>
                正在切换到 {slotKernelLabel(target)}，请勿重复操作。
              </p>
            ) : null}
          </div>
        }
        cancelBtnText='取消'
        confirmText={
          switchKernel.isPending ? (
            <>
              <Loader2
                aria-hidden='true'
                className='size-4 animate-spin motion-reduce:animate-none'
              />
              正在切换…
            </>
          ) : vm.status === 'running' ? (
            '切换并重启'
          ) : (
            '保存内核配置'
          )
        }
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
