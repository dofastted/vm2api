import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  JevEndpointKey,
  JevInterceptConfig,
  PolicyQuestion,
} from '@/types/panel-routing'
import type { StatusTone } from '@/types/status'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useServerDraft } from '@/hooks/use-server-draft'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { StatusMark } from '@/components/status-mark'
import { SaveBar } from '@/features/settings/save-bar'
import { FieldLine, Group, ToggleItem, ToggleList } from './blocks'
import { jevInterceptQueryOptions } from './queries'
import { QuestionBank } from './question-bank'

const KEY_MAX = 999
const EXAMPLES = [
  { id: 'typesafe', label: 'TypeSafe', base_url: 'https://api.typesafe.ai' },
  { id: 'laya', label: 'Laya', base_url: 'http://127.0.0.1:8000' },
  { id: 'modernbert', label: 'ModernBERT', base_url: 'http://127.0.0.1:8000' },
] as const

const KEY_STATUS: Record<string, StatusTone> = {
  normal: { key: 'ok', cls: 'ok', text: '正常' },
  unrequested: { key: 'none', cls: 'none', text: '未请求' },
  paused: { key: 'off', cls: 'off', text: '已暂停' },
  auth_error: { key: 'bad', cls: 'bad', text: '鉴权失败' },
  insufficient_balance: { key: 'bad', cls: 'bad', text: '额度用尽' },
  rate_limited: { key: 'warn', cls: 'warn', text: '限流' },
  request_error: { key: 'caution', cls: 'caution', text: '异常' },
  unsupported: { key: 'caution', cls: 'caution', text: '无余额接口' },
}

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

type EndpointForm = {
  uid: string
  base_url: string
  from_base_url: string
  keys: string[]
  expanded: boolean
  clearSaved: boolean
}

type ProbeRow = {
  masked_key: string
  key_fingerprint: string
  available: boolean
  baseline_ok: boolean | null
  http_status: number | null
  safe_score: number | null
  unsafe_score: number | null
  message: string
}

type QuotaRow = {
  masked_key: string
  key_fingerprint: string
  status: string
  remaining: number | null
  unit: string | null
  message: string
}

type CheckState = { ok: boolean; text: string }

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

function decisionKey(base: string) {
  const text = base.trim().replace(/\/+$/, '')
  if (!text) return ''
  if (/\/(systemone|decide)$/i.test(text)) return text.toLowerCase()
  if (/\/v1$/i.test(text)) return `${text}/systemone`.toLowerCase()
  return `${text}/v1/systemone`.toLowerCase()
}

function isTypeSafe(base: string) {
  try {
    return new URL(base.trim()).hostname === 'api.typesafe.ai'
  } catch {
    return false
  }
}

function providerFor(
  base: string,
  model: string,
  previous: JevInterceptConfig['provider']
): JevInterceptConfig['provider'] {
  if (isTypeSafe(base)) return 'jev'
  if (model.trim() === 'english') return 'modernbert'
  if (
    !model.trim() &&
    /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/i.test(base.trim())
  )
    return 'laya'
  return previous || 'jev'
}

function savedBases(data: JevInterceptConfig) {
  const rows = (data.endpoints || []).filter((endpoint) => endpoint.base_url)
  if (rows.length) return rows.map((endpoint) => endpoint.base_url)
  return [data.base_url || '']
}

function formsFrom(data: JevInterceptConfig): EndpointForm[] {
  return savedBases(data).map((base, index) => ({
    uid: `saved:${index}:${base}`,
    base_url: base,
    from_base_url: base,
    keys: [''],
    expanded: false,
    clearSaved: false,
  }))
}

function endpointsDirty(
  forms: EndpointForm[] | null,
  data: JevInterceptConfig
) {
  if (!forms) return false
  const current = forms.map((form) => form.base_url.trim())
  if (savedBases(data).join('\n') !== current.join('\n')) return true
  return forms.some(
    (form) => form.clearSaved || form.keys.some((key) => key.trim())
  )
}

function blankForm(base = ''): EndpointForm {
  return {
    uid: `custom:${crypto.randomUUID()}`,
    base_url: base,
    from_base_url: '',
    keys: [''],
    expanded: true,
    clearSaved: false,
  }
}

function toneOf(status: string | undefined): StatusTone {
  return KEY_STATUS[status || ''] || KEY_STATUS.request_error
}

function scoreOf(value: number | null) {
  return value == null ? '—' : value.toFixed(2)
}

