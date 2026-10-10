import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { VIEW_TITLES } from '@/config/nav'
import type { VmRoutingConfig } from '@/types/panel-routing'
import type { StatusTone } from '@/types/status'
import { ChevronRight } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { ChoiceTiles, Segmented } from '@/components/choice-tiles'
import { PageHeader } from '@/components/page-header'
import { SectionSkeleton } from '@/components/page-skeletons'
import { QueryGate } from '@/components/query-gate'
import { SettingRow } from '@/components/setting-row'
import { StatusMark } from '@/components/status-mark'
import { routingQueryOptions } from '@/features/settings/queries'
import { SaveBar } from '@/features/settings/save-bar'
import {
  TCG_WARNING,
  VM_CPU_MODEL_LABELS,
  VM_CPU_MODELS,
  VM_DISK_GB_MAX,
  VM_DISK_GB_MIN,
  VM_MEMORY_LABELS,
  VM_MEMORY_OPTIONS,
  VM_VCPU_OPTIONS,
  isCpuModel,
  isMemoryOption,
  normalizeVmConfig,
  vmConfigFieldErrors,
  type VmMemoryOption,
} from '@/features/vm/machine-spec'
import { vmCreateOptionsQueryOptions } from '@/features/vm/queries'

/*
THESIS: 规格 is the factory sheet every new slot is stamped from; the guest's own view of its hardware proves it.
OWN-WORLD: Graphite Operate console. Teal only on the save action. StatusMark is the only health language.
FIRST VIEWPORT: form groups left in decision order; right rail = host KVM state + the DMI readout the guest will see.
ANTI-PATTERN: settings soup in one card, decorative chips, hero metrics.
*/

type Draft = Record<string, unknown>

const SMBIOS_FIELDS = [
  ['manufacturer', '厂商', 'Manufacturer'],
  ['product', '型号', 'Product Name'],
  ['version', '版本', 'Version'],
  ['family', '系列', 'Family'],
] as const

function Group({
  title,
  desc,
  summary,
  forceOpen = false,
  children,
}: {
  title: string
  desc?: ReactNode
  summary: ReactNode
  /** 这一组有校验错误时展开，避免错误藏在收起的配置里。 */
  forceOpen?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (forceOpen) setOpen(true)
  }, [forceOpen])
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className='border-t first:border-t-0'
    >
      <CollapsibleTrigger className='flex w-full cursor-pointer items-baseline gap-1.5 rounded-sm py-3 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-select-border/40 data-[state=open]:[&_svg]:rotate-90'>
        <ChevronRight className='size-3.5 shrink-0 translate-y-px text-muted-foreground transition-transform duration-150' />
        <span className='text-sm font-semibold'>{title}</span>
        <span
          className={cn(
            'min-w-0 truncate text-sm font-normal text-muted-foreground tabular-nums',
            open && 'sr-only'
          )}
        >
          {summary}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className='space-y-4 pb-6'>
        {desc ? (
          <p className='max-w-[60ch] text-xs leading-relaxed text-muted-foreground'>
            {desc}
          </p>
        ) : null}
        {children}
      </CollapsibleContent>
    </Collapsible>
  )
}

function FieldError({ text }: { text?: string }) {
  if (!text) return null
  return <p className='text-xs text-[color:var(--status-bad)]'>{text}</p>
}

/** 宿主 KVM 的一句话状态：create-options 的探测是按已保存配置跑的。 */
function hostTone(
  kvm: { ok: boolean; accel: 'kvm' | 'tcg' | null } | undefined
): StatusTone {
  if (!kvm) return { key: 'kvm', text: '探测中', cls: 'none' }
  if (kvm.ok && kvm.accel === 'kvm')
    return { key: 'kvm', text: 'KVM 可用', cls: 'ok' }
  if (kvm.ok) return { key: 'kvm', text: '仅软件模拟', cls: 'caution' }
  return { key: 'kvm', text: '不可用', cls: 'bad' }
}

