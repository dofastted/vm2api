import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'

const BIND_LIMITS = [1, 2, 3, 4, 5, 8, 10, 16, 20, 32]
const PROBE_MINS = [5, 10, 30, 60]

type ProxyPoolControlsProps = {
  bindLimit: number
  probeMin: number
  raw: string
  importing: boolean
  onBindLimitChange: (value: number) => void
  onProbeMinChange: (value: number) => void
  onRawChange: (value: string) => void
  onImport: () => void
  onAddLocal?: () => void
  addingLocal?: boolean
  hasLocal?: boolean
}

export function ProxyPoolControls(props: ProxyPoolControlsProps) {
  const {
    bindLimit,
    probeMin,
    raw,
    importing,
    onBindLimitChange,
    onProbeMinChange,
    onRawChange,
    onImport,
    onAddLocal,
    addingLocal,
    hasLocal,
  } = props

  return (
    <>
      <p className='mb-3 max-w-3xl text-sm text-muted-foreground'>
        一条 SOCKS5
        起一台透明网关；也可以加「本地出口」走宿主机默认路由。槽走默认路由做推理。探测只问出口是否在，不打
        Anthropic。
      </p>
      <div className='mb-4 flex flex-wrap items-center gap-3 text-sm'>
        <label className='flex items-center gap-2'>
          每条
          <Select
            value={String(bindLimit)}
            onValueChange={(value) => onBindLimitChange(Number(value))}
          >
            <SelectTrigger className='h-8 w-[88px]' aria-label='每条绑定上限'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {BIND_LIMITS.map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {n} 台
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <label className='flex items-center gap-2'>
          探测
          <Select
            value={String(probeMin)}
            onValueChange={(value) => onProbeMinChange(Number(value))}
          >
            <SelectTrigger className='h-8 w-[88px]' aria-label='探测间隔'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PROBE_MINS.map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {n} 分
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
      </div>
      <Card className='mb-4'>
        <CardHeader>
          <CardTitle className='text-base'>追加 SOCKS5</CardTitle>
        </CardHeader>
        <CardContent className='space-y-2'>
          <Label>
            host:port 或 user:pass@host:port，可多行。不会回显账密。
          </Label>
          <Textarea
            value={raw}
            onChange={(event) => onRawChange(event.target.value)}
            rows={4}
          />
          <div className='flex flex-wrap gap-2'>
            <Button
              onClick={onImport}
              disabled={!raw.trim() || importing}
              loading={importing}
            >
              导入
            </Button>
            {onAddLocal ? (
              <Button
                variant='outline'
                onClick={onAddLocal}
                disabled={addingLocal || hasLocal}
                loading={addingLocal}
              >
                {hasLocal ? '已有本地出口' : '添加本地出口'}
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>
    </>
  )
}
