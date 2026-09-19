import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { importErrorMessage } from '@/lib/import-errors'
import { validTimezone } from '@/lib/timezone'
import { nextVmSeq, vmIdOf, vmNameOf } from '@/lib/vm-name'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { dashboardQueryOptions } from '@/features/overview/queries'
import {
  KERNELS,
  VM_CONCURRENCY_OPTIONS,
  VM_CREATE_AFTER,
  VM_LOCALES,
  VM_REGION_AUTO,
  VM_REGIONS,
  VM_TEMPLATES,
  VM_WEIGHT_OPTIONS,
} from '@/features/vm/create-options'
import { KernelFeatTags } from '@/features/vm/kernel-feat-tags'
import { TimezonePicker } from '@/features/vm/timezone-picker'

/** 「之后」的 5 档，对齐 index.html `createVmFromPage()` 的派生逻辑。 */
export type CreateVmAfter = 'idle' | 'start' | 'proxy' | 'active' | 'full'

const DEFAULT_TEMPLATE = VM_TEMPLATES[0]

type CreateVmResponse = {
  id?: string
  vm_id?: string
  vm?: { id?: string }
}

/**
 * 「之后」→ 三个布尔的派生。index.html `createVmFromPage()`:
 *   start = after !== 'idle'
 *   auto_allocate_proxy = after === 'proxy' || after === 'full'
 *   activate = after === 'active' || after === 'full'
 */
function deriveAfter(after: string) {
  return {
    start: after !== 'idle',
    auto_allocate_proxy: after === 'proxy' || after === 'full',
    activate: after === 'active' || after === 'full',
  }
}

export type CreateVmFieldsProps = {
  /**
   * 「之后」的固定档位。传入时该档位被钉住（切模板不会覆盖），对齐 index.html
   * `applyVmTemplate()` 里 `state.view === 'import'` 的分支语义。不传则跟随模板预设。
   */
  defaultAfter?: CreateVmAfter
  /** 创建成功后回调，参数是实际创建到的槽位 id。 */
  onCreated?: (id: string) => void
  /** 传入则在提交按钮左侧渲染一个「取消」按钮（弹窗形态用）。 */
  onCancel?: () => void
  submitLabel?: string
}

/**
 * 创建槽位的字段集 + 提交逻辑。不含弹窗外壳 —— 导入向导 / 集群页 / 槽位页共用。
 * 创建不再提交 seed_policy 或槽内 SOCKS5；出口由外层透明转发，种子用网关 standard 默认。
 */
