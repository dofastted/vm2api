import { useState } from 'react'
import { Download } from 'lucide-react'
import { ERROR_CLASS_IDS, ERROR_CLASS_META } from '@/lib/log-mute'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'

export type ExportScope = 'current' | 'all' | 'errors'
export type ExportWindow = '' | '1h' | '6h' | '24h' | '7d'

export type ExportOptions = {
  format: 'jsonl' | 'csv'
  scope: ExportScope
  /** 仅 scope='errors' 时生效；空 = 全部错误类。 */
  errorClass: string
  window: ExportWindow
  includeMuted: boolean
  limit: number
}

const WINDOWS: { value: ExportWindow; label: string }[] = [
  { value: '', label: '不覆盖起始时间' },
  { value: '1h', label: '近 1 小时' },
  { value: '6h', label: '近 6 小时' },
  { value: '24h', label: '近 24 小时' },
  { value: '7d', label: '近 7 天' },
]

const LIMITS = [500, 2000, 5000]

function ScopeOption({
  value,
  title,
  desc,
  children,
}: {
  value: ExportScope
  title: string
  desc?: string
  children?: React.ReactNode
}) {
  return (
    <Label className='flex cursor-pointer items-start gap-2.5 rounded-lg border border-border/60 p-3 font-normal transition-colors hover:border-border has-data-[state=checked]:border-primary/50 has-data-[state=checked]:bg-primary/5'>
      <RadioGroupItem value={value} className='mt-0.5' />
      <span className='min-w-0 flex-1 space-y-1'>
        <span className='block text-sm leading-none font-medium'>{title}</span>
        {desc ? (
          <span className='block text-xs leading-snug text-muted-foreground'>
            {desc}
          </span>
        ) : null}
        {children}
      </span>
    </Label>
  )
}

/**
 * 导出筛选对话框：JSONL/CSV 共用一套范围选择。
 * 后端 `GET /request-logs/export` 上限 5000 条，超出按最新截断（响应头回报）。
 */
export function ExportDialog({
  currentErrorClass,
  open,
  onOpenChange,
  currentSummary,
  onExport,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 「跟随当前筛选」的说明文案，由页面根据当前筛选态拼出。 */
  currentSummary: string
  /** 当前筛选已选定的错误类，由页面传入；没有选定时为 undefined。 */
  currentErrorClass?: string
  onExport: (opts: ExportOptions) => Promise<void>
}) {
  const [format, setFormat] = useState<'jsonl' | 'csv'>('jsonl')
  const [scope, setScope] = useState<ExportScope>('current')
  const [errorClass, setErrorClass] = useState('')
  const [window, setWindow] = useState<ExportWindow>('')
  const [includeMuted, setIncludeMuted] = useState(false)
  const [limit, setLimit] = useState(5000)
  const [exporting, setExporting] = useState(false)

  async function handleConfirm() {
    setExporting(true)
    try {
      await onExport({ format, scope, errorClass, window, includeMuted, limit })
      onOpenChange(false)
    } finally {
      setExporting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !exporting && onOpenChange(o)}>
      <DialogContent className='sm:max-w-md'>
        <DialogHeader>
          <DialogTitle>导出日志</DialogTitle>
          <DialogDescription>
            上限 {LIMITS[LIMITS.length - 1]} 条，超出按最新截断。
          </DialogDescription>
        </DialogHeader>
        <div className='space-y-4'>
          <div className='space-y-2'>
            <div className='text-xs font-medium text-muted-foreground'>
              范围
            </div>
            <RadioGroup
              value={scope}
              onValueChange={(v) => setScope(v as ExportScope)}
              className='gap-2'
            >
              <ScopeOption
                value='current'
                title='跟随当前筛选'
                desc={currentSummary}
              />
              <ScopeOption
                value='all'
                title='不按页面筛选'
                desc='包含已屏蔽的错误类，仍受时间和条数限制'
              />
              <ScopeOption value='errors' title='仅错误'>
                {scope === 'errors' ? (
                  <Select
                    value={errorClass || 'none'}
                    onValueChange={(v) => setErrorClass(v === 'none' ? '' : v)}
                  >
                    <SelectTrigger
                      size='sm'
                      className='mt-1.5 w-44'
                      onClick={(e) => e.preventDefault()}
                    >
                      <SelectValue placeholder='错误类' />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value='none'>全部错误类</SelectItem>
                      {ERROR_CLASS_IDS.map((c) => (
                        <SelectItem key={c} value={c}>
                          {ERROR_CLASS_META[c].label}（{c}）
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : null}
              </ScopeOption>
            </RadioGroup>
          </div>
          <div className='grid grid-cols-2 gap-3'>
            <div className='space-y-2'>
              <div className='space-y-1'>
                <div className='text-xs font-medium text-muted-foreground'>
                  时间窗
                </div>
                <p className='text-[11px] leading-snug text-muted-foreground'>
                  {scope === 'current'
                    ? '预设只替换起始时间，不改截止'
                    : '预设只设置起始时间，不设置截止'}
                </p>
              </div>
              <Select
                value={window || 'all'}
                onValueChange={(v) =>
                  setWindow(v === 'all' ? '' : (v as ExportWindow))
                }
              >
                <SelectTrigger size='sm' className='w-full'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WINDOWS.map((w) => (
                    <SelectItem key={w.value || 'all'} value={w.value || 'all'}>
                      {scope === 'current' && !w.value
                        ? '沿用当前筛选时间'
                        : w.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className='space-y-2'>
              <div className='text-xs font-medium text-muted-foreground'>
                条数上限
              </div>
              <Select
                value={String(limit)}
                onValueChange={(v) => setLimit(Number(v))}
              >
                <SelectTrigger size='sm' className='w-full'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LIMITS.map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {scope !== 'all' ? (
            (
              scope === 'current'
                ? !!currentErrorClass
                : scope === 'errors' && !!errorClass
            ) ? (
              <p className='text-sm text-muted-foreground'>
                按所选错误类导出，不受屏蔽设置影响
              </p>
            ) : (
              <Label className='flex cursor-pointer items-center justify-between gap-3 font-normal'>
                <span className='text-sm'>包含已屏蔽的错误类</span>
                <Switch
                  checked={includeMuted}
                  onCheckedChange={setIncludeMuted}
                />
              </Label>
            )
          ) : null}
          <div className='space-y-2'>
            <div className='text-xs font-medium text-muted-foreground'>
              格式
            </div>
            <RadioGroup
              value={format}
              onValueChange={(v) => setFormat(v as 'jsonl' | 'csv')}
              className='flex gap-4'
            >
              <Label className='flex cursor-pointer items-center gap-2 font-normal'>
                <RadioGroupItem value='jsonl' />
                <span className='text-sm'>JSONL</span>
              </Label>
              <Label className='flex cursor-pointer items-center gap-2 font-normal'>
                <RadioGroupItem value='csv' />
                <span className='text-sm'>CSV</span>
              </Label>
            </RadioGroup>
          </div>
        </div>
        <DialogFooter>
          <Button
            variant='outline'
            onClick={() => onOpenChange(false)}
            disabled={exporting}
          >
            取消
          </Button>
          <Button onClick={() => void handleConfirm()} loading={exporting}>
            <Download className='size-4' />
            导出
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