/** 客户机里 dmidecode / ip link 会读到的值。每槽随机的部分如实标出。 */
function GuestReadout({ cfg }: { cfg: VmRoutingConfig }) {
  const rows: [string, string, boolean?][] = [
    ...SMBIOS_FIELDS.map(
      ([key, , dmi]) => [dmi, cfg.smbios[key] || '—'] as [string, string]
    ),
    ['Serial Number', '每槽随机', true],
    ['UUID', '每槽随机', true],
    ['CPU', cfg.cpu_model],
    [
      'Memory',
      `${VM_MEMORY_LABELS[cfg.memory as VmMemoryOption] || cfg.memory} · ${cfg.vcpus} vCPU`,
    ],
    ['Disk', `${cfg.disk_gb} GB · 序列号随机`],
    ['MAC', `${cfg.mac_oui || '??:??:??'}:xx:xx:xx`],
  ]
  return (
    <dl className='grid grid-cols-[7.5rem_minmax(0,1fr)] gap-x-2 gap-y-1.5 font-mono text-xs leading-5 tabular-nums'>
      {rows.map(([k, v, random]) => (
        <div key={k} className='contents'>
          <dt className='text-muted-foreground'>{k}</dt>
          <dd
            className={cn(
              'min-w-0 break-all',
              random && 'font-sans text-muted-foreground'
            )}
          >
            {v}
          </dd>
        </div>
      ))}
    </dl>
  )
}