export function CreateVmFields({
  defaultAfter,
  onCreated,
  onCancel,
  submitLabel = '创建',
}: CreateVmFieldsProps) {
  const qc = useQueryClient()
  const dash = useQuery(dashboardQueryOptions())
  const vms = dash.data?.vms || []

  const [template, setTemplate] = useState<string>(DEFAULT_TEMPLATE.id)
  const [name, setName] = useState('')
  const [kernel, setKernel] = useState<string>(DEFAULT_TEMPLATE.kernel)
  const [after, setAfter] = useState<string>(
    defaultAfter || DEFAULT_TEMPLATE.after
  )
  const [region, setRegion] = useState<string>(
    DEFAULT_TEMPLATE.region || VM_REGION_AUTO
  )
  const [tz, setTz] = useState<string>(DEFAULT_TEMPLATE.tz)
  const [locale, setLocale] = useState<string>(DEFAULT_TEMPLATE.locale)
  const [conc, setConc] = useState<number>(DEFAULT_TEMPLATE.conc)
  const [weight, setWeight] = useState<number>(DEFAULT_TEMPLATE.weight)
  const [advOpen, setAdvOpen] = useState(false)

  // 名称留空时按已占用序号推下一个可用值，仅作为 placeholder 提示与提交兜底。
  const suggested = vmNameOf(nextVmSeq(vms))
  const effectiveName = name.trim() || suggested

  /** 切模板：回填内核/区域/时区/语言/并发/权重与「之后」，对齐 `applyVmTemplate()`。 */
  function applyTemplate(id: string) {
    const tpl = VM_TEMPLATES.find((x) => x.id === id) || DEFAULT_TEMPLATE
    setTemplate(tpl.id)
    setKernel(tpl.kernel)
    // 宿主钉死了「之后」（导入向导）时不跟模板走，其余场景用模板预设。
    setAfter(defaultAfter || tpl.after)
    setRegion(tpl.region || VM_REGION_AUTO)
    setTz(tpl.tz)
    setLocale(tpl.locale)
    setConc(tpl.conc)
    setWeight(tpl.weight)
  }

  const create = useMutation({
    mutationFn: async () => {
      // legacy 的名称是数字下拉，`vmIdOf` 必定有值；这里是自由文本，纯非 ASCII
      // 名称（如「测试槽」）会被清洗成空串 —— 那就干脆不发 id，让后端自动编号。
      const id = vmIdOf(effectiveName) || undefined
      const data = await api<CreateVmResponse>('/api/panel/vms/create', {
        method: 'POST',
        body: JSON.stringify({
          id,
          name: effectiveName,
          kernel,
          timezone: tz.trim(),
          locale,
          // 「自动」是纯 UI 哨兵值，不发给后端（对齐 index.html 的 `region || undefined`）。
          region: region === VM_REGION_AUTO ? undefined : region,
          max_concurrency: conc,
          weight,
          ...deriveAfter(after),
          platform: 'anthropic',
          family: 'claude',
        }),
      })
      return data.id || data.vm_id || data.vm?.id || id || ''
    },
    onSuccess: async (created) => {
      toast.success(created ? `已创建 ${created}` : '已创建')
      setName('')
      await qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey })
      // 拿不到 id 时不回调：导入向导会把它当成 `setVmId('')`，反而把已选中的槽清掉。
      if (created) onCreated?.(created)
    },
    onError: (error: Error) => toast.error(importErrorMessage(error)),
  })

  return (
    <div className='space-y-3'>
      <div className='space-y-1'>
        <Label>模板</Label>
        <Select value={template} onValueChange={applyTemplate}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {VM_TEMPLATES.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {t.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className='space-y-1'>
        <Label>名称</Label>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={suggested}
        />
      </div>

      <div className='space-y-1'>
        <Label>内核</Label>
        <Select value={kernel} onValueChange={setKernel}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {KERNELS.map((k) => (
              <SelectItem key={k.id} value={k.id}>
                {k.name} · {k.size}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <KernelFeatTags kernel={kernel} className='flex flex-wrap gap-1 pt-1' />
      </div>

      <div className='space-y-1'>
        <Label>之后</Label>
        <Select value={after} onValueChange={setAfter}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {VM_CREATE_AFTER.map(([v, l]) => (
              <SelectItem key={v} value={v}>
                {l}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Collapsible open={advOpen} onOpenChange={setAdvOpen}>
        <CollapsibleTrigger className='text-sm text-primary hover:underline'>
          高级 {advOpen ? '▴' : '▾'}
        </CollapsibleTrigger>
        <CollapsibleContent className='grid gap-3 pt-3 sm:grid-cols-2'>
          <div className='space-y-1'>
            <Label>区域</Label>
            <Select value={region} onValueChange={setRegion}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {VM_REGIONS.map(([v, l]) => (
                  <SelectItem key={v} value={v}>
                    {l}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className='space-y-1'>
            <Label>时区</Label>
            <TimezonePicker value={tz} onChange={setTz} />
          </div>
          <div className='space-y-1'>
            <Label>语言</Label>
            <Select value={locale} onValueChange={setLocale}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {VM_LOCALES.map(([v, l]) => (
                  <SelectItem key={v} value={v}>
                    {l}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className='space-y-1'>
            <Label>并发</Label>
            <Select
              value={String(conc)}
              onValueChange={(v) => setConc(Number(v))}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {VM_CONCURRENCY_OPTIONS.map((v) => (
                  <SelectItem key={v} value={String(v)}>
                    {v}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className='space-y-1'>
            <Label>权重</Label>
            <Select
              value={String(weight)}
              onValueChange={(v) => setWeight(Number(v))}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {VM_WEIGHT_OPTIONS.map((v) => (
                  <SelectItem key={v} value={String(v)}>
                    {v}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CollapsibleContent>
      </Collapsible>

      <div className='flex items-center justify-end gap-2 pt-1'>
        {create.error ? (
          <p className='me-auto text-xs text-[color:var(--status-bad)]'>
            {importErrorMessage(create.error)}
          </p>
        ) : null}
        {onCancel ? (
          <Button variant='outline' onClick={onCancel}>
            取消
          </Button>
        ) : null}
        <Button
          onClick={() => create.mutate()}
          disabled={create.isPending || !validTimezone(tz)}
          loading={create.isPending}
        >
          {submitLabel}
        </Button>
      </div>
    </div>
  )
}

/** `CreateVmFields` 的弹窗外壳，给集群页 / 槽位列表页用。 */
export function CreateVmDialog({
  open,
  onOpenChange,
  defaultAfter,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  defaultAfter?: CreateVmAfter
  onCreated?: (id: string) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>创建槽位</DialogTitle>
        </DialogHeader>
        <CreateVmFields
          defaultAfter={defaultAfter}
          onCancel={() => onOpenChange(false)}
          onCreated={(id) => {
            onOpenChange(false)
            onCreated?.(id)
          }}
        />
      </DialogContent>
    </Dialog>
  )
}
