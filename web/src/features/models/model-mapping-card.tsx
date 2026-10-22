import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  ArrowRight,
  Plus,
  RotateCcw,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { routingQueryOptions } from '@/features/settings/queries'
import {
  ALIAS_PROBLEM_TEXT,
  AUTO_REVIEW_DEFAULT,
  type MappingRow,
  aliasProblem,
  mappingProblem,
  mappingRows,
  rowsToMap,
} from './model-mapping'

type Props = {
  /** Enabled GPT chat model ids, in catalog order. */
  targets: string[]
  /** Image model ids and snapshots; they cannot be aliases. */
  imageIds: string[]
}

function storedMappings(data: Record<string, unknown> | undefined) {
  const codex = data?.codex as { model_mappings?: Record<string, string> }
  return codex?.model_mappings || {}
}

export function ModelMappingCard({ targets, imageIds }: Props) {
  const qc = useQueryClient()
  const q = useQuery(routingQueryOptions())
  const serverMap = storedMappings(q.data)
  const serverSnap = JSON.stringify(rowsToMap(mappingRows(serverMap)))
  const [rows, setRows] = useState<MappingRow[]>([])

  useEffect(() => {
    setRows(mappingRows(JSON.parse(serverSnap)))
  }, [serverSnap])

  const problems = useMemo(
    () => rows.map((row, i) => aliasProblem(row.alias, rows, i, imageIds)),
    [rows, imageIds]
  )
  const dirty = JSON.stringify(rowsToMap(rows)) !== serverSnap
  const blocked =
    problems.some(Boolean) ||
    rows.some((row) => !row.target || mappingProblem(row.target, targets))

  const save = useMutation({
    mutationFn: () =>
      api('/api/panel/routing', {
        method: 'PUT',
        body: JSON.stringify({ codex: { model_mappings: rowsToMap(rows) } }),
      }),
    onSuccess: async () => {
      toast.success('模型映射已保存')
      await qc.invalidateQueries({ queryKey: routingQueryOptions().queryKey })
    },
    onError: (error: Error) => toast.error(error.message),
  })

  function patch(i: number, next: Partial<MappingRow>) {
    setRows((prev) =>
      prev.map((row, j) => (j === i ? { ...row, ...next } : row))
    )
  }

  return (
    <section className='rounded-2xl border border-border/70 bg-card p-4 shadow-sm'>
      <div className='flex flex-wrap items-start justify-between gap-3'>
        <div className='max-w-2xl space-y-1'>
          <h3 className='font-semibold'>模型映射</h3>
          <p className='text-sm leading-6 text-muted-foreground'>
            请求里的模型名命中别名时，网关把它改写成右侧的 GPT 模型再转发。
            <span className='font-mono'>codex-auto-review</span> 是 Codex
            自动审批审查（guardian）调用的隐藏模型。
          </p>
        </div>
        <div className='flex flex-wrap gap-2'>
          <Button
            variant='outline'
            size='sm'
            className='cursor-pointer gap-1.5'
            onClick={() =>
              setRows((prev) => [
                ...prev,
                { alias: '', target: targets[0] || '', fixed: false },
              ])
            }
          >
            <Plus className='size-3.5' />
            添加映射
          </Button>
          <Button
            size='sm'
            variant={dirty ? 'default' : 'outline'}
            className='cursor-pointer'
            disabled={!dirty || blocked || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? '保存中…' : dirty ? '保存映射' : '已保存'}
          </Button>
        </div>
      </div>

      <ul className='mt-4 space-y-2' aria-label='模型映射列表'>
        {rows.map((row, i) => {
          const aliasError = problems[i]
          const targetDisabled = row.target
            ? mappingProblem(row.target, targets)
            : null
          const options =
            targets.includes(row.target) || !row.target
              ? targets
              : [row.target, ...targets]
          return (
            <li
              key={row.fixed ? 'fixed' : i}
              className='grid gap-2 rounded-xl border border-border/60 bg-background/60 p-2.5 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,16rem)_auto] sm:items-start'
            >
              <div className='min-w-0 space-y-1'>
                {row.fixed ? (
                  <div className='flex h-9 items-center gap-2'>
                    <span className='truncate font-mono text-sm'>
                      {row.alias}
                    </span>
                    {row.target === AUTO_REVIEW_DEFAULT ? (
                      <Badge variant='secondary'>默认</Badge>
                    ) : null}
                  </div>
                ) : (
                  <Input
                    className={cn(
                      'h-9 font-mono text-sm',
                      aliasError && 'border-destructive'
                    )}
                    value={row.alias}
                    placeholder='别名，例如 my-review'
                    aria-label={`第 ${i + 1} 条映射的别名`}
                    aria-invalid={Boolean(aliasError)}
                    onChange={(e) => patch(i, { alias: e.target.value })}
                  />
                )}
                {aliasError ? (
                  <p className='text-xs text-destructive' role='alert'>
                    {ALIAS_PROBLEM_TEXT[aliasError]}
                  </p>
                ) : null}
              </div>
              <ArrowRight
                className='hidden size-4 self-center text-muted-foreground sm:block'
                aria-hidden
              />
              <div className='min-w-0 space-y-1'>
                <Select
                  value={row.target}
                  onValueChange={(value) => patch(i, { target: value })}
                >
                  <SelectTrigger
                    className='h-9 w-full font-mono'
                    aria-label={`${row.alias || `第 ${i + 1} 条映射`} 的目标模型`}
                  >
                    <SelectValue placeholder='选择 GPT 模型' />
                  </SelectTrigger>
                  <SelectContent>
                    {options.map((id) => (
                      <SelectItem key={id} value={id} className='font-mono'>
                        {id}
                        {targets.includes(id) ? '' : '（已停用）'}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {targetDisabled ? (
                  <p
                    className='flex items-center gap-1 text-xs text-[color:var(--status-caution)]'
                    role='alert'
                  >
                    <AlertTriangle className='size-3.5 shrink-0' />
                    目标已停用，请求会被拒绝（model_disabled）
                  </p>
                ) : null}
              </div>
              <div className='flex justify-end'>
                {row.fixed ? (
                  <Button
                    size='sm'
                    variant='ghost'
                    className='cursor-pointer gap-1.5'
                    disabled={row.target === AUTO_REVIEW_DEFAULT}
                    onClick={() => patch(i, { target: AUTO_REVIEW_DEFAULT })}
                  >
                    <RotateCcw className='size-3.5' />
                    恢复默认
                  </Button>
                ) : (
                  <Button
                    size='sm'
                    variant='ghost'
                    className='cursor-pointer gap-1.5'
                    aria-label={`删除映射 ${row.alias}`}
                    onClick={() =>
                      setRows((prev) => prev.filter((_, j) => j !== i))
                    }
                  >
                    <Trash2 className='size-3.5' />
                    删除
                  </Button>
                )}
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
