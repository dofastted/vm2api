import { useEffect, useMemo, useState } from 'react'
import type { OverlayPreset, PersonaPreset } from '@/types/panel-routing'
import {
  DEFAULT_OVERLAY_TEMPLATES,
  DEFAULT_PERSONA_TEMPLATES,
  OVERLAY_PRESET_OPTIONS,
  OVERLAY_TEMPLATE_KEYS,
  OVERLAY_TEMPLATE_VARS,
  PERSONA_PRESETS,
  PERSONA_PRESET_OPTIONS,
  PERSONA_STANDING_MAX,
  PREVIEW_VARS,
  type OverlayTemplateKey,
  formatLineError,
  overlayDisabledByPersona,
  overlayPresetFromCompat,
  parsePersonaTemplateLines,
  personaExplain,
  personaHidesFromCompat,
  personaPresetFromCompat,
  personaPresetLabel,
  presetSeed,
  renderOverlayTemplate,
  renderPersonaTemplate,
  stringifyPersonaTemplate,
  validatePersonaTemplate,
} from '@/lib/persona-template'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { SettingRow } from '@/components/setting-row'
import { StatusMark } from '@/components/status-mark'
import {
  type OverlayDrafts,
  type PersonaDrafts,
  overlayTemplatesPayload,
  personaSchemeSummary,
  PERSONA_SCHEME_BLURB,
  personaTemplatesPayload,
  seedOverlayDrafts,
  seedPersonaDrafts,
} from '@/features/settings/persona-drafts'
import {
  BlockNotes,
  Notice,
  Problems,
  RadioRow,
  VarsHint,
} from '@/features/settings/persona-editors'
import { PersonaPresetDialog } from '@/features/settings/persona-preset-dialog'

type Compat = Record<string, unknown>

