import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { JevInterceptConfig, PolicyQuestion } from '@/types/panel-routing'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useServerDraft } from '@/hooks/use-server-draft'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { SaveBar } from '@/features/settings/save-bar'
import {
  FieldLine,
  Fold,
  FoldStack,
  Group,
  Segmented,
  ToggleItem,
  ToggleList,
} from './blocks'
import { jevInterceptQueryOptions } from './queries'
import { QuestionBank } from './question-bank'

function linesOf(text: string) {
  return text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

const KEY_MAX = 999
const PROVIDERS = [
  {
    id: 'jev' as const,
    label: 'Jev',
    default_model: 'jev-latest',
    default_base_url: 'https://api.typesafe.ai',
  },
  {
    id: 'laya' as const,
    label: 'Laya',
    default_model: '',
    default_base_url: 'http://127.0.0.1:8000',
  },
  {
    id: 'modernbert' as const,
    label: 'ModernBERT',
    default_model: 'english',
    default_base_url: 'http://127.0.0.1:8000',
  },
]

/** Fields this stage owns. Hard-regex fields on the same config stay untouched. */
const OWNED = [
  'enabled',
  'provider',
  'base_url',
  'model',
  'timeout_ms',
  'safety_instruction',
  'safety_threshold',
  'block_if_below',
  'fail_open',
  'dedup_sec',
  'max_state_chars',
] as const

function ownedOf(data: JevInterceptConfig) {
  return JSON.stringify([
    ...OWNED.map((key) => data[key] ?? null),
    data.question_bank || [],
  ])
}

function asDraft(data: JevInterceptConfig) {
  return data
}

function ownedDiffers(a: JevInterceptConfig, b: JevInterceptConfig) {
  return ownedOf(a) !== ownedOf(b)
}

/** Decision model: connection, scoring and the question bank, saved together. */
export function ModelSettings({
  onDirtyChange,
}: {
  onDirtyChange: (dirty: boolean) => void
}) {
  const qc = useQueryClient()
  const q = useQuery(jevInterceptQueryOptions())
  // 只同步本块字段：别的块保存会改写同一份缓存，本块有未保存改动时保留草稿。
  const [draft, setDraft] = useServerDraft(q.data, asDraft, ownedDiffers)
  const [apiKey, setApiKey] = useState('')
  const [keysText, setKeysText] = useState('')
  const [clearKey, setClearKey] = useState(false)
  const [listed, setListed] = useState<string[]>([])

  const load = (data: JevInterceptConfig) => {
    setDraft(data)
    setApiKey('')
    setKeysText('')
    setClearKey(false)
  }

  const dirty =
    !!draft &&
    !!q.data &&
    (ownedOf(draft) !== ownedOf(q.data) ||
      apiKey.trim().length > 0 ||
      linesOf(keysText).length > 0 ||
      clearKey)
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange])

  const save = useMutation({
    mutationFn: () => {
      if (!draft) throw new Error('没有可保存的配置')
      const body: Record<string, unknown> = {
        enabled: draft.enabled,
        provider: draft.provider || 'jev',
        base_url: draft.base_url,
        model: draft.model,
        timeout_ms: Number(draft.timeout_ms),
        safety_instruction: draft.safety_instruction || '',
        safety_threshold: Number(draft.safety_threshold ?? 0.5),
        block_if_below: draft.block_if_below !== false,
        fail_open: draft.fail_open !== false,
        dedup_sec: Number(draft.dedup_sec ?? 60),
        max_state_chars: Number(draft.max_state_chars ?? 16000),
        questions: draft.question_bank || [],
      }
      const keys = linesOf(keysText).slice(0, KEY_MAX)
      if (clearKey) body.api_keys = []
      else if (keys.length) body.api_keys = keys
      else if (apiKey.trim()) body.api_key = apiKey.trim()
      return api<JevInterceptConfig>('/api/panel/jev-intercept', {
        method: 'PUT',
        body: JSON.stringify(body),
      })
    },
    onSuccess: (data) => {
      toast.success('已保存决策模型关')
      load(data)
      qc.setQueryData(jevInterceptQueryOptions().queryKey, data)
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const fetchModels = useMutation({
    mutationFn: () => {
      if (!draft?.base_url.trim()) throw new Error('先填模型地址')
      return api<{ models: string[] }>('/api/panel/jev-intercept/models', {
        method: 'POST',
        body: JSON.stringify({
          base_url: draft.base_url.trim(),
          api_key: apiKey.trim(),
          timeout_ms: Number(draft.timeout_ms) || 2000,
        }),
      })
    },
    onSuccess: (data) => {
      const ids = data.models || []
      setListed(ids)
      setDraft((prev) => {
        if (!prev || prev.model.trim()) return prev
        const preferred =
          prev.providers?.find((item) => item.id === (prev.provider || 'jev'))
            ?.default_model || ''
        const pick =
          (preferred && ids.includes(preferred) ? preferred : ids[0]) || ''
        return pick ? { ...prev, model: pick } : prev
      })
      toast.success(
        ids.length ? `拉到 ${ids.length} 个模型` : '上游没有返回模型'
      )
    },
    onError: (error: Error) => toast.error(error.message),
  })

  if (q.error) {
    return (
      <p className='p-4 text-sm text-destructive' role='alert'>
        {(q.error as Error).message}
      </p>
    )
  }
  if (!draft) return <div className='h-40 animate-pulse bg-muted/40' />

  const providers = PROVIDERS.map((item) => {
    const remote = (draft.providers || []).find((row) => row.id === item.id)
    return {
      ...item,
      label: remote?.label || item.label,
      default_model: remote?.default_model ?? item.default_model,
      default_base_url: remote?.default_base_url || item.default_base_url,
    }
  })
  const provider = draft.provider || 'jev'
  const current = providers.find((item) => item.id === provider) || providers[0]
  const applyProvider = (id: JevInterceptConfig['provider']) => {
    const next = providers.find((item) => item.id === id) || current
    const base = draft.base_url.trim().replace(/\/+$/, '')
    const model = draft.model.trim()
    const baseIsDefault =
      !base ||
      providers.some(
        (item) => (item.default_base_url || '').replace(/\/+$/, '') === base
      )
    const modelIsDefault = providers.some(
      (item) => (item.default_model || '') === model
    )
    setListed([])
    setDraft({
      ...draft,
      provider: id,
      base_url: baseIsDefault ? next.default_base_url || '' : draft.base_url,
      model: modelIsDefault ? next.default_model || '' : draft.model,
    })
  }
  const restoreScore = () => {
    const defaults = draft.defaults
    setDraft({
      ...draft,
      safety_instruction: '',
      safety_threshold: defaults?.safety_threshold ?? 0.5,
      block_if_below: defaults?.block_if_below !== false,
      fail_open: defaults?.fail_open !== false,
      dedup_sec: defaults?.dedup_sec ?? 60,
      max_state_chars: defaults?.max_state_chars ?? 16000,
    })
  }
  const questions = draft.question_bank || []
  const setQuestions = (rows: PolicyQuestion[]) =>
    setDraft({ ...draft, question_bank: rows })
  const enabledQuestions = questions.filter((row) => row.enabled).length

  return (
    <div className='space-y-8 p-4'>
      <Group
        title='何时拦截'
        hint='前三关都没拦的正文才会送到这里。没配地址时这一关跳过。'
      >
        <ToggleList>
          <ToggleItem
            label='决策模型'
            desc='最多五题各自打分，任一题低于阈值就拦。命中会写拒答缓存并封 device + Session'
          >
            <Switch
              checked={draft.enabled}
              onCheckedChange={(v) => setDraft({ ...draft, enabled: v })}
            />
          </ToggleItem>
          <ToggleItem
            label='失败放行'
            desc='打分失败照常出站，记为「模型故障放行」。关掉后只拦截这一次，不封禁设备'
          >
            <Switch
              checked={draft.fail_open !== false}
              onCheckedChange={(v) => setDraft({ ...draft, fail_open: v })}
            />
          </ToggleItem>
          <ToggleItem label='低于阈值拦截' desc='关掉则高于阈值才拦'>
            <Switch
              checked={draft.block_if_below !== false}
              onCheckedChange={(v) => setDraft({ ...draft, block_if_below: v })}
            />
          </ToggleItem>
        </ToggleList>
      </Group>

      <Group title='连接'>
        <div className='space-y-4 rounded-xl border p-4'>
          <Segmented
            value={provider}
            options={providers.map((item) => ({
              value: item.id,
              label: item.label,
            }))}
            onChange={(id) => applyProvider(id)}
          />
          <div className='space-y-3'>
            <FieldLine label='地址' htmlFor='jev-base'>
              <div className='flex gap-2'>
                <Input
                  id='jev-base'
                  className='font-mono'
                  value={draft.base_url}
                  placeholder={current.default_base_url || 'https://'}
                  onChange={(e) =>
                    setDraft({ ...draft, base_url: e.target.value })
                  }
                />
                <Button
                  type='button'
                  variant='outline'
                  className='shrink-0 cursor-pointer'
                  onClick={() =>
                    setDraft({
                      ...draft,
                      base_url: current.default_base_url || '',
                    })
                  }
                >
                  默认
                </Button>
              </div>
            </FieldLine>
            <FieldLine label='Key' htmlFor='jev-key'>
              <Input
                id='jev-key'
                type='password'
                autoComplete='off'
                value={apiKey}
                placeholder={
                  draft.api_key_count
                    ? `已存 ${draft.api_key_count} 把，留空不改`
                    : '本地服务可留空'
                }
                onChange={(e) => {
                  setApiKey(e.target.value)
                  if (e.target.value) setClearKey(false)
                }}
              />
            </FieldLine>
            <FieldLine label='模型' htmlFor='jev-model'>
              <div className='flex gap-2'>
                <Input
                  id='jev-model'
                  className='font-mono'
                  value={draft.model}
                  placeholder={current.default_model || '留空则由上游路由'}
                  onChange={(e) =>
                    setDraft({ ...draft, model: e.target.value })
                  }
                />
                <Button
                  type='button'
                  variant='outline'
                  className='shrink-0 cursor-pointer'
                  loading={fetchModels.isPending}
                  disabled={fetchModels.isPending || !draft.base_url.trim()}
                  onClick={() => fetchModels.mutate()}
                >
                  获取模型
                </Button>
              </div>
            </FieldLine>
            <FieldLine label='超时 ms' htmlFor='jev-timeout'>
              <Input
                id='jev-timeout'
                type='number'
                min={200}
                max={8000}
                className='max-w-40 tabular-nums'
                value={draft.timeout_ms}
                onChange={(e) =>
                  setDraft({ ...draft, timeout_ms: Number(e.target.value) })
                }
              />
            </FieldLine>
          </div>
          {listed.length ? (
            <div className='flex flex-wrap gap-1.5 border-t pt-3'>
              {listed.map((id) => (
                <button
                  key={id}
                  type='button'
                  className={cn(
                    'cursor-pointer rounded-md px-2 py-1 font-mono text-xs transition-colors duration-200',
                    draft.model === id
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-muted-foreground hover:text-foreground'
                  )}
                  onClick={() => setDraft({ ...draft, model: id })}
                >
                  {id}
                </button>
              ))}
            </div>
          ) : (
            <p className='border-t pt-3 text-xs text-muted-foreground'>
              获取模型会请求这个地址的 /v1/models。Key 留空时用已保存的第一把。
            </p>
          )}
        </div>
        <FoldStack>
          <Fold
            flush
            title='多把 Key'
            meta={
              draft.api_key_count
                ? `已存 ${draft.api_key_count} 把，401/429/529 不再调度`
                : `最多 ${KEY_MAX} 把`
            }
          >
            <div className='space-y-3'>
              <Textarea
                aria-label='多把 Key'
                rows={3}
                className='font-mono text-xs'
                value={keysText}
                placeholder='一行一把。URL 空格 Key 打到该地址，否则用上面的模型地址'
                onChange={(e) => {
                  setKeysText(e.target.value)
                  if (e.target.value.trim()) setClearKey(false)
                }}
              />
              <ToggleItem label='清除已存 Key' desc='留空且不勾选则保持原密钥'>
                <Switch
                  checked={clearKey}
                  disabled={!draft.api_key_set && !clearKey}
                  onCheckedChange={(v) => {
                    setClearKey(v)
                    if (v) {
                      setApiKey('')
                      setKeysText('')
                    }
                  }}
                />
              </ToggleItem>
            </div>
          </Fold>
        </FoldStack>
      </Group>

      <Group
        title='打分'
        hint='高分表示安全。相同正文在去重窗口内不再打模型。阈值越低越不容易误伤。'
        action={
          <button
            type='button'
            className='cursor-pointer text-xs text-muted-foreground underline-offset-4 transition-colors duration-200 hover:text-foreground hover:underline'
            onClick={restoreScore}
          >
            恢复默认
          </button>
        }
      >
        <div className='grid gap-3 sm:grid-cols-3'>
          <div className='space-y-1.5'>
            <Label htmlFor='jev-threshold'>阈值</Label>
            <Input
              id='jev-threshold'
              type='number'
              min={0}
              max={1}
              step={0.05}
              className='tabular-nums'
              value={draft.safety_threshold ?? 0.5}
              onChange={(e) =>
                setDraft({ ...draft, safety_threshold: Number(e.target.value) })
              }
            />
          </div>
          <div className='space-y-1.5'>
            <Label htmlFor='jev-dedup'>去重（秒）</Label>
            <Input
              id='jev-dedup'
              type='number'
              min={0}
              max={3600}
              className='tabular-nums'
              value={draft.dedup_sec ?? 60}
              onChange={(e) =>
                setDraft({ ...draft, dedup_sec: Number(e.target.value) })
              }
            />
          </div>
          <div className='space-y-1.5'>
            <Label htmlFor='jev-state'>送模上限（字）</Label>
            <Input
              id='jev-state'
              type='number'
              min={256}
              max={64000}
              className='tabular-nums'
              value={draft.max_state_chars ?? 16000}
              onChange={(e) =>
                setDraft({ ...draft, max_state_chars: Number(e.target.value) })
              }
            />
          </div>
        </div>
        <div className='space-y-1.5'>
          <Label htmlFor='jev-instruction'>自定义要求</Label>
          <Textarea
            id='jev-instruction'
            rows={2}
            value={draft.safety_instruction || ''}
            placeholder='留空则只用题库。填写后会多问这一题'
            onChange={(e) =>
              setDraft({ ...draft, safety_instruction: e.target.value })
            }
          />
        </div>
      </Group>

      <Group
        title='题库'
        hint={`启用的题在同一次请求里一起问。当前启用 ${enabledQuestions} / ${questions.length} 题。`}
        action={
          <Button
            size='sm'
            variant='outline'
            className='cursor-pointer'
            onClick={() => setQuestions(q.data?.builtin_questions || [])}
          >
            恢复内置
          </Button>
        }
      >
        <QuestionBank rows={questions} onChange={setQuestions} />
      </Group>

      {dirty ? (
        <SaveBar
          saving={save.isPending}
          onSave={() => save.mutate()}
          onDiscard={() => q.data && load(q.data)}
        />
      ) : null}
    </div>
  )
}
