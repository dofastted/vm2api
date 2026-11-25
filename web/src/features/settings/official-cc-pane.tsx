import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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

type OfficialCcConfig = Record<string, unknown>

const TIMEOUTS: [number, string][] = [
  [30000, '30 秒'],
  [60000, '1 分钟'],
  [120000, '2 分钟'],
  [240000, '4 分钟'],
  [480000, '8 分钟'],
  [900000, '15 分钟'],
]

const MEMORY: [string, string][] = [
  ['250m', '250 MB'],
  ['500m', '500 MB（推荐）'],
  ['512m', '512 MB'],
  ['1g', '1 GB'],
  ['2g', '2 GB'],
  ['4g', '4 GB'],
  ['8g', '8 GB'],
]

const BASIC: [string, string, string, boolean][] = [
  ['enabled', '换票后自动', '启用', true],
  [
    'sync_telemetry',
    '发布原生遥测策略',
    '只同步已保存的 telemetry_disabled，不把环境变量 0 当成开启',
    false,
  ],
]

const ADVANCED: [string, string, string][] = [
  ['wipe', '清空初装', '每次换票清空'],
  ['apply_seed', '后置播种', 'init 之后覆写'],
  ['reconcile_fingerprint', '官方指纹', 'machineID 覆盖 device_id'],
]

function SwitchRow({
  id,
  label,
  hint,
  checked,
  onChange,
}: {
  id: string
  label: string
  hint: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className='flex items-center justify-between gap-3 py-1.5'>
      <div className='min-w-0'>
        <Label htmlFor={id} className='text-sm font-normal'>
          {label}
        </Label>
        <p className='text-xs text-muted-foreground'>{hint}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  )
}

export function OfficialCcSettingsPane({
  config,
  onChange,
}: {
  config: OfficialCcConfig
  onChange: (next: OfficialCcConfig) => void
}) {
  const set = (patch: OfficialCcConfig) => onChange({ ...config, ...patch })
  const timeout = Number(config.timeout_ms ?? 240000)
  const memory = String(config.memory ?? '500m')
  const timeouts = TIMEOUTS.some(([v]) => v === timeout)
    ? TIMEOUTS
    : [
        ...TIMEOUTS,
        [timeout, `${Math.round(timeout / 1000)} 秒`] as [number, string],
      ]

  return (
    <Card>
      <CardHeader className='pb-2'>
        <CardTitle className='text-sm'>官方 Claude Code 初装</CardTitle>
      </CardHeader>
      <CardContent className='space-y-3'>
        <p className='text-xs text-muted-foreground'>
          这是槽位的初装流程配置。启用后换票会执行官方 hello，保留已有 VM
          身份、settings 与原生队列，不把重新授权当作新设备。运输固定 Rust
          cli-hop，这里不能改成 HTTP；真正运行 CLI 的数据面仍按当前配置选择。
          「发布原生遥测策略」只同步已保存的 telemetry_disabled，不读取
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC，不开启已关闭的遥测，不改写凭据，
          也不为遥测重启 VM。hello、/usage、指纹和内存设置与这个开关无关。
        </p>

        <div className='divide-y'>
          {BASIC.map(([key, label, hint, defaultOn]) => (
            <SwitchRow
              key={key}
              id={`occ-${key}`}
              label={label}
              hint={hint}
              checked={defaultOn ? config[key] !== false : config[key] === true}
              onChange={(v) => set({ [key]: v })}
            />
          ))}
          <SwitchRow
            id='occ-resident'
            label='hello 后常驻'
            hint='默认关。打开后单次 hello 不退出'
            checked={config.resident === true}
            onChange={(v) => set({ resident: v })}
          />
        </div>

        <Collapsible>
          <CollapsibleTrigger className='text-sm text-muted-foreground hover:text-foreground'>
            高级设置
          </CollapsibleTrigger>
          <CollapsibleContent className='space-y-3 pt-3'>
            <div className='divide-y'>
              {ADVANCED.map(([key, label, hint]) => (
                <SwitchRow
                  key={key}
                  id={`occ-${key}`}
                  label={label}
                  hint={hint}
                  checked={config[key] !== false}
                  onChange={(v) => set({ [key]: v })}
                />
              ))}
            </div>

            <div className='space-y-1.5'>
              <Label htmlFor='occ-hello'>hello 提示词</Label>
              <Input
                id='occ-hello'
                maxLength={200}
                placeholder='hello'
                value={String(config.hello_prompt ?? 'hello')}
                onChange={(e) => set({ hello_prompt: e.target.value })}
                onBlur={(e) => {
                  if (!e.target.value.trim()) set({ hello_prompt: 'hello' })
                }}
              />
            </div>

            <div className='grid gap-3 sm:grid-cols-2'>
              <div className='space-y-1.5'>
                <Label htmlFor='occ-timeout'>单轮超时</Label>
                <Select
                  value={String(timeout)}
                  onValueChange={(v) => set({ timeout_ms: Number(v) })}
                >
                  <SelectTrigger id='occ-timeout'>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {timeouts.map(([v, l]) => (
                      <SelectItem key={v} value={String(v)}>
                        {l}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className='space-y-1.5'>
                <Label htmlFor='occ-memory'>初装内存</Label>
                <Select
                  value={memory}
                  onValueChange={(v) => set({ memory: v })}
                >
                  <SelectTrigger id='occ-memory'>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MEMORY.map(([v, l]) => (
                      <SelectItem key={v} value={v}>
                        {l}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <p className='text-xs text-muted-foreground'>
              运输固定 cli-hop，跟 inference.engine=rust。保存不会把
              official_cc.inference 写成 http。三种内核搭配在内核页切换。hello
              之后在槽内跑 CLI /usage，失败重试 2 次；优先取官方 OAuth profile
              等级，缺失时按完整官方 usage 推断。hello 默认不常驻。
            </p>
          </CollapsibleContent>
        </Collapsible>
      </CardContent>
    </Card>
  )
}