export function PersonaPane({
  compat,
  onChange,
  onProblemsChange,
}: {
  compat: Compat
  onChange: (next: Compat) => void
  onProblemsChange?: (problems: string[]) => void
}) {
  const [personaDrafts, setPersonaDrafts] = useState<PersonaDrafts | null>(null)
  const [overlayDrafts, setOverlayDrafts] = useState<OverlayDrafts | null>(null)
  const [dialogPreset, setDialogPreset] = useState<PersonaPreset | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)

  // routing 是异步到达的：第一帧 compat 可能还是空对象，此时不能定稿草稿。
  useEffect(() => {
    if (personaDrafts || !Object.keys(compat).length) return
    setPersonaDrafts(seedPersonaDrafts(compat))
    setOverlayDrafts(seedOverlayDrafts(compat))
  }, [compat, personaDrafts])

  const preset = personaPresetFromCompat(compat)
  const forced = overlayDisabledByPersona(preset)
  const overlay: OverlayPreset = forced
    ? 'off'
    : overlayPresetFromCompat(compat)
  const standing = String(compat.persona_standing ?? '')
  const hidesOn = personaHidesFromCompat(compat)

  const overlayKey: OverlayTemplateKey =
    overlay === 'off' ? 'official' : overlay
  const overlayText = overlayDrafts?.[overlayKey] ?? ''

  const parsedOverlay = useMemo(
    () => parsePersonaTemplateLines(overlayText),
    [overlayText]
  )

  const problems = useMemo(() => {
    if (!personaDrafts || !overlayDrafts) return []
    const out: string[] = []
    const label = (key: string, active: boolean) => (active ? '' : `「${key}」`)
    for (const key of PERSONA_PRESETS) {
      const parsed = parsePersonaTemplateLines(personaDrafts[key])
      const at = label(personaPresetLabel(key), key === preset)
      for (const err of parsed.errors)
        out.push(`人设模板${at}${formatLineError(err)}`)
      for (const msg of validatePersonaTemplate(parsed.blocks))
        out.push(`人设模板${at}${msg}`)
    }
    if (overlay !== 'off') {
      for (const key of OVERLAY_TEMPLATE_KEYS) {
        const parsed = parsePersonaTemplateLines(overlayDrafts[key])
        const at = label(key, key === overlayKey)
        for (const err of parsed.errors)
          out.push(`overlay 模板${at}${formatLineError(err)}`)
        for (const msg of validatePersonaTemplate(parsed.blocks, {
          overlay: true,
        }))
          out.push(`overlay 模板${at}${msg}`)
      }
    }
    // 后端用未 trim 的原串长度判定，UI 计数器同样不能先 trim
    if (standing.length > PERSONA_STANDING_MAX) {
      out.push(`常驻约束超过 ${PERSONA_STANDING_MAX} 字符`)
    }
    return out
  }, [personaDrafts, overlayDrafts, preset, overlay, overlayKey, standing])

  useEffect(() => {
    onProblemsChange?.(problems)
  }, [problems, onProblemsChange])

  const commit = (
    nextPersona: PersonaDrafts,
    nextOverlay: OverlayDrafts,
    patch: Compat = {}
  ) => {
    onChange({
      ...compat,
      ...patch,
      persona_templates: personaTemplatesPayload(nextPersona),
      overlay_templates: overlayTemplatesPayload(nextOverlay),
    })
  }

  const setPersonaDraft = (key: PersonaPreset, text: string) => {
    if (!personaDrafts || !overlayDrafts) return
    const next = { ...personaDrafts, [key]: text }
    setPersonaDrafts(next)
    commit(next, overlayDrafts)
  }

  const setOverlayText = (text: string) => {
    if (!personaDrafts || !overlayDrafts) return
    const next = { ...overlayDrafts, [overlayKey]: text }
    setOverlayDrafts(next)
    commit(personaDrafts, next)
  }

  const openScheme = (key: PersonaPreset) => {
    setDialogPreset(key)
    setDialogOpen(true)
  }

  const selectPreset = (next: PersonaPreset) => {
    if (!personaDrafts || !overlayDrafts) return
    commit(personaDrafts, overlayDrafts, { persona_preset: next })
    if (next === 'zero') openScheme('zero')
  }

  const previewJson = useMemo(() => {
    if (!personaDrafts) return ''
    const parsed = parsePersonaTemplateLines(personaDrafts[preset])
    const effective = parsed.blocks.length
      ? parsed.blocks
      : presetSeed(DEFAULT_PERSONA_TEMPLATES, preset)
    const vars = {
      ...PREVIEW_VARS,
      standing: standing.trim() || PREVIEW_VARS.standing,
    }
    const out: Record<string, unknown> = {
      system: renderPersonaTemplate(effective, vars),
    }
    if (overlay !== 'off') {
      const text = renderOverlayTemplate(parsedOverlay.blocks, vars)
      if (text) {
        out.messages = [
          { role: 'user', content: `${text}<调用方首条 user 原文>` },
        ]
      }
    }
    // 允许的例外：这是「仅预览」的出站形态示意，不是可编辑配置。
    return JSON.stringify(out, null, 2)
  }, [personaDrafts, parsedOverlay.blocks, overlay, standing, preset])

  const overlayCustomEmpty =
    overlay === 'custom' && parsedOverlay.blocks.length === 0

  if (!personaDrafts || !overlayDrafts) {
    return (
      <p className='text-sm text-muted-foreground'>正在读取当前人设配置…</p>
    )
  }

  const editing = dialogPreset ?? 'official'

  return (
    <div className='space-y-3'>
      <Card>
        <CardHeader className='pb-2'>
          <CardTitle className='text-sm'>人设方案</CardTitle>
        </CardHeader>
        <CardContent className='space-y-3'>
          <p className='text-xs leading-relaxed text-muted-foreground'>
            这是出站协议的唯一配置入口。保存后所有槽位跟随本页方案。决定非官方{' '}
            <code>/v1</code> 出站怎么写
            system。主页只选方案；点「配置」才进该方案的编辑器。官方 Claude Code
            系列原生请求整包跳过，不受这里影响。
          </p>

          <RadioGroup
            value={preset}
            onValueChange={(v) => selectPreset(v as PersonaPreset)}
            className='gap-0 divide-y divide-border/60 rounded-md border border-border/60'
            name='persona-preset'
          >
            {PERSONA_PRESET_OPTIONS.map(([key, label]) => {
              const active = key === preset
              return (
                <div
                  key={key}
                  className={cn(
                    'flex items-start gap-3 px-3 py-3',
                    active && 'bg-muted/30'
                  )}
                >
                  <RadioGroupItem
                    id={`persona-preset-${key}`}
                    value={key}
                    className='mt-1'
                  />
                  <div className='min-w-0 flex-1 space-y-1'>
                    <div className='flex flex-wrap items-center gap-2'>
                      <Label
                        htmlFor={`persona-preset-${key}`}
                        className='text-sm font-medium'
                      >
                        {label}
                      </Label>
                      {active ? (
                        <StatusMark
                          variant='pill'
                          tone={{
                            key: 'ok',
                            cls: 'ok',
                            text: '当前启用',
                            label: '当前启用',
                          }}
                        />
                      ) : null}
                    </div>
                    <p className='text-xs leading-relaxed text-muted-foreground'>
                      {PERSONA_SCHEME_BLURB[key]}
                    </p>
                    <p className='font-mono text-[11px] leading-relaxed text-muted-foreground'>
                      {personaSchemeSummary(personaDrafts[key], key)}
                    </p>
                  </div>
                  <Button
                    type='button'
                    size='sm'
                    variant='outline'
                    aria-label={`配置${label}`}
                    onClick={() => openScheme(key)}
                  >
                    配置
                  </Button>
                </div>
              )
            })}
          </RadioGroup>

          <p className='text-xs leading-relaxed text-muted-foreground'>
            {personaExplain(preset)}
          </p>

          <SettingRow
            label='系统遮罩'
            desc='开：对调用方隐藏网关注入的 system usage。关：回包按上游原值。官方 Claude Code 入站不受影响。0 注入方案里这个开关更显眼，点配置打开。'
          >
            <Switch
              checked={hidesOn}
              onCheckedChange={(v) =>
                commit(personaDrafts, overlayDrafts, { persona_hides: v })
              }
            />
          </SettingRow>
        </CardContent>
      </Card>

      <PersonaPresetDialog
        preset={editing}
        open={dialogOpen}
        text={personaDrafts[editing]}
        hidesOn={hidesOn}
        onOpenChange={setDialogOpen}
        onTextChange={(text) => setPersonaDraft(editing, text)}
        onHidesChange={(on) =>
          commit(personaDrafts, overlayDrafts, { persona_hides: on })
        }
      />

      <Card>
        <CardHeader className='pb-2'>
          <CardTitle className='text-sm'>overlay</CardTitle>
        </CardHeader>
        <CardContent className='space-y-3'>
          <RadioRow
            name='overlay-preset'
            value={overlay}
            options={OVERLAY_PRESET_OPTIONS}
            disabled={forced}
            onChange={(v) =>
              commit(personaDrafts, overlayDrafts, { overlay_preset: v })
            }
          />
          {forced ? (
            <Notice tone='caution'>
              0注入 方案不写
              overlay，这里已强制关闭。切回官方提示词或自定义会恢复原来的选择。
            </Notice>
          ) : null}
          {overlay === 'off' ? (
            <Notice tone='caution'>
              overlay 关闭：首条 user 原样透传，不写{' '}
              <code>&lt;system-reminder&gt;</code>。此时「白名单」页配的规则
              <b>整体不生效</b>，因为规则只有 overlay 这一条注入通道。
            </Notice>
          ) : (
            <>
              <div className='flex items-center justify-between gap-2'>
                <Label className='text-sm'>
                  overlay 模板（JSONL · 一个 wrapper + 若干 body）
                </Label>
                <Button
                  size='sm'
                  variant='ghost'
                  onClick={() =>
                    setOverlayText(
                      stringifyPersonaTemplate(
                        presetSeed(DEFAULT_OVERLAY_TEMPLATES, overlayKey)
                      )
                    )
                  }
                >
                  恢复预设
                </Button>
              </div>
              <Textarea
                className='h-32 font-mono text-xs'
                spellCheck={false}
                aria-label='overlay 模板 JSONL'
                value={overlayText}
                onChange={(e) => setOverlayText(e.target.value)}
              />
              <VarsHint vars={OVERLAY_TEMPLATE_VARS} />
              {overlayCustomEmpty ? (
                <Notice tone='caution'>
                  自定义 overlay 是空的，网关会静默回落到官方 overlay
                  预设。要真的不写 overlay，请把方案选成「关闭」。
                </Notice>
              ) : null}
              <BlockNotes blocks={parsedOverlay.blocks} />

              <div className='flex items-center justify-between gap-2'>
                <Label htmlFor='persona-standing' className='text-sm'>
                  常驻约束
                </Label>
                <span
                  className={cn('font-mono text-xs text-muted-foreground')}
                  style={
                    standing.length > PERSONA_STANDING_MAX
                      ? { color: 'var(--status-bad)' }
                      : undefined
                  }
                >
                  {standing.length} / {PERSONA_STANDING_MAX}
                </span>
              </div>
              <Textarea
                id='persona-standing'
                className='h-24 text-xs'
                spellCheck={false}
                placeholder='留空则用内置默认常驻约束'
                aria-label='常驻约束 persona_standing'
                value={standing}
                onChange={(e) =>
                  onChange({ ...compat, persona_standing: e.target.value })
                }
              />
              <p className='text-xs leading-relaxed text-muted-foreground'>
                这段是 <code>{'{{standing}}'}</code>{' '}
                的取值。留空则回落内置默认（身份 / 防泄漏 / 无工具 / 不提 CLI
                四条）。超过 {PERSONA_STANDING_MAX} 字符会被拒绝保存。
              </p>
            </>
          )}
        </CardContent>
      </Card>

      <Problems items={problems} />

      <Card>
        <CardHeader className='pb-2'>
          <CardTitle className='text-sm'>出站预览</CardTitle>
        </CardHeader>
        <CardContent className='space-y-2'>
          <p className='text-xs text-muted-foreground'>
            <b>仅预览，非可编辑 JSON</b>
            ：把上面的模板按占位符样例插值后的出站形态，长文本已截断。纯前端计算，不发请求。
          </p>
          <pre className='max-h-80 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed'>
            {previewJson}
          </pre>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className='pb-2'>
          <CardTitle className='text-sm'>其它协议行为</CardTitle>
        </CardHeader>
        <CardContent className='space-y-2 text-xs text-muted-foreground'>
          <p>
            <b>缓存 TTL</b>：默认 5m（1.25×）；请求头可升 1h 或入站{' '}
            <code>cache_control</code> 为 1h 时才升到 1h（2×）。TTL
            只给断点定时，断点由下面「缓存断点」决定 —— 一个断点都没有时 TTL
            不产生任何缓存。
          </p>
          <p>
            <b>web_search</b>：末轮 user 提到搜索 / search / web search
            才补；请求里 <code>web_search=false</code> 仍可关掉。
          </p>
          <p>
            <b>会话</b>：官方 Claude Code 沿用调用方
            session，其它客户端由网关自造 UUID。
          </p>
          <p>
            <b>回给客户端的用量</b>：去掉网关写入的官方 system / 注入的 tools /
            官方 cache；保留用户原文、用户声明的 tools、调用方追加的
            system。官方 Claude Code 不改用量数字。
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
