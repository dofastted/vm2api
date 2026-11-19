import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { credTypeOf } from '@/lib/cred-type'
import { importErrorMessage } from '@/lib/import-errors'
import { isClaudeVm } from '@/lib/vm-kind'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { dashboardQueryOptions } from '@/features/overview/queries'
import { vmQueryOptions } from '@/features/vm/queries'
import { useVmPerms } from '@/features/vm/vm-perms'

export type ConvertOauthResult = {
  official_cc_bootstrap?: { scheduled?: boolean; reason?: string } | null
  oauth_email?: string
}

export function ConvertOauthToSetupButton({
  vm,
  onCommitted,
}: {
  vm: Vm
  onCommitted?: (data: ConvertOauthResult, vmId: string, what: string) => void
}) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const perms = useVmPerms()
  const convert = useMutation({
    mutationFn: () =>
      api<ConvertOauthResult>(
        `/api/panel/vms/${encodeURIComponent(vm.id)}/oauth/to-setup-token`,
        { method: 'POST', body: '{}' }
      ),
    onSuccess: async (data) => {
      setOpen(false)
      await Promise.all([
        qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
        qc.invalidateQueries({ queryKey: vmQueryOptions(vm.id).queryKey }),
      ])
      const what = '已转为 Setup Token'
      if (onCommitted) onCommitted(data, vm.id, what)
      else toast.success(what)
    },
    onError: (e: Error) => toast.error(importErrorMessage(e)),
  })

  if (!perms.credential || !isClaudeVm(vm) || credTypeOf(vm) !== 'oauth') {
    return null
  }

  return (
    <>
      <Button
        size='sm'
        variant='outline'
        disabled={convert.isPending}
        loading={convert.isPending}
        onClick={() => setOpen(true)}
      >
        {convert.isPending ? '转换中…' : '转为 Setup Token'}
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title='转为 Setup Token'
        desc='保留当前 access token、refresh token、真实过期时间及全部已授权 scope。仅切换为 Setup Token 运行模式，不跑官方初装；不会增加或删减 profile / usage 权限。'
        confirmText='确认转换'
        cancelBtnText='取消'
        isLoading={convert.isPending}
        handleConfirm={() => convert.mutate()}
      />
    </>
  )
}
