import { useState } from 'react'
import type { Vm, VmProxySnap } from '@/types/panel-vm'
import { type CredType, credTypeLabel } from '@/lib/cred-type'
import { isCodexVm } from '@/lib/vm-kind'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Separator } from '@/components/ui/separator'
import { TabsContent } from '@/components/ui/tabs'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { ChoiceTiles } from '@/components/choice-tiles'
import { Field } from '@/features/vm/detail-section-primitives'
import { VmEnvironmentCard } from '@/features/vm/environment-card'
import { NodeChip } from '@/features/vm/node-chip'
import { VmPhysicalFeaturesCard } from '@/features/vm/physical-features-card'
import { isActiveVmPointer } from '@/features/vm/active-vm'
import { isRemoteVm, REMOTE_UNSUPPORTED_TEXT } from '@/features/vm/placement'
import { VmOwnerAdminCard } from '@/features/vm/vm-owner-admin-card'
import { VmShellCard } from '@/features/vm/vm-shell-card'

type VmOpsTabProps = {
  vm: Vm
  proxy: VmProxySnap
  officialCc: boolean
  credType: CredType
  canRefresh: boolean
  refreshBlocked: string
  savingTimezone: boolean
  onAction: (path: string, body?: unknown) => void
  /** 该路径的操作正在进行。 */
  busy: (path: string) => boolean
  /** 终端快捷指令执行后刷新详情。 */
  onRefresh: () => void
  onTimezoneSave: (timezone: string) => void
  onTimezoneFollowProxy: () => void
  onReset: () => void
  onDelete: () => void
}

