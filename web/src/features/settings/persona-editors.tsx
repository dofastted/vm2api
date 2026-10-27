import { Plus, Trash2 } from 'lucide-react'
import { PERSONA_TEMPLATE_VARS, type RawBlock } from '@/lib/persona-template'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'

export function VarsHint({ vars }: { vars: [string, string][] }) {
  return (
    <div className='flex flex-wrap gap-1'>
      {vars.map(([name, note]) => (
        <code
          key={name}
          title={note}
          className='rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground'
        >
          {`{{${name}}}`}
        </code>
      ))}
    </div>
  )
}

function cacheControlOf(block: RawBlock): {
  ttl: string
  scope: string
} {
  const cc = block.cache_control
  if (!cc || typeof cc !== 'object' || Array.isArray(cc))
    return { ttl: '', scope: '' }
  const rec = cc as Record<string, unknown>
  return {
    ttl: typeof rec.ttl === 'string' ? rec.ttl : '',
    scope: typeof rec.scope === 'string' ? rec.scope : '',
  }
}

function withCacheControl(
  block: RawBlock,
  ttl: string,
  scope: string
): RawBlock {
  const next = { ...block }
  const prev = block.cache_control
  const cc: Record<string, unknown> =
    prev && typeof prev === 'object' && !Array.isArray(prev) ? { ...prev } : {}
  if (ttl.trim()) {
    if (cc.type == null) cc.type = 'ephemeral'
    cc.ttl = ttl.trim()
  } else {
    delete cc.ttl
  }
  if (scope.trim()) cc.scope = scope.trim()
  else delete cc.scope
  if (Object.keys(cc).length === 0) delete next.cache_control
  else next.cache_control = cc
  return next
}

function withFlag(
  block: RawBlock,
  key: 'hide' | 'drop_if_empty',
  on: boolean
): RawBlock {
  const next = { ...block }
  if (on) next[key] = true
  else delete next[key]
  return next
}

function PersonaBlockCard({
  block,
  index,
  onChange,
  onRemove,
}: {
  block: RawBlock
  index: number
  onChange: (block: RawBlock) => void
  onRemove: () => void
}) {
  const cache = cacheControlOf(block)
  const n = index + 1
  return (
    <div className='rounded-lg border border-border/60 bg-card'>
      <div className='flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border/40 px-3 py-2'>
        <span className='w-4 font-mono text-[11px] text-muted-foreground tabular-nums'>
          {n}
        </span>
        <Input
          className='h-7 w-32 font-mono text-xs'
          value={String(block.id ?? '')}
          placeholder='id'
          aria-label={`第 ${n} 块 id`}
          onChange={(e) => onChange({ ...block, id: e.target.value })}
        />
        <label className='flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground'>
          <Switch
            checked={block.hide === true}
            onCheckedChange={(on) => onChange(withFlag(block, 'hide', on))}
          />
          遮罩
        </label>
        <label className='flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground'>
          <Switch
            checked={block.drop_if_empty === true}
            onCheckedChange={(on) =>
              onChange(withFlag(block, 'drop_if_empty', on))
            }
          />
          空丢
        </label>
        <Button
          type='button'
          size='icon'
          variant='ghost'
          className='ml-auto size-7 cursor-pointer text-muted-foreground hover:text-foreground'
          aria-label={`删除第 ${n} 块`}
          onClick={onRemove}
        >
          <Trash2 />
        </Button>
      </div>
      <div className='space-y-2 p-3'>
        <Textarea
          className='min-h-16 font-mono text-xs'
          spellCheck={false}
          value={typeof block.text === 'string' ? block.text : ''}
          aria-label={`第 ${n} 块内容`}
          onChange={(e) => onChange({ ...block, text: e.target.value })}
        />
        <div className='flex items-center gap-2'>
          <span className='font-mono text-[10px] text-muted-foreground'>
            cache
          </span>
          <Input
            className='h-7 w-16 font-mono text-xs'
            value={cache.ttl}
            placeholder='ttl'
            aria-label={`第 ${n} 块 cache ttl`}
            onChange={(e) =>
              onChange(withCacheControl(block, e.target.value, cache.scope))
            }
          />
          <Input
            className='h-7 w-20 font-mono text-xs'
            value={cache.scope}
            placeholder='scope'
            aria-label={`第 ${n} 块 cache scope`}
            onChange={(e) =>
              onChange(withCacheControl(block, cache.ttl, e.target.value))
            }
          />
        </div>
      </div>
    </div>
  )
}

function PersonaBlockFields({
  blocks,
  onChange,
}: {
  blocks: RawBlock[]
  onChange: (blocks: RawBlock[]) => void
}) {
  return (
    <div className='space-y-2'>
      {blocks.map((block, index) => (
        <PersonaBlockCard
          key={`${String(block.id ?? '')}-${index}`}
          block={block}
          index={index}
          onChange={(next) =>
            onChange(blocks.map((item, i) => (i === index ? next : item)))
          }
          onRemove={() => onChange(blocks.filter((_, i) => i !== index))}
        />
      ))}
      <Button
        type='button'
        size='sm'
        variant='outline'
        className='cursor-pointer'
        onClick={() =>
          onChange([
            ...blocks,
            { id: `block_${blocks.length + 1}`, type: 'text', text: '' },
          ])
        }
      >
        <Plus />
        加一块
      </Button>
    </div>
  )
}

/** 块表单 + JSONL 原文。JSONL 有错时只给原文，修好前块表单不可用。 */
export function PersonaTemplateEditor({
  text,
  blocks,
  hasErrors,
  onTextChange,
  onBlocksChange,
  vars = PERSONA_TEMPLATE_VARS,
}: {
  text: string
  blocks: RawBlock[]
  hasErrors: boolean
  onTextChange: (text: string) => void
  onBlocksChange: (blocks: RawBlock[]) => void
  vars?: [string, string][]
}) {
  const jsonl = (
    <Textarea
      className='h-40 font-mono text-xs'
      spellCheck={false}
      aria-label='system 模板 JSONL'
      value={text}
      onChange={(e) => onTextChange(e.target.value)}
    />
  )
  if (hasErrors) return jsonl
  return (
    <div className='space-y-3'>
      <PersonaBlockFields blocks={blocks} onChange={onBlocksChange} />
      <Collapsible>
        <CollapsibleTrigger asChild>
          <Button
            type='button'
            size='sm'
            variant='ghost'
            className='cursor-pointer font-mono text-xs'
          >
            JSONL
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className='space-y-2 pt-2'>
          {jsonl}
          <VarsHint vars={vars} />
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}

export function Problems({ items }: { items: string[] }) {
  if (!items.length) return null
  return (
    <ul
      className='space-y-1 rounded-md border px-3 py-2 text-xs'
      style={{
        color: 'var(--status-bad)',
        backgroundColor: 'var(--status-bad-bg)',
        borderColor: 'var(--status-bad)',
      }}
    >
      {items.map((msg, i) => (
        <li key={`${i}-${msg}`}>{msg}</li>
      ))}
    </ul>
  )
}

export function Notice({
  tone,
  children,
}: {
  tone: 'caution' | 'bad'
  children: React.ReactNode
}) {
  return (
    <p
      className='rounded-md border px-3 py-2 text-xs leading-relaxed'
      style={{
        color: `var(--status-${tone})`,
        backgroundColor: `var(--status-${tone}-bg)`,
        borderColor: `var(--status-${tone})`,
      }}
    >
      {children}
    </p>
  )
}