export function SpecsPage() {
  const routing = useQuery(routingQueryOptions())
  const options = useQuery(vmCreateOptionsQueryOptions())
  const qc = useQueryClient()
  const server = (routing.data?.vm as Draft | undefined) ?? null
  const [draft, setDraft] = useState<Draft | null>(null)
  const hydrated = useRef(false)

  // 首次拿到服务端值时落草稿；之后只在保存成功后重新对齐。
  useEffect(() => {
    if (hydrated.current || !routing.data) return
    hydrated.current = true
    setDraft(server ? { ...server } : {})
  }, [routing.data, server])

  const value = draft ?? server ?? {}
  const cfg = normalizeVmConfig(value)
  const errors = vmConfigFieldErrors({
    ...cfg,
    mac_oui: 'mac_oui' in value ? value.mac_oui : cfg.mac_oui,
    vcpus: 'vcpus' in value ? value.vcpus : cfg.vcpus,
    disk_gb: 'disk_gb' in value ? value.disk_gb : cfg.disk_gb,
  })
  const macValue =
    typeof value.mac_oui === 'string' ? value.mac_oui : cfg.mac_oui
  const diskValue =
    'disk_gb' in value && value.disk_gb != null
      ? String(value.disk_gb)
      : String(cfg.disk_gb)
  const firstError = Object.values(errors)[0]
  // 比较原始输入（MAC、磁盘可能处在非法的中间态），不比较归一后的值。
  const serverCfg = normalizeVmConfig(server)
  const dirty =
    draft !== null &&
    JSON.stringify({ ...cfg, mac_oui: macValue, disk_gb: diskValue }) !==
      JSON.stringify({ ...serverCfg, disk_gb: String(serverCfg.disk_gb) })

  function set(patch: Draft) {
    const smbiosPatch = patch.smbios
    setDraft({
      ...cfg,
      ...value,
      ...patch,
      smbios: {
        ...cfg.smbios,
        ...(typeof smbiosPatch === 'object' && smbiosPatch
          ? (smbiosPatch as Draft)
          : {}),
      },
    })
  }

  const save = useMutation({
    mutationFn: () =>
      api('/api/panel/routing', {
        method: 'PUT',
        body: JSON.stringify({ vm: { ...cfg, mac_oui: macValue.trim() } }),
      }),
    onSuccess: async () => {
      toast.success('规格已保存，之后创建的槽按此生成')
      hydrated.current = false
      setDraft(null)
      await Promise.all([
        qc.invalidateQueries({ queryKey: routingQueryOptions().queryKey }),
        qc.invalidateQueries({
          queryKey: vmCreateOptionsQueryOptions().queryKey,
        }),
      ])
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const kvm = options.data?.kvm
  const tone = hostTone(kvm)

  return (
    <PageHeader
      title={VIEW_TITLES.specs}
      description='新建槽位的默认形态与硬件。创建时可逐槽改内存、vCPU 与磁盘；已建的槽不受影响。'
    >
      <QueryGate
        loading={routing.isLoading}
        error={routing.error}
        skeleton={<SectionSkeleton titleWidth='w-24' rows={10} />}
      >
        <div className='grid max-w-6xl items-start gap-x-12 gap-y-8 lg:grid-cols-[minmax(0,1fr)_20rem]'>
          <div className='min-w-0 space-y-0'>
            <Group
              title='默认形态'
              summary={
                cfg.default_runtime === 'kvm' ? '虚拟机 (KVM)' : '容器 (Docker)'
              }
              forceOpen={!!errors.default_runtime}
              desc='导入页与快捷创建打开时预选这一项。宿主不支持 KVM 时仍回落到容器。'
            >
              <ChoiceTiles
                label='默认形态'
                value={cfg.default_runtime}
                onChange={(next) => set({ default_runtime: next })}
                choices={[
                  {
                    value: 'docker',
                    title: '容器 (Docker)',
                    detail: '共享宿主内核，秒级开机。只读下面的内存。',
                  },
                  {
                    value: 'kvm',
                    title: '虚拟机 (KVM)',
                    detail: '独立内核与下面全部硬件指纹。需宿主 /dev/kvm。',
                  },
                ]}
              />
            </Group>

            <Group
              title='资源'
              summary={`${VM_MEMORY_LABELS[cfg.memory as VmMemoryOption] || cfg.memory} · ${cfg.vcpus} vCPU · ${diskValue || '—'} GB`}
              forceOpen={!!(errors.memory || errors.vcpus || errors.disk_gb)}
              desc='内存对两种形态都生效；vCPU 与磁盘只对虚拟机生效。'
            >
              <div className='divide-y'>
                <SettingRow
                  label='内存'
                  desc={
                    cfg.memory === '256m' || cfg.memory === '512m' ? (
                      <span className='text-[color:var(--status-caution)]'>
                        低于 1G：常驻 CLI 与官方初装同时运行时可能被 OOM。
                      </span>
                    ) : (
                      '容器的内存上限，或虚拟机的内存。'
                    )
                  }
                >
                  <Segmented
                    label='默认内存'
                    value={cfg.memory as VmMemoryOption}
                    onChange={(next) => {
                      if (isMemoryOption(next)) set({ memory: next })
                    }}
                    options={VM_MEMORY_OPTIONS.map((id) => ({
                      value: id,
                      label: VM_MEMORY_LABELS[id].replace(/ ?([MG])B$/, '$1'),
                    }))}
                  />
                </SettingRow>
                <SettingRow label='vCPU' desc='1–16。'>
                  <div className='space-y-1'>
                    <Select
                      value={String(cfg.vcpus)}
                      onValueChange={(next) => set({ vcpus: Number(next) })}
                    >
                      <SelectTrigger className='w-28' aria-label='默认 vCPU'>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {VM_VCPU_OPTIONS.map((n) => (
                          <SelectItem key={n} value={String(n)}>
                            {n}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FieldError text={errors.vcpus} />
                  </div>
                </SettingRow>
                <SettingRow
                  label='磁盘'
                  desc={`${VM_DISK_GB_MIN}–${VM_DISK_GB_MAX} GB。超出部分不预占宿主空间。`}
                >
                  <div className='space-y-1'>
                    <div className='flex items-center gap-1.5'>
                      <Input
                        className='w-28 tabular-nums'
                        type='number'
                        min={VM_DISK_GB_MIN}
                        max={VM_DISK_GB_MAX}
                        value={diskValue}
                        onChange={(e) => {
                          const raw = e.target.value
                          set({ disk_gb: raw === '' ? raw : Number(raw) })
                        }}
                        aria-invalid={!!errors.disk_gb}
                        aria-label='默认磁盘 GB'
                      />
                      <span className='text-sm text-muted-foreground'>GB</span>
                    </div>
                    <FieldError text={errors.disk_gb} />
                  </div>
                </SettingRow>
              </div>
            </Group>

            <Group
              title='硬件指纹'
              summary={`${isCpuModel(cfg.cpu_model) ? VM_CPU_MODEL_LABELS[cfg.cpu_model] : cfg.cpu_model} · ${macValue || '—'}`}
              forceOpen={!!(errors.cpu_model || errors.mac_oui)}
              desc='只对虚拟机生效。写进客户机的 CPU 型号与 DMI；序列号、UUID、MAC 后三字节与磁盘序列号每槽另行随机。'
            >
              <div className='divide-y'>
                <SettingRow
                  label='CPU 型号'
                  desc='host 把宿主 CPU 原样透传，软件模拟下按 max 处理。'
                >
                  <Select
                    value={cfg.cpu_model}
                    onValueChange={(next) => {
                      if (isCpuModel(next)) set({ cpu_model: next })
                    }}
                  >
                    <SelectTrigger className='w-56' aria-label='CPU 型号'>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {VM_CPU_MODELS.map((id) => (
                        <SelectItem key={id} value={id}>
                          {VM_CPU_MODEL_LABELS[id]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </SettingRow>
                <SettingRow
                  label='MAC 前缀'
                  desc='三字节十六进制，组播位须为 0。'
                >
                  <div className='space-y-1'>
                    <Input
                      className='w-36 font-mono tabular-nums'
                      placeholder='52:54:00'
                      value={macValue}
                      onChange={(e) => set({ mac_oui: e.target.value })}
                      aria-invalid={!!errors.mac_oui}
                      aria-label='MAC 前缀'
                    />
                    <FieldError text={errors.mac_oui} />
                  </div>
                </SettingRow>
              </div>
              <div className='grid gap-3 pt-1 sm:grid-cols-2'>
                {SMBIOS_FIELDS.map(([key, label]) => (
                  <div key={key} className='space-y-1.5'>
                    <Label htmlFor={`spec-smbios-${key}`}>SMBIOS {label}</Label>
                    <Input
                      id={`spec-smbios-${key}`}
                      value={cfg.smbios[key]}
                      maxLength={64}
                      onChange={(e) =>
                        set({ smbios: { [key]: e.target.value } })
                      }
                    />
                  </div>
                ))}
              </div>
            </Group>

            <Group
              title='软件模拟'
              summary={cfg.allow_tcg ? '允许 TCG' : '关闭'}
            >
              <div className='divide-y'>
                <SettingRow
                  label='允许 TCG'
                  desc='宿主没有 /dev/kvm 时用 QEMU 纯软件跑虚拟机。开机要几分钟，只用于测试。'
                >
                  <Switch
                    checked={cfg.allow_tcg}
                    onCheckedChange={(checked) => set({ allow_tcg: checked })}
                    aria-label='允许 TCG 软件模拟'
                  />
                </SettingRow>
              </div>
              {cfg.allow_tcg ? (
                <p className='text-xs text-[color:var(--status-caution)]'>
                  {TCG_WARNING}
                </p>
              ) : null}
            </Group>
          </div>

          <aside className='space-y-6 lg:sticky lg:top-20'>
            <section className='space-y-2'>
              <h4 className='text-xs font-medium text-muted-foreground'>
                本机宿主
              </h4>
              <div className='flex items-center gap-2'>
                <StatusMark tone={tone} variant='pill' />
              </div>
              <p className='text-xs leading-relaxed text-muted-foreground'>
                {!kvm
                  ? '正在探测 /dev/kvm…'
                  : kvm.ok && kvm.accel === 'kvm'
                    ? '有 /dev/kvm，虚拟机走硬件加速。'
                    : kvm.ok
                      ? '没有 /dev/kvm，已允许 TCG 软件模拟。'
                      : kvm.error || '没有 /dev/kvm，只能创建容器。'}
              </p>
              <p className='text-xs leading-relaxed text-muted-foreground'>
                集群节点在创建时单独预检。
              </p>
            </section>
            <section className='space-y-3 border-t pt-5'>
              <div className='space-y-0.5'>
                <h4 className='text-xs font-medium text-muted-foreground'>
                  客户机读到的硬件
                </h4>
                <p className='text-xs text-muted-foreground'>
                  按当前草稿预览 dmidecode 与网卡。
                </p>
              </div>
              <GuestReadout cfg={{ ...cfg, mac_oui: macValue }} />
            </section>
          </aside>
        </div>
      </QueryGate>
      {dirty ? (
        <SaveBar
          blockedReason={firstError}
          saving={save.isPending}
          onSave={() => save.mutate()}
          onDiscard={() => setDraft(server ? { ...server } : {})}
        />
      ) : null}
    </PageHeader>
  )
}
