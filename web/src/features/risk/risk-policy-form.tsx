import { useEffect, useId, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { RiskAuditPolicy } from '@/types/panel-routing'
import { Check, ChevronsUpDown, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { apiEndpointsQueryOptions } from '@/features/api-endpoints/queries'
import { vmPoolsQueryOptions } from '@/features/keys/vm-pools-card'
import { modelsQueryOptions } from '@/features/models/queries'
import { Group } from './blocks'
import {
  endpointOptions,
  modelOptions,
  poolOptions,
  type PolicyOption,
} from './policy-options'

const BAN_DURATIONS = [
  [5, '5 分钟'],
  [10, '10 分钟'],
  [30, '30 分钟'],
  [60, '1 小时'],
  [360, '6 小时'],
  [1440, '24 小时'],
  [4320, '3 天'],
  [10080, '7 天'],
  [43200, '30 天'],
] as const

const TOOL_OPTIONS = [
  'Agent',
  'Bash',
  'DeferredToolPlaceholder',
  'Edit',
  'ListAgents',
  'Read',
  'ReportFindings',
  'ScheduleWakeup',
  'Skill',
  'ToolSearch',
  'Workflow',
  'Write',
].map((name) => ({ value: name, label: name }))

const TOOL_DENIAL = '请求包含当前策略禁用的工具。'

export function RiskPolicyForm({
  section,
  value,
  pending,
  onSave,
  onDirtyChange,
}: {
  section: 'preflight' | 'jev'
  value: RiskAuditPolicy
  pending: boolean
  onSave: (value: RiskAuditPolicy) => void
  onDirtyChange: (dirty: boolean) => void
}) {
  const [draft, setDraft] = useState(value)
  const isRouting = section === 'jev'
  const pools = useQuery({ ...vmPoolsQueryOptions(), enabled: isRouting })
  const endpoints = useQuery({
    ...apiEndpointsQueryOptions(),
    enabled: isRouting,
  })
  const models = useQuery({ ...modelsQueryOptions(), enabled: isRouting })
  const channels = endpoints.data?.items ?? []
  const catalog = models.data?.data ?? models.data?.items ?? []
  const dirty = JSON.stringify(draft) !== JSON.stringify(value)
  const change = <Key extends keyof RiskAuditPolicy>(
    key: Key,
    next: RiskAuditPolicy[Key]
  ) => setDraft((current) => ({ ...current, [key]: next }))

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange])

  const lastTimedBan = draft.ban_steps[draft.ban_steps.length - 2] ?? 0
  const validSteps = draft.ban_steps.every(
    (minutes, index, steps) =>
      index === steps.length - 1 ||
      (minutes > 0 && (index === 0 || minutes > steps[index - 1]))
  )
  const validMargins = draft.model_margin <= draft.route_margin
  const validTools = draft.blocked_tools.every((rule) => rule.message.trim())
  const validPhrases = draft.upstream_policy_phrases.every(
    (phrase) =>
      phrase.trim().length >= 6 &&
      !/^(api error|session|400错误)$/i.test(phrase.trim())
  )
  const valid = validSteps && validMargins && validTools && validPhrases

  return (
    <Group
      title={isRouting ? '降级策略' : '封禁与工具策略'}
      hint={
        isRouting
          ? '从现有配置中选择目标；不选目标就保留常规路由。'
          : '分级封禁、禁用工具和上游拒答短语需保存。'
      }
    >
      <form
        className='min-w-0 space-y-5'
        onSubmit={(event) => {
          event.preventDefault()
          if (!dirty || !valid || pending) return
          onSave({
            ...draft,
            blocked_tools: draft.blocked_tools.map((tool) => ({
              ...tool,
              message: tool.message.trim(),
            })),
            upstream_policy_phrases: draft.upstream_policy_phrases.map(
              (phrase) => phrase.trim()
            ),
          })
        }}
      >
        <fieldset disabled={pending} className='min-w-0 space-y-5'>
          {isRouting ? (
            <Group
              title='降级目标'
              hint='账号池用于 OAuth 槽位，API 渠道用于 API 密钥。模型优先判定；仍受同平台及密钥授权限制。'
            >
              <div className='grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3'>
                <PolicyPicker
                  label='降级账号池（分组）'
                  options={poolOptions(pools.data?.pools ?? [])}
                  value={draft.downgrade_pool}
                  onChange={(next) => change('downgrade_pool', next)}
                  loading={pools.isPending}
                  error={pools.isError}
                />
                <PolicyPicker
                  label='降级 API 渠道'
                  options={endpointOptions(channels)}
                  value={draft.downgrade_endpoint}
                  onChange={(next) => change('downgrade_endpoint', next)}
                  loading={endpoints.isPending}
                  error={endpoints.isError}
                />
                <PolicyPicker
                  label='降级模型'
                  options={modelOptions(catalog, channels)}
                  value={draft.downgrade_model}
                  onChange={(next) => change('downgrade_model', next)}
                  loading={models.isPending || endpoints.isPending}
                  error={models.isError || endpoints.isError}
                />
              </div>
              <div className='grid gap-3 sm:grid-cols-2'>
                <PresetNumber
                  label='路线降级最大安全分差'
                  value={draft.route_margin}
                  options={[
                    [0.05, '0.05'],
                    [0.1, '0.10'],
                    [0.15, '0.15（默认）'],
                    [0.2, '0.20'],
                  ]}
                  min={0}
                  max={1}
                  step='any'
                  onChange={(next) => change('route_margin', next)}
                />
                <PresetNumber
                  label='模型降级最大安全分差'
                  value={draft.model_margin}
                  options={[
                    [0.01, '0.01'],
                    [0.03, '0.03'],
                    [0.05, '0.05（默认）'],
                    [0.1, '0.10'],
                  ]}
                  min={0}
                  max={1}
                  step='any'
                  onChange={(next) => change('model_margin', next)}
                />
              </div>
              {!validMargins && (
                <p className='text-xs text-destructive' role='alert'>
                  模型分差不能大于路线分差。
                </p>
              )}
            </Group>
          ) : (
            <>
              <Group
                title='分级封禁'
                hint='按违规次数从短到长；最后一级为永久。会话始终单独封禁。'
                action={
                  <Button
                    type='button'
                    size='sm'
                    variant='ghost'
                    className='cursor-pointer'
                    onClick={() => change('ban_steps', [10, 1440, 0])}
                  >
                    恢复默认阶梯
                  </Button>
                }
              >
                <div className='grid items-start gap-3 sm:grid-cols-2 xl:grid-cols-3'>
                  {draft.ban_steps.slice(0, -1).map((minutes, index) => (
                    <div key={index} className='flex min-w-0 items-end gap-1'>
                      <PresetNumber
                        label={`第 ${index + 1} 次违规`}
                        value={minutes}
                        options={BAN_DURATIONS}
                        min={1}
                        max={525600}
                        step={1}
                        onChange={(next) =>
                          change(
                            'ban_steps',
                            draft.ban_steps.map((previous, position) =>
                              position === index ? next : previous
                            )
                          )
                        }
                      />
                      <RemoveButton
                        label={`删除第 ${index + 1} 级封禁`}
                        onClick={() =>
                          change(
                            'ban_steps',
                            draft.ban_steps.filter(
                              (_, position) => position !== index
                            )
                          )
                        }
                      />
                    </div>
                  ))}
                  <div className='space-y-2'>
                    <p className='text-sm leading-none font-medium'>
                      第 {draft.ban_steps.length} 次违规
                    </p>
                    <p className='flex h-9 items-center rounded-md border bg-muted/40 px-3 text-sm'>
                      永久封禁
                    </p>
                  </div>
                </div>
                {!validSteps && (
                  <p className='text-xs text-destructive' role='alert'>
                    封禁时长必须逐级增加。
                  </p>
                )}
                <Button
                  type='button'
                  size='sm'
                  variant='outline'
                  className='cursor-pointer'
                  disabled={
                    draft.ban_steps.length >= 10 || lastTimedBan >= 525600
                  }
                  onClick={() => {
                    const next =
                      BAN_DURATIONS.find(
                        ([minutes]) => minutes > lastTimedBan
                      )?.[0] ?? Math.min(525600, lastTimedBan * 2)
                    change('ban_steps', [
                      ...draft.ban_steps.slice(0, -1),
                      next,
                      0,
                    ])
                  }}
                >
                  <Plus /> 添加一级
                </Button>
              </Group>

              <Group
                title='禁用工具'
                hint='可添加多个精确工具名。常用工具可直接选择，其他客户端和 MCP 工具可自定义。'
              >
                <ToolPicker
                  selected={draft.blocked_tools.map((tool) =>
                    tool.name.toLowerCase()
                  )}
                  onAdd={(name) =>
                    change('blocked_tools', [
                      ...draft.blocked_tools,
                      { name, message: TOOL_DENIAL },
                    ])
                  }
                />
                {draft.blocked_tools.length > 0 && (
                  <ul className='divide-y rounded-md border'>
                    {draft.blocked_tools.map((tool, index) => (
                      <li
                        key={index}
                        className='grid items-center gap-2 p-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto]'
                      >
                        <code className='text-xs break-all'>{tool.name}</code>
                        <div className='flex items-center gap-1 sm:contents'>
                          <Input
                            aria-label={`${tool.name} 的拒绝提示`}
                            required
                            maxLength={240}
                            value={tool.message}
                            onChange={(event) =>
                              change(
                                'blocked_tools',
                                draft.blocked_tools.map((item, position) =>
                                  position === index
                                    ? { ...item, message: event.target.value }
                                    : item
                                )
                              )
                            }
                          />
                          <RemoveButton
                            label={`移除工具 ${tool.name}`}
                            onClick={() =>
                              change(
                                'blocked_tools',
                                draft.blocked_tools.filter(
                                  (_, position) => position !== index
                                )
                              )
                            }
                          />
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
                {!validTools && (
                  <p className='text-xs text-destructive' role='alert'>
                    每条工具规则都需要拒绝提示。
                  </p>
                )}
              </Group>

              <details
                className='rounded-md border px-3 py-2.5'
                open={value.upstream_policy_phrases.length > 0}
              >
                <summary className='cursor-pointer text-sm font-medium focus-visible:outline-ring'>
                  高级：自定义上游拒答短语
                </summary>
                <div className='mt-3 space-y-2'>
                  <p className='text-xs leading-5 text-muted-foreground'>
                    明确的 Usage
                    Policy、内容拒答和会话被标记已自动识别。仅补充实际观察到的特定短语，不要填通用
                    400 或 API Error。
                  </p>
                  {draft.upstream_policy_phrases.map((phrase, index) => (
                    <div key={index} className='flex items-center gap-1'>
                      <Input
                        aria-label={`第 ${index + 1} 条上游拒答短语`}
                        minLength={6}
                        maxLength={120}
                        required
                        value={phrase}
                        onChange={(event) =>
                          change(
                            'upstream_policy_phrases',
                            draft.upstream_policy_phrases.map(
                              (item, position) =>
                                position === index ? event.target.value : item
                            )
                          )
                        }
                      />
                      <RemoveButton
                        label={`移除第 ${index + 1} 条短语`}
                        onClick={() =>
                          change(
                            'upstream_policy_phrases',
                            draft.upstream_policy_phrases.filter(
                              (_, position) => position !== index
                            )
                          )
                        }
                      />
                    </div>
                  ))}
                  {!validPhrases && (
                    <p className='text-xs text-destructive' role='alert'>
                      请输入至少 6 个字符的具体拒答短语。
                    </p>
                  )}
                  <Button
                    type='button'
                    size='sm'
                    variant='outline'
                    className='cursor-pointer'
                    disabled={draft.upstream_policy_phrases.length >= 30}
                    onClick={() =>
                      change('upstream_policy_phrases', [
                        ...draft.upstream_policy_phrases,
                        '',
                      ])
                    }
                  >
                    <Plus /> 添加短语
                  </Button>
                </div>
              </details>
            </>
          )}
        </fieldset>

        <div className='flex flex-wrap items-center gap-2 border-t pt-3'>
          <Button
            type='submit'
            size='sm'
            className='cursor-pointer'
            disabled={pending || !dirty || !valid}
          >
            {pending ? '保存中…' : '保存审核策略'}
          </Button>
          {dirty && (
            <Button
              type='button'
              size='sm'
              variant='ghost'
              className='cursor-pointer'
              disabled={pending}
              onClick={() => setDraft(value)}
            >
              撤销未保存修改
            </Button>
          )}
        </div>
      </form>
    </Group>
  )
}

function PolicyPicker({
  label,
  options,
  value,
  onChange,
  loading = false,
  error = false,
  add = false,
}: {
  label: string
  options: PolicyOption[]
  value: string
  onChange: (value: string) => void
  loading?: boolean
  error?: boolean
  add?: boolean
}) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const selected = options.find((option) => option.value === value)
  const labelText = add ? '选择工具' : '不启用'
  const pick = (next: string) => {
    onChange(next)
    setOpen(false)
  }
  return (
    <div className='min-w-0 space-y-2'>
      <Label htmlFor={id}>{label}</Label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            type='button'
            variant='outline'
            className='w-full min-w-0 cursor-pointer justify-between px-3 font-normal'
          >
            <span className='truncate'>
              {selected?.label || value || labelText}
            </span>
            <ChevronsUpDown className='opacity-50' aria-hidden='true' />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align='start'
          className='w-(--radix-popover-trigger-width) max-w-[calc(100vw-2rem)] min-w-56 p-0'
        >
          <Command>
            <CommandInput
              aria-label={`搜索${label}`}
              placeholder='搜索名称或 ID…'
            />
            <CommandList>
              <CommandEmpty>没有匹配项</CommandEmpty>
              {!add && (
                <CommandItem
                  value='不启用'
                  className='cursor-pointer'
                  onSelect={() => pick('')}
                >
                  不启用
                </CommandItem>
              )}
              {options.map((option) => (
                <CommandItem
                  key={option.value}
                  value={option.value}
                  keywords={[option.label, option.detail ?? '']}
                  disabled={option.disabled}
                  className='cursor-pointer'
                  onSelect={() => pick(option.value)}
                >
                  <div className='min-w-0 flex-1'>
                    <span className='block break-all'>{option.label}</span>
                    {option.detail && (
                      <span className='block text-xs text-muted-foreground'>
                        {option.detail}
                      </span>
                    )}
                  </div>
                  {value === option.value && <Check aria-label='当前选择' />}
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <div
        className='min-h-4 text-xs leading-4 text-muted-foreground'
        aria-live='polite'
      >
        {loading
          ? '正在读取可选项…'
          : error
            ? '部分可选项读取失败，原配置保留。'
            : value && (!selected || selected.disabled)
              ? '当前目标不可用，可保留、更换或关闭。'
              : !options.length
                ? '暂无可选项'
                : selected?.detail}
      </div>
    </div>
  )
}

function PresetNumber({
  label,
  value,
  options,
  min,
  max,
  step,
  onChange,
}: {
  label: string
  value: number
  options: ReadonlyArray<readonly [number, string]>
  min: number
  max: number
  step: number | 'any'
  onChange: (value: number) => void
}) {
  const id = useId()
  const [custom, setCustom] = useState(
    !options.some(([number]) => number === value)
  )
  const editingCustom = custom || !options.some(([number]) => number === value)
  return (
    <div className='min-w-0 flex-1 space-y-2'>
      <Label htmlFor={id}>{label}</Label>
      <Select
        value={editingCustom ? 'custom' : String(value)}
        onValueChange={(next) => {
          setCustom(next === 'custom')
          if (next !== 'custom') onChange(Number(next))
        }}
      >
        <SelectTrigger id={id} className='w-full cursor-pointer'>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map(([number, name]) => (
            <SelectItem key={number} value={String(number)}>
              {name}
            </SelectItem>
          ))}
          <SelectItem value='custom'>自定义</SelectItem>
        </SelectContent>
      </Select>
      {editingCustom && (
        <Input
          type='number'
          aria-label={`${label}（自定义）`}
          required
          min={min}
          max={max}
          step={step}
          value={Number.isFinite(value) ? value : ''}
          onChange={(event) => onChange(event.target.valueAsNumber)}
        />
      )}
    </div>
  )
}

function ToolPicker({
  selected,
  onAdd,
}: {
  selected: string[]
  onAdd: (name: string) => void
}) {
  const [custom, setCustom] = useState('')
  const name = custom.trim()
  const canAdd =
    /^[\w.:-]{1,120}$/.test(name) && !selected.includes(name.toLowerCase())
  if (selected.length >= 100)
    return (
      <p className='text-xs text-muted-foreground'>已达 100 条工具规则上限。</p>
    )
  return (
    <div className='grid items-start gap-3 sm:grid-cols-2'>
      <PolicyPicker
        label='添加常用工具'
        options={TOOL_OPTIONS.filter(
          (tool) => !selected.includes(tool.value.toLowerCase())
        )}
        value=''
        onChange={onAdd}
        add
      />
      <details className='min-w-0 space-y-2'>
        <summary className='cursor-pointer text-sm focus-visible:outline-ring'>
          添加自定义工具
        </summary>
        <div className='flex items-center gap-1'>
          <Input
            aria-label='自定义精确工具名'
            placeholder='例：mcp__server__tool'
            value={custom}
            maxLength={120}
            onChange={(event) => setCustom(event.target.value)}
          />
          <Button
            type='button'
            size='sm'
            variant='outline'
            className='cursor-pointer'
            disabled={!canAdd}
            onClick={() => {
              onAdd(name)
              setCustom('')
            }}
          >
            添加
          </Button>
        </div>
      </details>
    </div>
  )
}

function RemoveButton({
  label,
  onClick,
}: {
  label: string
  onClick: () => void
}) {
  return (
    <Button
      type='button'
      size='icon'
      variant='ghost'
      className='cursor-pointer'
      aria-label={label}
      onClick={onClick}
    >
      <X aria-hidden='true' />
    </Button>
  )
}
