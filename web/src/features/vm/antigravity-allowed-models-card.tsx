import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import {
  AntigravityModelSync,
  type AntigravityModelCatalog,
} from './antigravity-model-sync'
import { vmQueryOptions } from './queries'
import { useVmPerms } from './vm-perms'

function canonical(id: string) {
  return id
    .replace(/^antigravity\//i, '')
    .replace(/-(?:minimal|low|medium|high)$/i, '')
    .toLowerCase()
}

export function AntigravityAllowedModelsCard({ vm }: { vm: Vm }) {
  const perms = useVmPerms()
  const qc = useQueryClient()
  const status = useQuery({
    queryKey: ['panel', 'vm', vm.id, 'antigravity'],
    queryFn: () =>
      api<{ model_catalog?: AntigravityModelCatalog | null }>(
        `/api/panel/vms/${encodeURIComponent(vm.id)}/antigravity/status`
      ),
    enabled: perms.credential || perms.test,
    retry: false,
  })
  const models = status.data?.model_catalog?.models || []
  const allowed = vm.allowed_models?.length ? vm.allowed_models : null
  const isAllowed = (id: string) =>
    !allowed || allowed.some((entry) => canonical(entry) === canonical(id))
  const save = useMutation({
    mutationFn: (next: string[] | null) =>
      api(`/api/panel/vms/${encodeURIComponent(vm.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ allowed_models: next }),
      }),
    onSuccess: () => {
      toast.success('已更新 Antigravity 模型白名单')
      void qc.invalidateQueries({ queryKey: vmQueryOptions(vm.id).queryKey })
      void qc.invalidateQueries({ queryKey: ['panel', 'vms'] })
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const toggle = (id: string, checked: boolean) => {
    const base = id.replace(/^antigravity\//i, '')
    const current = (allowed || models.map((model) => model.id)).map((entry) =>
      entry
        .replace(/^antigravity\//i, '')
        .replace(/-(?:minimal|low|medium|high)$/i, '')
    )
    const next = [
      ...new Set(
        current.filter((entry) => canonical(entry) !== canonical(base))
      ),
    ]
    if (checked) next.push(base)
    if (!next.length) {
      toast.error('请至少保留一个模型；暂停 API 请求可关闭槽位调度。')
      return
    }
    const covers = models.every((model) =>
      next.some((entry) => canonical(entry) === canonical(model.id))
    )
    save.mutate(covers ? null : next)
  }
  return (
    <Card>
      <CardHeader className='pb-2'>
        <CardTitle className='text-sm'>模型白名单</CardTitle>
      </CardHeader>
      <CardContent className='space-y-3'>
        <p className='text-xs text-muted-foreground'>
          {allowed
            ? '仅允许白名单中的账号可用模型参与调度。'
            : '未限制，使用账号模型目录与全局已启用模型的交集。'}
        </p>
        {perms.credential ? <AntigravityModelSync vmId={vm.id} /> : null}
        {!perms.admin ? (
          allowed ? (
            <p className='font-mono text-xs break-all'>{allowed.join(' · ')}</p>
          ) : null
        ) : models.length ? (
          <div className='flex flex-wrap gap-x-4 gap-y-2'>
            {models.map((model) => (
              <div key={model.id} className='flex items-center gap-2'>
                <Checkbox
                  id={`ag-slot-model-${model.id}`}
                  checked={isAllowed(model.id)}
                  disabled={save.isPending}
                  onCheckedChange={(checked) =>
                    toggle(model.id, checked === true)
                  }
                />
                <Label
                  htmlFor={`ag-slot-model-${model.id}`}
                  className='text-xs font-normal'
                >
                  {model.display_name || model.id}
                  {model.levels?.length ? ` (${model.levels.join('/')})` : ''}
                </Label>
              </div>
            ))}
          </div>
        ) : (
          <p className='text-xs text-muted-foreground'>
            先同步当前账号模型目录。
          </p>
        )}
        {perms.admin ? (
          <Button
            size='sm'
            variant='ghost'
            disabled={!allowed || save.isPending}
            onClick={() => save.mutate(null)}
          >
            全选（继承）
          </Button>
        ) : null}
      </CardContent>
    </Card>
  )
}