function probeStatus(row: ProbeRow) {
  if (row.http_status === 401 || row.http_status === 403) return 'auth_error'
  if (row.http_status === 402) return 'insufficient_balance'
  if (row.http_status === 429 || row.http_status === 529) return 'rate_limited'
  if (row.baseline_ok === false || !row.available) return 'request_error'
  return 'normal'
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
  const [forms, setForms] = useState<EndpointForm[] | null>(null)
  const [synced, setSynced] = useState('')
  const [listed, setListed] = useState<string[]>([])
  const [live, setLive] = useState<Record<string, string>>({})
  const [checks, setChecks] = useState<Record<string, CheckState>>({})
  const [pending, setPending] = useState<
    Record<string, 'probe' | 'quota' | ''>
  >({})

  const savedSig = (q.data ? savedBases(q.data) : []).join('\n')
  const dirty =
    !!draft &&
    !!q.data &&
    (ownedOf(draft) !== ownedOf(q.data) || endpointsDirty(forms, q.data))

  useEffect(() => {
    if (!q.data || dirty) return
    if (forms && synced === savedSig) return
    setForms(formsFrom(q.data))
    setSynced(savedSig)
  }, [q.data, dirty, forms, savedSig, synced])

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange])

  const load = (data: JevInterceptConfig) => {
    setDraft(data)
    setForms(formsFrom(data))
    setSynced(savedBases(data).join('\n'))
    setLive({})
    setChecks({})
  }

  const patchForm = (uid: string, patch: Partial<EndpointForm>) =>
    setForms(
      (prev) =>
        prev?.map((form) =>
          form.uid === uid ? { ...form, ...patch } : form
        ) || prev
    )

  const save = useMutation({
    mutationFn: () => {
      if (!draft || !forms) throw new Error('没有可保存的配置')
      const filled = forms.filter((form) => form.base_url.trim())
      const body: Record<string, unknown> = {
        enabled: draft.enabled,
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
      if (!filled.length) {
        body.base_url = ''
        body.api_keys = []
        body.provider = 'jev'
      } else {
        body.base_url = filled[0].base_url.trim()
        body.provider = providerFor(
          filled[0].base_url,
          draft.model,
          draft.provider || 'jev'
        )
        body.endpoints = filled.map((form) => {
          const typed = form.keys.map((key) => key.trim()).filter(Boolean)
          const row: Record<string, unknown> = {
            base_url: form.base_url.trim(),
          }
          if (form.from_base_url) row.from_base_url = form.from_base_url
          if (form.clearSaved) {
            row.api_keys = typed
            row.append = false
          } else if (typed.length) {
            row.api_keys = typed
            row.append = true
          }
          return row
        })
      }
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

  const runCheck = async (form: EndpointForm, kind: 'probe' | 'quota') => {
    if (!draft) return
    const base = form.base_url.trim()
    if (!base) {
      toast.error('先填模型地址')
      return
    }
    setPending((prev) => ({ ...prev, [form.uid]: kind }))
    try {
      const typed = form.keys.map((key) => key.trim()).filter(Boolean)
      const path =
        kind === 'probe'
          ? '/api/panel/jev-intercept/probe'
          : '/api/panel/jev-intercept/quota'
      const data = await api<{
        results: Array<ProbeRow | QuotaRow>
        omitted: number
      }>(path, {
        method: 'POST',
        body: JSON.stringify({
          base_url: base,
          api_keys: typed,
          model: draft.model,
          timeout_ms: Number(draft.timeout_ms) || 2000,
        }),
      })
      const results = data.results || []
      const omitted = data.omitted ? `\n还有 ${data.omitted} 把这次没测。` : ''
      if (kind === 'probe') {
        const rows = results as ProbeRow[]
        setLive((prev) => {
          const next = { ...prev }
          for (const row of rows) {
            if (row.key_fingerprint)
              next[row.key_fingerprint] = probeStatus(row)
          }
          return next
        })
        const ok =
          rows.length > 0 && rows.every((row) => row.baseline_ok === true)
        setChecks((prev) => ({
          ...prev,
          [form.uid]: {
            ok,
            text:
              rows
                .map((row) => {
                  const name = row.masked_key || '无 Key'
                  const scores =
                    row.safe_score == null && row.unsafe_score == null
                      ? ''
                      : `（安全 ${scoreOf(row.safe_score)}，违规 ${scoreOf(row.unsafe_score)}）`
                  return `${name}：${row.message}${scores}`
                })
                .join('\n') + omitted,
          },
        }))
      } else {
        const rows = results as QuotaRow[]
        setLive((prev) => {
          const next = { ...prev }
          for (const row of rows) {
            if (
              row.key_fingerprint &&
              (row.status === 'auth_error' ||
                row.status === 'insufficient_balance')
            )
              next[row.key_fingerprint] = row.status
          }
          return next
        })
        const ok =
          rows.length > 0 && rows.every((row) => row.status === 'normal')
        setChecks((prev) => ({
          ...prev,
          [form.uid]: {
            ok,
            text:
              rows
                .map((row) => {
                  const name = row.masked_key || '无 Key'
                  const money =
                    row.remaining == null
                      ? row.message
                      : `剩余 ${row.remaining}${row.unit ? ` ${row.unit}` : ''}`
                  return `${name}：${money}`
                })
                .join('\n') + omitted,
          },
        }))
      }
      void qc.invalidateQueries({ queryKey: ['panel', 'jev-usage'] })
      if (kind === 'probe')
        void qc.invalidateQueries({
          queryKey: jevInterceptQueryOptions().queryKey,
        })
    } catch (error) {
      const message = error instanceof Error ? error.message : '测试失败'
      setChecks((prev) => ({
        ...prev,
        [form.uid]: { ok: false, text: message },
      }))
      toast.error(message)
    } finally {
      setPending((prev) => ({ ...prev, [form.uid]: '' }))
    }
  }

  const fetchModels = useMutation({
    mutationFn: () => {
      const base = forms?.[0]?.base_url.trim() || ''
      if (!base) throw new Error('先填模型地址')
      const typed =
        forms?.[0]?.keys.map((key) => key.trim()).find(Boolean) || ''
      return api<{ models: string[] }>('/api/panel/jev-intercept/models', {
        method: 'POST',
        body: JSON.stringify({
          base_url: base,
          api_key: typed,
          timeout_ms: Number(draft?.timeout_ms) || 2000,
        }),
      })
    },
    onSuccess: (data) => {
      const ids = data.models || []
      setListed(ids)
      setDraft((prev) => {
        if (!prev || prev.model.trim()) return prev
        const pick = (ids.includes('jev-latest') ? 'jev-latest' : ids[0]) || ''
        return pick ? { ...prev, model: pick } : prev
      })
      toast.success(
        ids.length ? `拉到 ${ids.length} 个模型` : '上游没有返回模型'
      )
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const addExample = (base: string) => {
    setForms((prev) => {
      if (!prev) return prev
      const key = decisionKey(base)
      if (key && prev.some((form) => decisionKey(form.base_url) === key)) {
        toast.message('这个地址已经在列表里')
        return prev
      }
      if (
        prev.length === 1 &&
        !prev[0].base_url.trim() &&
        !prev[0].from_base_url
      )
        return [{ ...prev[0], base_url: base }]
      return [...prev, blankForm(base)]
    })
  }

  if (q.error) {
    return (
      <p className='p-4 text-sm text-destructive' role='alert'>
        {(q.error as Error).message}
      </p>
    )
  }
  if (!draft || !forms)
    return <div className='h-40 animate-pulse bg-muted/40' />

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
  const modelPlaceholder = isTypeSafe(forms[0]?.base_url || '')
    ? 'jev-latest'
    : '留空则由上游路由'

  return (
    <div className='space-y-8 p-4'>
      <Group
        title='何时拦截'
        hint='前三关都没拦的正文才会送到这里。没配地址时这一关跳过。'
      >
        <ToggleList>
          <ToggleItem
            label='决策模型'
            desc='三题各自打分，任一题低于阈值就拦。色情命中会封设备'
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

      <Group
        title='连接'
        hint='按地址管理，不再切换 Jev / Laya / ModernBERT。默认示例是 TypeSafe。同一地址下填写的 Key 会追加；勾选清除才替换。判断基准用的是已保存的题库和阈值。'
      >
        <div className='space-y-4'>
          {forms.map((form, index) => {
            const saved = (q.data?.endpoints || []).find(
              (endpoint) => endpoint.base_url === form.from_base_url
            )?.keys
            const savedKeys = saved || []
            const shownSaved = form.expanded ? savedKeys : savedKeys.slice(0, 1)
            const hidden = form.expanded ? [] : savedKeys.slice(1)
            const hiddenSummary = hidden
              .map(
                (row) => toneOf(live[row.key_fingerprint] || row.status).text
              )
              .join('、')
            const adding = savedKeys.length > 0
            const extra = adding ? form.keys : form.keys.slice(1)
            const check = checks[form.uid]
            return (
              <div key={form.uid} className='space-y-3 rounded-xl border p-4'>
                <FieldLine label='地址' htmlFor={`jev-base-${form.uid}`}>
                  <div className='flex flex-wrap gap-2'>
                    <Input
                      id={`jev-base-${form.uid}`}
                      className='min-w-48 flex-1 font-mono'
                      value={form.base_url}
                      placeholder='https://api.typesafe.ai'
                      onChange={(e) =>
                        patchForm(form.uid, { base_url: e.target.value })
                      }
                    />
                    {index === 0 ? (
                      <Button
                        type='button'
                        variant='outline'
                        className='shrink-0 cursor-pointer'
                        onClick={() =>
                          patchForm(form.uid, {
                            base_url: 'https://api.typesafe.ai',
                          })
                        }
                      >
                        默认
                      </Button>
                    ) : null}
                    {forms.length > 1 ? (
                      <Button
                        type='button'
                        variant='ghost'
                        className='shrink-0 cursor-pointer'
                        onClick={() =>
                          setForms((prev) =>
                            prev
                              ? prev.filter((item) => item.uid !== form.uid)
                              : prev
                          )
                        }
                      >
                        移除
                      </Button>
                    ) : null}
                  </div>
                </FieldLine>
                <FieldLine label='Key' htmlFor={`jev-key-${form.uid}`}>
                  <div className='space-y-2'>
                    <div className='flex flex-wrap gap-2'>
                      {adding ? (
                        <SavedKey
                          row={shownSaved[0]}
                          live={live}
                          placeholder='还没有 Key'
                        />
                      ) : (
                        <Input
                          id={`jev-key-${form.uid}`}
                          type='password'
                          autoComplete='off'
                          className='min-w-40 flex-1'
                          value={form.keys[0] || ''}
                          placeholder='本地服务可留空'
                          onChange={(e) =>
                            patchForm(form.uid, {
                              keys: form.keys.map((key, i) =>
                                i === 0 ? e.target.value : key
                              ),
                              clearSaved: e.target.value
                                ? false
                                : form.clearSaved,
                            })
                          }
                        />
                      )}
                      <Button
                        type='button'
                        variant='outline'
                        className='cursor-pointer'
                        aria-expanded={form.expanded}
                        onClick={() =>
                          patchForm(form.uid, { expanded: !form.expanded })
                        }
                      >
                        {form.expanded ? '收起' : '展开更多'}
                      </Button>
                      <Button
                        type='button'
                        variant='outline'
                        className='cursor-pointer'
                        loading={pending[form.uid] === 'probe'}
                        disabled={!!pending[form.uid]}
                        onClick={() => void runCheck(form, 'probe')}
                      >
                        一键测试
                      </Button>
                      <Button
                        type='button'
                        variant='outline'
                        className='cursor-pointer'
                        loading={pending[form.uid] === 'quota'}
                        disabled={!!pending[form.uid]}
                        onClick={() => void runCheck(form, 'quota')}
                      >
                        检查剩余额度
                      </Button>
                    </div>
                    {shownSaved.length ? (
                      <KeyList rows={shownSaved} live={live} />
                    ) : null}
                    {form.expanded ? (
                      <div className='space-y-2 border-t pt-2'>
                        {extra.map((value, keyIndex) => {
                          const realIndex = adding ? keyIndex : keyIndex + 1
                          return (
                            <div key={realIndex} className='flex gap-2'>
                              <Input
                                type='password'
                                autoComplete='off'
                                aria-label={`追加 Key ${realIndex + 1}`}
                                value={value}
                                placeholder='再添加一把'
                                onChange={(e) =>
                                  patchForm(form.uid, {
                                    keys: form.keys.map((key, i) =>
                                      i === realIndex ? e.target.value : key
                                    ),
                                  })
                                }
                              />
                              <Button
                                type='button'
                                variant='ghost'
                                className='cursor-pointer'
                                onClick={() =>
                                  patchForm(form.uid, {
                                    keys: form.keys.filter(
                                      (_, i) => i !== realIndex
                                    ),
                                  })
                                }
                              >
                                删除
                              </Button>
                            </div>
                          )
                        })}
                        <div className='flex flex-wrap items-center justify-between gap-2'>
                          <Button
                            type='button'
                            variant='outline'
                            size='sm'
                            className='cursor-pointer'
                            disabled={form.keys.length >= KEY_MAX}
                            onClick={() =>
                              patchForm(form.uid, { keys: [...form.keys, ''] })
                            }
                          >
                            再加一把
                          </Button>
                          {savedKeys.length ? (
                            <ToggleItem
                              label='清除已存 Key'
                              desc='保存后换成这次填写的；没填就是删掉'
                            >
                              <Switch
                                checked={form.clearSaved}
                                onCheckedChange={(v) =>
                                  patchForm(form.uid, { clearSaved: v })
                                }
                              />
                            </ToggleItem>
                          ) : null}
                        </div>
                      </div>
                    ) : null}
                    {check ? (
                      <p
                        className={cn(
                          'text-xs whitespace-pre-wrap',
                          check.ok ? 'text-foreground' : 'text-destructive'
                        )}
                        role={check.ok ? undefined : 'alert'}
                      >
                        {check.text}
                      </p>
                    ) : (
                      <p className='text-xs text-muted-foreground'>
                        {savedKeys.length
                          ? `已存 ${savedKeys.length} 把${hiddenSummary ? `，未展开 ${hiddenSummary}` : ''}。展开后可继续添加。`
                          : '还没有 Key。'}
                        一键测试先看模型是否可连，再用一句普通说明和一句入侵请求核对判断基准。官方
                        TypeSafe 没有余额接口，用尽时调用会返回 402。
                      </p>
                    )}
                  </div>
                </FieldLine>
              </div>
            )
          })}
          <div className='flex flex-wrap gap-2'>
            {EXAMPLES.map((example) => (
              <Button
                key={example.id}
                type='button'
                variant='outline'
                size='sm'
                className='cursor-pointer'
                onClick={() => addExample(example.base_url)}
              >
                添加 {example.label}
              </Button>
            ))}
            <Button
              type='button'
              variant='outline'
              size='sm'
              className='cursor-pointer'
              onClick={() =>
                setForms((prev) => (prev ? [...prev, blankForm()] : prev))
              }
            >
              添加自定义地址
            </Button>
          </div>
          <p className='text-xs text-muted-foreground'>
            Laya 和 ModernBERT
            的示例地址相同，已在列表里就不会再加一行。TypeSafe 常用
            jev-latest，ModernBERT 常用 english，Laya 可以留空。
          </p>
        </div>
        <div className='grid gap-3 sm:grid-cols-[minmax(0,1fr)_9rem]'>
          <FieldLine label='模型' htmlFor='jev-model'>
            <div className='flex gap-2'>
              <Input
                id='jev-model'
                className='font-mono'
                value={draft.model}
                placeholder={modelPlaceholder}
                onChange={(e) => setDraft({ ...draft, model: e.target.value })}
              />
              <Button
                type='button'
                variant='outline'
                className='shrink-0 cursor-pointer'
                loading={fetchModels.isPending}
                disabled={fetchModels.isPending || !forms[0]?.base_url.trim()}
                onClick={() => fetchModels.mutate()}
              >
                获取模型
              </Button>
            </div>
          </FieldLine>
          <div className='space-y-1.5'>
            <Label htmlFor='jev-timeout'>超时 ms</Label>
            <Input
              id='jev-timeout'
              type='number'
              min={200}
              max={8000}
              className='tabular-nums'
              value={draft.timeout_ms}
              onChange={(e) =>
                setDraft({ ...draft, timeout_ms: Number(e.target.value) })
              }
            />
          </div>
        </div>
        {listed.length ? (
          <div className='flex flex-wrap gap-1.5'>
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
        ) : null}
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

function SavedKey({
  row,
  live,
  placeholder,
}: {
  row: JevEndpointKey | undefined
  live: Record<string, string>
  placeholder: string
}) {
  if (!row) {
    return <span className='text-sm text-muted-foreground'>{placeholder}</span>
  }
  const status = live[row.key_fingerprint] || row.status
  return (
    <span className='flex min-w-40 flex-1 items-center gap-2'>
      <span className='font-mono text-sm'>{row.masked_key}</span>
      <StatusMark tone={toneOf(status)} />
    </span>
  )
}

function KeyList({
  rows,
  live,
}: {
  rows: JevEndpointKey[]
  live: Record<string, string>
}) {
  if (rows.length <= 1) return null
  return (
    <ul className='space-y-1'>
      {rows.slice(1).map((row) => (
        <li key={row.key_fingerprint || row.number}>
          <SavedKey row={row} live={live} placeholder='' />
        </li>
      ))}
    </ul>
  )
}