export function VmOpsTab(props: VmOpsTabProps) {
  const [kernelOpen, setKernelOpen] = useState(false)
  const [kernelMode, setKernelMode] = useState<'keep' | 'traits'>('keep')
  const {
    vm,
    proxy,
    officialCc,
    credType,
    canRefresh,
    refreshBlocked,
    savingTimezone,
    onAction,
    busy,
    onRefresh,
    onTimezoneSave,
    onTimezoneFollowProxy,
    onReset,
    onDelete,
  } = props

  const gpt = isCodexVm(vm)
  const remote = isRemoteVm(vm)
  return (
    <TabsContent value='ops' className='space-y-3 pt-4'>
      <VmOwnerAdminCard vm={vm} />
      <Card>
        <CardHeader className='pb-2'>
          <CardTitle className='text-sm'>容器</CardTitle>
        </CardHeader>
        <CardContent className='divide-y pt-0'>
          <Field label='服务器'>
            <NodeChip nodeId={vm.node_id} className='text-[11px]' />
          </Field>
          <Field label='容器'>
            <span className='font-mono text-xs'>
              {String(
                (vm.runtime as Record<string, unknown> | undefined)
                  ?.container ||
                  vm.container ||
                  '—'
              )}
            </span>
          </Field>
          {(vm.runtime as Record<string, unknown> | undefined)
            ?.egress_container ? (
            <Field label='出口容器'>
              <span className='font-mono text-xs'>
                {String(
                  (vm.runtime as Record<string, unknown>).egress_container
                )}
              </span>
            </Field>
          ) : null}
          <Field label='guest'>
            <span className='font-mono text-xs'>
              {String(
                (vm.fingerprint as Record<string, unknown> | undefined)
                  ?.hostname || '未采集'
              )}
            </span>
          </Field>
        </CardContent>
      </Card>
      <VmPhysicalFeaturesCard
        vm={vm}
        collecting={busy('/collect-identity')}
        onCollect={() => onAction('/collect-identity')}
      />
      <VmEnvironmentCard
        vm={vm}
        proxy={proxy}
        saving={savingTimezone}
        onSave={onTimezoneSave}
        onFollowProxy={onTimezoneFollowProxy}
      />
      <div className='flex flex-wrap gap-2'>
        <Button
          size='sm'
          variant='outline'
          disabled={isActiveVmPointer(vm)}
          loading={busy('/activate')}
          title={
            isActiveVmPointer(vm)
              ? '已是当前活跃槽'
              : '写入 vms/active.json，面板默认接口指向此槽'
          }
          onClick={() => onAction('/activate')}
        >
          设为活跃
        </Button>
        <Button
          size='sm'
          variant='outline'
          loading={busy('/reload')}
          onClick={() => onAction('/reload')}
        >
          {gpt ? '重载 Codex kernel' : '重载 worker'}
        </Button>
        <Button
          size='sm'
          variant='outline'
          loading={busy('/collect-identity')}
          onClick={() => onAction('/collect-identity')}
        >
          采集特征
        </Button>
        {gpt ? null : (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button
                    size='sm'
                    variant='outline'
                    disabled={!officialCc || remote}
                    loading={busy('/official-cc-bootstrap')}
                    onClick={() =>
                      onAction('/official-cc-bootstrap', {
                        force: true,
                        manual: true,
                      })
                    }
                  >
                    执行官方初装
                  </Button>
                </span>
              </TooltipTrigger>
              {remote ? (
                <TooltipContent>{REMOTE_UNSUPPORTED_TEXT}</TooltipContent>
              ) : !officialCc ? (
                <TooltipContent>
                  官方初装只支持完整 OAuth 凭证，当前槽为{' '}
                  {credTypeLabel(credType)}
                </TooltipContent>
              ) : null}
            </Tooltip>
            <Button
              size='sm'
              variant='outline'
              loading={busy('/reconcile-fingerprint')}
              onClick={() => onAction('/reconcile-fingerprint', {})}
            >
              对齐官方指纹
            </Button>
          </>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <Button
                size='sm'
                variant='outline'
                disabled={!canRefresh}
                loading={busy('/oauth/refresh')}
                onClick={() => onAction('/oauth/refresh', {})}
              >
                刷新凭证
              </Button>
            </span>
          </TooltipTrigger>
          {refreshBlocked ? (
            <TooltipContent>{refreshBlocked}</TooltipContent>
          ) : null}
        </Tooltip>
      </div>
      {gpt ? null : (
        <>
          <Separator />
          <div className='flex flex-wrap items-center gap-2'>
            <Button
              size='sm'
              variant='outline'
              disabled={remote}
              loading={busy('/wrap-cli/promote')}
              onClick={() => onAction('/wrap-cli/promote')}
            >
              晋升母本
            </Button>
            <Button
              size='sm'
              variant='outline'
              loading={busy('/wrap-cli/repair')}
              onClick={() => setKernelOpen(true)}
            >
              重装 kernel
            </Button>
          </div>
        </>
      )}
      {gpt ? null : <VmShellCard vm={vm} onChanged={onRefresh} />}
      <Separator />
      <div className='flex flex-wrap gap-2'>
        <Button size='sm' variant='outline' onClick={onReset}>
          重置
        </Button>
        <Button size='sm' variant='destructive' onClick={onDelete}>
          删除此槽位
        </Button>
      </div>
      <Dialog open={kernelOpen} onOpenChange={setKernelOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>重装 kernel</DialogTitle>
          </DialogHeader>
          <ChoiceTiles
            label='更新方式'
            value={kernelMode}
            onChange={setKernelMode}
            choices={[
              {
                value: 'keep',
                title: '保留原数据重建',
                detail:
                  '留下凭证、指纹和统计，只换 kernel、cli-node 与 Go 遥测。',
              },
              {
                value: 'traits',
                title: '重建新特征',
                detail: remote
                  ? '集群槽只换镜像，不在这里清远程家目录。'
                  : '清家目录并重抽计算机身份。',
              },
            ]}
          />
          <DialogFooter>
            <Button variant='outline' onClick={() => setKernelOpen(false)}>
              取消
            </Button>
            <Button
              variant={kernelMode === 'traits' ? 'destructive' : 'default'}
              onClick={() => {
                setKernelOpen(false)
                onAction('/wrap-cli/repair', { mode: kernelMode })
              }}
            >
              {kernelMode === 'keep' ? '保留原数据重建' : '重建新特征'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TabsContent>
  )
}
