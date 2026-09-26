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
  ['500m', '500 MB（推荐）'],
  ['512m', '512 MB'],
  ['1g', '1 GB'],
  ['2g', '2 GB'],
  ['4g', '4 GB'],
  ['8g', '8 GB'],
]

const BASIC: [string, string, string][] = [
  ['enabled', '换票后自动', '启用'],
  ['sync_telemetry', '同步遥测', '初装成功后开启'],
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
          这是槽位外面的初装配置。启用时每次换票都重新 wipe 再跑官方
          hello，不是只写票。运输固定 Rust cli-hop，这里不能改成 HTTP。真正跑
          CLI 的是数据面：默认 cli-node + kernel，也可切 cc-node + kernel 或
          crag + cc-node。成功后按「同步遥测」写官方身份，并热更新槽内
          worker.json。虚拟机页的种子开关不能单独打开 DNT 来对抗这份配置。
        </p>

        <div className='divide-y'>
          {BASIC.map(([key, label, hint]) => (
            <SwitchRow
              key={key}
              id={`occ-${key}`}
              label={label}
              hint={hint}
              checked={config[key] !== false}
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
                value={String(config.hello_prompt ?? 'hello')}
                onChange={(e) => set({ hello_prompt: e.target.value })}
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
              official_cc.inference 写成 http。三种内核搭配在设置 →
              协议或内核页切换。hello 之后在槽内跑 CLI /usage，失败重试 2
              次；账号等级以完整官方 usage 为准。hello 默认不常驻。
            </p>
          </CollapsibleContent>
        </Collapsible>
      </CardContent>
    </Card>
  )
}
