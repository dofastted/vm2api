import type { ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
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
import { Textarea } from '@/components/ui/textarea'
import {
  type CatalogMode,
  type ModelPolicy,
  type PolicyDefaults,
  context1mWhitelist,
  isCatalogMode,
} from './policy'

type Props = {
  pol: ModelPolicy
  onCatalogMode: (mode: CatalogMode) => void
  onDefaults: (patch: Partial<PolicyDefaults>) => void
}

export function ModelAdvanced({ pol, onCatalogMode, onDefaults }: Props) {
  const defs = pol.defaults || {}
  const mode = isCatalogMode(pol.catalog_mode)
    ? pol.catalog_mode
    : 'worker_intersect_policy'
  const whitelistText = context1mWhitelist(pol).join('\n')

  return (
    <Collapsible className='mt-4 rounded-lg border border-border/70 bg-card'>
      <CollapsibleTrigger className='flex w-full cursor-pointer items-center justify-between px-3 py-2.5 text-left text-sm font-medium transition-colors duration-200 hover:bg-muted/40'>
        <span>高级：目录模式 · 默认参数</span>
        <ChevronDown className='size-4 text-muted-foreground' />
      </CollapsibleTrigger>
      <CollapsibleContent className='space-y-3 border-t border-border/40 px-3 py-3 text-sm'>
        <Row label='目录模式'>
          <Select
            value={mode}
            onValueChange={(v) => {
              if (isCatalogMode(v)) onCatalogMode(v)
            }}
          >
            <SelectTrigger className='h-8 w-[260px]'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='worker_intersect_policy'>
                Worker ∩ 策略（推荐）
              </SelectItem>
              <SelectItem value='worker_only'>仅 Worker 目录</SelectItem>
              <SelectItem value='policy_only'>仅策略矩阵</SelectItem>
            </SelectContent>
          </Select>
        </Row>
        <Row label='过滤 1M beta'>
          <div className='flex items-center gap-2'>
            <Switch
              checked={defs.strip_context_1m !== false}
              onCheckedChange={(on) => onDefaults({ strip_context_1m: on })}
              aria-label='过滤 1M beta'
            />
            <span className='text-xs text-muted-foreground'>
              {defs.strip_context_1m !== false ? '已开启' : '已关闭'}
            </span>
          </div>
        </Row>
        <div className='space-y-1'>
          <Label>未入库通配</Label>
          <Textarea
            className='min-h-[72px] font-mono text-xs'
            rows={3}
            value={whitelistText}
            placeholder='只兜底未设开关的新 id'
            onChange={(e) =>
              onDefaults({
                context_1m_whitelist: e.target.value
                  .split(/[\n,]+/)
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
          />
          <p className='text-xs text-muted-foreground'>
            行内「透传 / 剥离」优先。通配只覆盖未设开关的 dated id，例如
            claude-sonnet-5-日期。不要把 Fable / Opus 写进来。
          </p>
        </div>
        <Row label='规范化 thinking'>
          <div className='flex items-center gap-2'>
            <Switch
              checked={defs.normalize_thinking !== false}
              onCheckedChange={(on) => onDefaults({ normalize_thinking: on })}
            />
            <span className='text-xs text-muted-foreground'>
              {defs.normalize_thinking !== false ? '已开启' : '已关闭'}
            </span>
          </div>
        </Row>
        <Row label='fallback budget'>
          <Input
            className='h-8 w-[140px]'
            type='number'
            value={defs.thinking_fallback_budget ?? 4096}
            onChange={(e) =>
              onDefaults({
                thinking_fallback_budget: Number(e.target.value) || 0,
              })
            }
          />
        </Row>
        <Row label='默认 max_tokens'>
          <Input
            className='h-8 w-[140px]'
            type='number'
            value={defs.max_tokens ?? 16384}
            onChange={(e) =>
              onDefaults({ max_tokens: Number(e.target.value) || 0 })
            }
          />
        </Row>
      </CollapsibleContent>
    </Collapsible>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className='flex flex-wrap items-center gap-3'>
      <span className='w-32 shrink-0 text-muted-foreground'>{label}</span>
      {children}
    </div>
  )
}
