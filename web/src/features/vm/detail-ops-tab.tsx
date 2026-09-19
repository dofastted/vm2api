import type { Vm, VmProxySnap } from '@/types/panel-vm'
import { type CredType, credTypeLabel } from '@/lib/cred-type'
import { isCodexVm } from '@/lib/vm-kind'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { TabsContent } from '@/components/ui/tabs'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { Field } from '@/features/vm/detail-section-primitives'
import { VmEnvironmentCard } from '@/features/vm/environment-card'

type VmOpsTabProps = {
  vm: Vm
  proxy: VmProxySnap
  officialCc: boolean
  credType: CredType
  canRefresh: boolean
  refreshBlocked: string
  savingTimezone: boolean
  onAction: (path: string, body?: unknown) => void
  onTimezoneSave: (timezone: string) => void
  onTimezoneFollowProxy: () => void
  onReset: () => void
  onDelete: () => void
}

export function VmOpsTab(props: VmOpsTabProps) {
  const {
    vm,
    proxy,
    officialCc,
    credType,
    canRefresh,
    refreshBlocked,
    savingTimezone,
    onAction,
    onTimezoneSave,
    onTimezoneFollowProxy,
    onReset,
    onDelete,
  } = props

  const gpt = isCodexVm(vm)
  return (
    <TabsContent value='ops' className='space-y-3 pt-4'>
      <Card>
        <CardHeader className='pb-2'>
          <CardTitle className='text-sm'>容器</CardTitle>
        </CardHeader>
        <CardContent className='divide-y pt-0'>
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
          onClick={() => onAction('/activate')}
        >
          设为活跃
        </Button>
        <Button size='sm' variant='outline' onClick={() => onAction('/reload')}>
          {gpt ? '重载 Codex kernel' : '重载 worker'}
        </Button>
        <Button
          size='sm'
          variant='outline'
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
                    disabled={!officialCc}
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
              {!officialCc ? (
                <TooltipContent>
                  官方初装只支持完整 OAuth 凭证，当前槽为{' '}
                  {credTypeLabel(credType)}
                </TooltipContent>
              ) : null}
            </Tooltip>
            <Button
              size='sm'
              variant='outline'
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
          <div className='flex flex-wrap gap-2'>
            <Button
              size='sm'
              variant='outline'
              onClick={() => onAction('/wrap-cli/promote')}
            >
              设为 wrap 母样本
            </Button>
            <Button
              size='sm'
              variant='outline'
              onClick={() => onAction('/wrap-cli/repair')}
            >
              从此样本重装 wrap
            </Button>
          </div>
        </>
      )}
      <Separator />
      <div className='flex flex-wrap gap-2'>
        <Button size='sm' variant='outline' onClick={onReset}>
          重置
        </Button>
        <Button size='sm' variant='destructive' onClick={onDelete}>
          删除此槽位
        </Button>
      </div>
    </TabsContent>
  )
}
