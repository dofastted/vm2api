import { useState } from 'react'
import type { PolicyQuestion } from '@/types/panel-routing'
import { Plus, X } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'

const MAX_QUESTIONS = 24
const MAX_INSTRUCTION_CHARS = 500

function nextId(label: string, rows: PolicyQuestion[]) {
  const base = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
  let id = /^[a-z]/.test(base) ? base : `q${Date.now().toString(36)}`
  const used = new Set(rows.map((row) => row.id))
  let n = 2
  while (used.has(id) || id === 'custom') {
    id = `${(base || 'q').slice(0, 28)}-${n++}`
  }
  return id.slice(0, 32)
}

/**
 * Questions the decision model answers in one call. Edits stay in the
 * parent's draft; nothing is saved until the stage's save bar.
 */
export function QuestionBank({
  rows,
  onChange,
}: {
  rows: PolicyQuestion[]
  onChange: (rows: PolicyQuestion[]) => void
}) {
  const [editing, setEditing] = useState<string | null>(null)
  const [composerOpen, setComposerOpen] = useState(false)
  const [label, setLabel] = useState('')
  const [summary, setSummary] = useState('')
  const [instructions, setInstructions] = useState('')

  const patch = (id: string, next: Partial<PolicyQuestion>) =>
    onChange(rows.map((row) => (row.id === id ? { ...row, ...next } : row)))

  const add = () => {
    const name = label.trim()
    const text = instructions.trim()
    if (!name || !text) {
      toast.error('先写名称和问句')
      return
    }
    if (rows.length >= MAX_QUESTIONS) {
      toast.error(`最多 ${MAX_QUESTIONS} 题`)
      return
    }
    onChange([
      ...rows,
      {
        id: nextId(name, rows),
        label: name,
        summary: summary.trim(),
        instructions: text.slice(0, MAX_INSTRUCTION_CHARS),
        enabled: true,
        builtin: false,
      },
    ])
    setLabel('')
    setSummary('')
    setInstructions('')
    setComposerOpen(false)
  }

  return (
    <div className='space-y-4'>
      <ul className='divide-y divide-[var(--hairline)] overflow-hidden rounded-xl border'>
        {rows.map((row) => {
          const len = row.instructions.length
          const isEditing = editing === row.id
          return (
            <li
              key={row.id}
              className={cn(
                'space-y-2.5 px-4 py-3.5 transition-colors duration-150',
                !row.enabled && 'bg-muted/25 opacity-70',
                isEditing && 'bg-select-surface/40'
              )}
            >
              <div className='flex items-start justify-between gap-3'>
                <div className='min-w-0'>
                  <div className='flex flex-wrap items-center gap-2'>
                    <p className='text-sm font-medium'>{row.label}</p>
                    {row.builtin ? (
                      <Badge variant='outline' className='font-normal'>
                        内置
                      </Badge>
                    ) : null}
                    {!row.enabled ? (
                      <span className='rounded bg-[var(--status-none-bg)] px-1.5 py-0.5 text-[11px] text-[var(--status-none)]'>
                        已停用
                      </span>
                    ) : null}
                    <span className='font-mono text-xs text-[var(--text-tertiary)]'>
                      {row.id}
                    </span>
                    <span
                      className={cn(
                        'font-mono text-[11px] tabular-nums',
                        len >= MAX_INSTRUCTION_CHARS
                          ? 'text-[var(--status-bad)]'
                          : len >= 450
                            ? 'text-[var(--status-warn)]'
                            : 'text-[var(--text-tertiary)]'
                      )}
                    >
                      {len}/{MAX_INSTRUCTION_CHARS} 字
                    </span>
                  </div>
                  {row.summary ? (
                    <p className='mt-0.5 text-xs text-muted-foreground'>
                      {row.summary}
                    </p>
                  ) : null}
                </div>
                <div className='flex shrink-0 items-center gap-1'>
                  <Switch
                    checked={row.enabled}
                    aria-label={`启用 ${row.label}`}
                    onCheckedChange={(on) => patch(row.id, { enabled: on })}
                  />
                  <Button
                    size='sm'
                    variant='ghost'
                    className='cursor-pointer'
                    onClick={() => setEditing(isEditing ? null : row.id)}
                  >
                    {isEditing ? '收起' : '编辑'}
                  </Button>
                  <Button
                    size='sm'
                    variant='ghost'
                    className='cursor-pointer text-destructive'
                    onClick={() => {
                      onChange(rows.filter((item) => item.id !== row.id))
                      if (isEditing) setEditing(null)
                    }}
                  >
                    删除
                  </Button>
                </div>
              </div>
              {isEditing ? (
                <div className='grid gap-3 pt-1'>
                  <div className='grid gap-3 sm:grid-cols-2'>
                    <div className='space-y-1.5'>
                      <Label htmlFor={`q-label-${row.id}`}>名称</Label>
                      <Input
                        id={`q-label-${row.id}`}
                        value={row.label}
                        onChange={(e) =>
                          patch(row.id, { label: e.target.value })
                        }
                      />
                    </div>
                    <div className='space-y-1.5'>
                      <Label htmlFor={`q-summary-${row.id}`}>说明</Label>
                      <Input
                        id={`q-summary-${row.id}`}
                        value={row.summary}
                        onChange={(e) =>
                          patch(row.id, { summary: e.target.value })
                        }
                      />
                    </div>
                  </div>
                  <div className='space-y-1.5'>
                    <div className='flex items-center justify-between gap-2'>
                      <Label htmlFor={`q-text-${row.id}`}>问句</Label>
                      <span
                        className={cn(
                          'font-mono text-xs tabular-nums',
                          len >= MAX_INSTRUCTION_CHARS
                            ? 'text-[var(--status-bad)]'
                            : len >= 450
                              ? 'text-[var(--status-warn)]'
                              : 'text-muted-foreground'
                        )}
                      >
                        {len} / {MAX_INSTRUCTION_CHARS}
                      </span>
                    </div>
                    <Textarea
                      id={`q-text-${row.id}`}
                      rows={4}
                      maxLength={MAX_INSTRUCTION_CHARS}
                      value={row.instructions}
                      onChange={(e) =>
                        patch(row.id, { instructions: e.target.value })
                      }
                    />
                  </div>
                </div>
              ) : (
                <p className='max-w-[75ch] text-sm leading-6 text-muted-foreground'>
                  {row.instructions}
                </p>
              )}
            </li>
          )
        })}
        {rows.length ? null : (
          <li className='px-4 py-6 text-sm text-muted-foreground'>
            还没有题目。可以新增自定义题目，或恢复内置题目。
          </li>
        )}
      </ul>

      {composerOpen ? (
        <div className='space-y-3 rounded-xl border border-dashed border-select-border/60 bg-muted/20 p-4'>
          <div className='flex items-center justify-between gap-2'>
            <p className='text-sm font-medium'>新增审核题目</p>
            <Button
              type='button'
              size='sm'
              variant='ghost'
              className='h-7 cursor-pointer px-2 text-xs'
              onClick={() => setComposerOpen(false)}
            >
              <X className='size-3.5' aria-hidden='true' />
              收起
            </Button>
          </div>
          <div className='grid gap-3 sm:grid-cols-2'>
            <div className='space-y-1.5'>
              <Label htmlFor='new-question-label'>新题名称</Label>
              <Input
                id='new-question-label'
                value={label}
                placeholder='例如 诈骗'
                onChange={(e) => setLabel(e.target.value)}
              />
            </div>
            <div className='space-y-1.5'>
              <Label htmlFor='new-question-summary'>说明</Label>
              <Input
                id='new-question-summary'
                value={summary}
                placeholder='一句话，列表里显示'
                onChange={(e) => setSummary(e.target.value)}
              />
            </div>
          </div>
          <div className='space-y-1.5'>
            <div className='flex items-center justify-between gap-2'>
              <Label htmlFor='new-question-text'>问句</Label>
              <span className='font-mono text-xs text-muted-foreground tabular-nums'>
                {instructions.length} / {MAX_INSTRUCTION_CHARS}
              </span>
            </div>
            <Textarea
              id='new-question-text'
              rows={3}
              maxLength={MAX_INSTRUCTION_CHARS}
              value={instructions}
              placeholder='这段话是否可以提交给模型，并且不涉及……？高分表示安全。'
              onChange={(e) => setInstructions(e.target.value)}
            />
          </div>
          <Button
            type='button'
            variant='outline'
            className='cursor-pointer'
            onClick={add}
          >
            加入题库
          </Button>
        </div>
      ) : (
        <Button
          type='button'
          size='sm'
          variant='outline'
          className='cursor-pointer'
          disabled={rows.length >= MAX_QUESTIONS}
          onClick={() => setComposerOpen(true)}
        >
          <Plus className='size-3.5' aria-hidden='true' />
          添加自定义题目（{rows.length}/{MAX_QUESTIONS}）
        </Button>
      )}
    </div>
  )
}
