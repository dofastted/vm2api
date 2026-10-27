import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import {
  BarChart3,
  Download,
  LifeBuoy,
  Link2,
  MoreHorizontal,
  Play,
  RefreshCw,
  RotateCcw,
  Star,
  Trash2,
  Undo2,
  UserRoundPlus,
} from 'lucide-react'
import { canRefreshCredential, credTypeOf } from '@/lib/cred-type'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { meQueryOptions } from '@/features/auth/queries'
import { restrictionTitle } from '@/features/vm/clear-restriction'
import { useVmActions } from '@/features/vm/vm-actions-context'
import { canReclaimVm } from '@/features/vm/vm-owner'
import { VmPackageDialog } from '@/features/vm/vm-package-dialog'
import { isActiveVmPointer } from '@/features/vm/active-vm'
import { useVmPerms } from '@/features/vm/vm-perms'

/** 无法刷新时给出原因，与详情页 refreshBlocked 文案一致。 */
export function refreshBlockedReason(vm: Vm): string {
  if (canRefreshCredential(vm)) return ''
  return credTypeOf(vm) === 'apikey'
    ? 'Console API Key 不能刷新'
    : '没有 refresh 令牌，无法刷新'
}

/**
 * 行尾扩展菜单：测试链接 / 查看统计 / 重新授权 / 刷新令牌 / 恢复状态 / 恢复服务，
 * 破坏性操作（重置、删除）收在分隔线之后。
 */
export function VmActionMenu({
  vm,
  className,
}: {
  vm: Vm
  className?: string
}) {
  const actions = useVmActions()
  const me = useQuery(meQueryOptions())
  const [packOpen, setPackOpen] = useState(false)
  const blocked = refreshBlockedReason(vm)
  const restricted = restrictionTitle(vm)
  const admin = me.data?.role === 'admin'
  const perms = useVmPerms()
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size='icon'
            variant='ghost'
            className={cn('size-7 text-muted-foreground', className)}
            aria-label={`更多操作 ${vm.id}`}
            onClick={(e) => e.stopPropagation()}
          >
            <MoreHorizontal className='size-4' />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align='end'
          className='w-44'
          onClick={(e) => e.stopPropagation()}
        >
          {perms.test ? (
            <DropdownMenuItem onSelect={() => actions.openTest(vm)}>
              <Play className='text-[color:var(--status-ok)]' />
              测试链接
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onSelect={() => actions.openStats(vm)}>
            <BarChart3 className='text-[color:var(--tier-pro-solid)]' />
            查看统计
          </DropdownMenuItem>
          {perms.credential ? (
            <>
              <DropdownMenuItem onSelect={() => actions.openReauth(vm)}>
                <Link2 />
                重新授权
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={Boolean(blocked) || actions.refreshingId === vm.id}
                title={blocked || undefined}
                onSelect={() => actions.refreshToken(vm)}
              >
                <RefreshCw />
                刷新令牌
              </DropdownMenuItem>
            </>
          ) : null}
          {admin ? (
            <DropdownMenuItem onSelect={() => setPackOpen(true)}>
              <Download />
              打包 JSON
            </DropdownMenuItem>
          ) : null}
          {admin && actions.openAssignOwner ? (
            <DropdownMenuItem
              disabled={actions.ownerBusyId === vm.id}
              onSelect={() => actions.openAssignOwner?.(vm)}
            >
              <UserRoundPlus />
              分配给租户
            </DropdownMenuItem>
          ) : null}
          {admin && actions.reclaimOwner && canReclaimVm(vm) ? (
            <DropdownMenuItem
              disabled={actions.ownerBusyId === vm.id}
              onSelect={() => actions.reclaimOwner?.(vm)}
            >
              <Undo2 />
              收回
            </DropdownMenuItem>
          ) : null}
          {actions.activate ? (
            <DropdownMenuItem
              disabled={
                isActiveVmPointer(vm) || actions.activatingId === vm.id
              }
              title={
                isActiveVmPointer(vm)
                  ? '已是当前活跃槽'
                  : '写入 vms/active.json，面板默认接口指向此槽'
              }
              onSelect={() => actions.activate?.(vm)}
            >
              <Star />
              设为活跃
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={!restricted || actions.recoveringId === vm.id}
            title={restricted ?? '当前没有冷却或熔断'}
            onSelect={() => actions.recover(vm)}
          >
            <RotateCcw />
            恢复状态
          </DropdownMenuItem>
          {perms.power ? (
            <DropdownMenuItem onSelect={() => actions.openRecovery(vm)}>
              <LifeBuoy />
              恢复服务
            </DropdownMenuItem>
          ) : null}
          {actions.reset || actions.remove ? <DropdownMenuSeparator /> : null}
          {actions.reset ? (
            <DropdownMenuItem onSelect={() => actions.reset?.(vm)}>
              <RotateCcw />
              重置槽位
            </DropdownMenuItem>
          ) : null}
          {actions.remove ? (
            <DropdownMenuItem
              variant='destructive'
              onSelect={() => actions.remove?.(vm)}
            >
              <Trash2 />
              删除
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {admin ? (
        <VmPackageDialog
          vmId={vm.id}
          open={packOpen}
          onOpenChange={setPackOpen}
        />
      ) : null}
    </>
  )
}
