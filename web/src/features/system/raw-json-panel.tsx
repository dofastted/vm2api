import { useEffect, useState } from 'react'
import { Check, Code2, Copy } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { canShowRawJson, resolveRawJsonOpen } from './raw-json'

export function RawJsonDisclosure({
  mode,
  buildPayload,
  className,
  controlledOpen,
  onControlledToggle,
}: {
  mode: string
  buildPayload: () => unknown
  className?: string
  controlledOpen?: boolean
  onControlledToggle?: (next: boolean) => void
}) {
  const [openForMode, setOpenForMode] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    setOpenForMode(null)
    setCopied(false)
  }, [mode])

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1600)
    return () => window.clearTimeout(timer)
  }, [copied])

  const allowed = canShowRawJson(mode)
  const isOpen =
    allowed &&
    (typeof controlledOpen === 'boolean'
      ? controlledOpen
      : resolveRawJsonOpen(openForMode, mode))

  if (!allowed) return null

  const formatted = isOpen ? JSON.stringify(buildPayload(), null, 2) : null

  const toggle = () => {
    const next = !isOpen
    if (onControlledToggle) {
      onControlledToggle(next)
      return
    }
    setOpenForMode(next ? mode : null)
  }

  return (
    <div className={cn('space-y-3', className)}>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <Button
          type='button'
          size='sm'
          variant={isOpen ? 'secondary' : 'outline'}
          className='h-8 gap-1.5 text-xs'
          aria-expanded={isOpen}
          data-testid='raw-json-toggle'
          onClick={toggle}
        >
          <Code2 className='size-3.5' aria-hidden />
          {isOpen ? '隐藏 JSON 原始内容' : '加载 JSON 原始内容'}
        </Button>
        {isOpen && formatted ? (
          <div className='flex items-center gap-2'>
            <span className='font-mono text-[11px] text-muted-foreground tabular-nums'>
              {formatted.length} 字符
            </span>
            <Button
              type='button'
              size='sm'
              variant='ghost'
              className='h-7 gap-1 px-2 text-xs'
              aria-label='复制 JSON 原始内容'
              onClick={() => {
                void navigator.clipboard.writeText(formatted)
                setCopied(true)
                toast.success('已复制 JSON')
              }}
            >
              {copied ? (
                <Check className='size-3.5 text-primary' aria-hidden />
              ) : (
                <Copy className='size-3.5' aria-hidden />
              )}
              {copied ? '已复制' : '复制 JSON'}
            </Button>
          </div>
        ) : null}
      </div>

      {isOpen && formatted ? (
        <div
          data-testid='raw-json-panel'
          className='animate-prompt-json-in overflow-hidden rounded-xl border border-border/70 bg-muted/45'
        >
          <pre className='max-h-72 overflow-auto px-3.5 py-3 font-mono text-[11px] leading-5 break-words whitespace-pre-wrap text-foreground/90'>
            {formatted}
          </pre>
        </div>
      ) : null}
    </div>
  )
}
