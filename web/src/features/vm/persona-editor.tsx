import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { Vm } from '@/types/panel-vm'
import { toast } from 'sonner'
import { patchVm } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { dashboardQueryOptions } from '@/features/overview/queries'
import {
  normalizeSlotPersonaPreset,
  slotPersonaLabel,
  slotPersonaPatchValue,
} from '@/features/vm/persona-contract'
import { vmQueryOptions } from '@/features/vm/queries'
import { useVmPerms } from '@/features/vm/vm-perms'

export function VmPersonaEditor({ id, vm }: { id: string; vm: Vm }) {
  const qc = useQueryClient()
  const configured = normalizeSlotPersonaPreset(vm.persona_preset)
  const resolved = normalizeSlotPersonaPreset(
    vm.resolved_persona_preset,
    configured
  )
  const inherits = configured === 'inherit'
  const canEdit = useVmPerms().admin
  const inherit = useMutation({
    mutationFn: () =>
      patchVm(id, { persona_preset: slotPersonaPatchValue('inherit') }),
    onSuccess: async () => {
      toast.success('出站协议已改为跟随 system提示词')
      await Promise.all([
        qc.invalidateQueries({ queryKey: vmQueryOptions(id).queryKey }),
        qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
      ])
    },
    onError: (error: Error) =>
      toast.error(`恢复跟随全局失败：${error.message}`),
  })

  return (
    <section className='rounded-lg border bg-card p-4'>
      <h3 className='text-sm font-medium'>出站协议</h3>
      <div className='mt-3 grid gap-2 text-sm sm:grid-cols-2'>
        <div>
          <div className='text-xs text-muted-foreground'>已配置</div>
          <div>{slotPersonaLabel(configured)}</div>
        </div>
        <div>
          <div className='text-xs text-muted-foreground'>实际生效</div>
          <div>{slotPersonaLabel(resolved)}</div>
        </div>
      </div>
      <p className='mt-3 text-xs leading-relaxed text-muted-foreground'>
        {vm.resolved_dataplane === 'crag' &&
        vm.resolved_crag_kernel_version === 'v2' ? (
          <>
            本槽是 CRAG v2 print，不读 kernel.json 的
            persona_preset。实际送出是「
            {vm.resolved_crag_print_persona === 'zero'
              ? '0注入 replace'
              : '只 append 调用方尾巴'}
            」。方案在{' '}
            <Link to='/system' className='underline underline-offset-4'>
              system提示词
            </Link>{' '}
            的 CRAG 一套里改。槽位显式 0注入走 replace；其它档不贴 cli-node
            模板。
          </>
        ) : (
          <>
            方案只在{' '}
            <Link to='/system' className='underline underline-offset-4'>
              system提示词
            </Link>{' '}
            的 cli-node
            一套里改。槽位覆盖会盖掉全局方案，这是上次第三方请求没带上官方完整提示词的原因。
          </>
        )}
      </p>
      {inherits || !canEdit ? null : (
        <Button
          className='mt-3'
          variant='outline'
          disabled={inherit.isPending}
          onClick={() => inherit.mutate()}
        >
          {inherit.isPending ? '恢复中…' : '恢复跟随全局'}
        </Button>
      )}
    </section>
  )
}
