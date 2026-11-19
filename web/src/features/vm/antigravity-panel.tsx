import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import {
  ANTIGRAVITY_REASONING_LEVELS,
  antigravityModelsFromIds,
} from '@/features/settings/antigravity-models'
import { routingQueryOptions } from '@/features/settings/queries'
import {
  AntigravityModelSync,
  type AntigravityReasoningLevel,
} from './antigravity-model-sync'

export function AntigravitySettings() {
  const qc = useQueryClient()
  const routing = useQuery(routingQueryOptions())
  const [enabled, setEnabled] = useState(false)
  const [cli, setCli] = useState('agy')
  const [maxSessions, setMaxSessions] = useState('1')
  const [queueSec, setQueueSec] = useState('120')
  const [affinitySec, setAffinitySec] = useState('15')
  const [models, setModels] = useState('')
  const [levels, setLevels] = useState<
    Record<string, AntigravityReasoningLevel[]>
  >({})
  useEffect(() => {
    if (!routing.data) return
    const value = (routing.data.antigravity || {}) as Record<string, unknown>
    setEnabled(value.enabled === true)
    setCli(typeof value.cli_bin === 'string' ? value.cli_bin : 'agy')
    setMaxSessions(String(value.max_sessions ?? 1))
    setQueueSec(String(Number(value.queue_timeout_ms ?? 120000) / 1000))
    setAffinitySec(String(Number(value.affinity_wait_ms ?? 15000) / 1000))
    setModels(
      Array.isArray(value.models)
        ? value.models
            .map((m: string | { id?: string }) =>
              typeof m === 'string' ? m : m.id || ''
            )
            .filter(Boolean)
            .join('\n')
        : ''
    )
    const nextLevels: Record<string, AntigravityReasoningLevel[]> = {}
    if (Array.isArray(value.models)) {
      for (const m of value.models) {
        if (
          m &&
          typeof m === 'object' &&
          typeof (m as { id?: unknown }).id === 'string' &&
          Array.isArray((m as { levels?: unknown }).levels)
        ) {
          const item = m as { id: string; levels: unknown[] }
          nextLevels[item.id] = item.levels.filter(
            (level): level is AntigravityReasoningLevel =>
              ANTIGRAVITY_REASONING_LEVELS.includes(
                level as AntigravityReasoningLevel
              )
          )
        }
      }
    }
    setLevels(nextLevels)
  }, [routing.data])
  const modelIds = [
    ...new Set(
      models
        .split('\n')
        .map((id) => id.trim())
        .filter(Boolean)
    ),
  ]
  const toggleLevel = (
    id: string,
    level: AntigravityReasoningLevel,
    checked: boolean
  ) => {
    setLevels((prev) => {
      const current = prev[id] || []
      const next = checked
        ? ANTIGRAVITY_REASONING_LEVELS.filter(
            (item) => current.includes(item) || item === level
          )
        : current.filter((item) => item !== level)
      return { ...prev, [id]: next }
    })
  }
  const save = useMutation({
    mutationFn: () =>
      api('/api/panel/routing', {
        method: 'PUT',
        body: JSON.stringify({
          antigravity: {
            ...((routing.data?.antigravity || {}) as Record<string, unknown>),
            enabled,
            cli_bin: cli.trim() || 'agy',
            max_sessions: Number(maxSessions),
            queue_timeout_ms: Math.round(Number(queueSec) * 1000),
            affinity_wait_ms: Math.round(Number(affinitySec) * 1000),
            models: antigravityModelsFromIds(
              (routing.data?.antigravity as Record<string, unknown> | undefined)
                ?.models,
              models,
              levels
            ),
          },
        }),
      }),
    onSuccess: () => {
      toast.success('Antigravity 配置已保存')
      void qc.invalidateQueries({ queryKey: ['panel', 'routing'] })
      void qc.invalidateQueries({ queryKey: ['panel', 'vm'] })
      void qc.invalidateQueries({ queryKey: ['panel', 'models'] })
    },
    onError: (error: Error) => toast.error(error.message),
  })
  return (
    <Card>
      <CardHeader className='pb-2'>
        <CardTitle className='text-sm'>Antigravity 平台设置</CardTitle>
      </CardHeader>
      <CardContent className='space-y-3 pt-0'>
        <p className='text-xs text-muted-foreground'>
          此配置作用于全部 Antigravity
          槽位，默认关闭。先从已授权槽位同步模型，再启用 API 接入。
        </p>
        {routing.error ? (
          <p role='alert' className='text-sm text-destructive'>
            {routing.error.message}
          </p>
        ) : null}
        <div className='flex items-center justify-between'>
          <Label htmlFor='agy-enabled'>启用 Antigravity API 接入</Label>
          <Switch
            id='agy-enabled'
            checked={enabled}
            onCheckedChange={setEnabled}
          />
        </div>
        <AntigravityModelSync />
        <div className='space-y-1'>
          <Label htmlFor='agy-cli'>槽内客户端路径</Label>
          <Input
            id='agy-cli'
            value={cli}
            onChange={(e) => setCli(e.target.value)}
          />
        </div>
        <div className='grid gap-3 sm:grid-cols-2'>
          <div className='space-y-1'>
            <Label htmlFor='agy-max-sessions'>单槽并发（1–20）</Label>
            <Input
              id='agy-max-sessions'
              type='number'
              min={1}
              max={20}
              value={maxSessions}
              onChange={(e) => setMaxSessions(e.target.value)}
            />
            <p className='text-xs text-muted-foreground'>
              每个槽位同时在飞的请求数，也是槽位单独覆盖的上限。修改后需在各槽位运维页「重载
              Antigravity bridge」。
            </p>
          </div>
          <div className='space-y-1'>
            <Label htmlFor='agy-queue-timeout'>排队等待（秒，1–300）</Label>
            <Input
              id='agy-queue-timeout'
              type='number'
              min={1}
              max={300}
              value={queueSec}
              onChange={(e) => setQueueSec(e.target.value)}
            />
            <p className='text-xs text-muted-foreground'>
              槽位全满时请求最多等待多久，超时返回 429。
            </p>
          </div>
          <div className='space-y-1'>
            <Label htmlFor='agy-affinity-wait'>缓存亲和等待（秒，0–120）</Label>
            <Input
              id='agy-affinity-wait'
              type='number'
              min={0}
              max={120}
              value={affinitySec}
              onChange={(e) => setAffinitySec(e.target.value)}
            />
            <p className='text-xs text-muted-foreground'>
              会话绑定的槽位正忙时，先等它空出来再换槽，避免整段前缀在新槽冷写、缓存不命中。0
              表示不等。
            </p>
          </div>
        </div>
        <div className='space-y-1'>
          <Label htmlFor='agy-models'>模型 ID，每行一个</Label>
          <Textarea
            id='agy-models'
            value={models}
            onChange={(e) => setModels(e.target.value)}
          />
        </div>
        {modelIds.length ? (
          <div className='space-y-2'>
            <Label>推理强度（levels）</Label>
            <div className='space-y-1.5 rounded-md border p-2'>
              {modelIds.map((id) => {
                const active = levels[id] || []
                return (
                  <div
                    key={id}
                    className='flex flex-wrap items-center justify-between gap-2 text-xs'
                  >
                    <span className='font-mono break-all'>{id}</span>
                    <div className='flex flex-wrap gap-3'>
                      {ANTIGRAVITY_REASONING_LEVELS.map((level) => (
                        <div key={level} className='flex items-center gap-1'>
                          <Checkbox
                            id={`agy-level-${id}-${level}`}
                            checked={active.includes(level)}
                            onCheckedChange={(checked) =>
                              toggleLevel(id, level, checked === true)
                            }
                          />
                          <Label
                            htmlFor={`agy-level-${id}-${level}`}
                            className='text-xs font-normal'
                          >
                            {level}
                          </Label>
                        </div>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        ) : null}
        <Button
          size='sm'
          disabled={!routing.data || save.isPending}
          loading={save.isPending}
          onClick={() => save.mutate()}
        >
          保存平台配置
        </Button>
      </CardContent>
    </Card>
  )
}
