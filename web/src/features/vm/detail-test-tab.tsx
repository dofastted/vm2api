import type { Vm } from '@/types/panel-vm'
import { type CredType, credTypeLabel } from '@/lib/cred-type'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { TabsContent } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import {
  kernelRouteHint,
  kernelRouteLabel,
} from '@/features/vm/dataplane-contract'
import { TestChatResultCard } from '@/features/vm/test-chat-result-card'
import type { TestChatResult } from '@/features/vm/test-chat-types'

type VmTestTabProps = {
  vm: Vm
  models: { id: string; label?: string; display_name?: string }[]
  model: string
  prompt: string
  maxTokens: number
  reasoningEffort: string
  credType: CredType
  isCodex?: boolean
  dataplane?: string | null
  cragKernelVersion?: 'legacy' | 'v2' | null
  result: TestChatResult | null
  running: boolean
  modelsRefreshing: boolean
  onModelChange: (value: string) => void
  onPromptChange: (value: string) => void
  onMaxTokensChange: (value: number) => void
  onReasoningEffortChange: (value: string) => void
  onTest: () => void
  onRefreshModels: () => void
  canRefreshModels?: boolean
  schedule?: React.ReactNode
}

const CODEX_EFFORTS = [
  { id: 'none', label: 'none' },
  { id: 'low', label: 'low' },
  { id: 'medium', label: 'medium' },
  { id: 'high', label: 'high' },
  { id: 'xhigh', label: 'xhigh' },
  { id: 'max', label: 'max' },
  { id: 'ultra', label: 'ultra' },
] as const

export function VmTestTab(props: VmTestTabProps) {
  return (
    <TabsContent value='test' className='space-y-3 pt-4'>
      <VmTestPanel {...props} className='max-w-lg' />
    </TabsContent>
  )
}

/** 不依赖 Tabs 上下文的测试面板，详情页 Tab 与弹窗共用。 */
export function VmTestPanel(props: VmTestTabProps & { className?: string }) {
  const {
    vm,
    models,
    model,
    prompt,
    maxTokens,
    reasoningEffort,
    credType,
    isCodex = false,
    dataplane,
    cragKernelVersion,
    result,
    running,
    modelsRefreshing,
    onModelChange,
    onPromptChange,
    onMaxTokensChange,
    onReasoningEffortChange,
    onTest,
    onRefreshModels,
    canRefreshModels = true,
    schedule,
  } = props

  return (
    <>
      <Card className={props.className}>
        <CardHeader className='pb-2'>
          <CardTitle className='text-sm'>发一条测试对话</CardTitle>
        </CardHeader>
        <CardContent className='space-y-3 pt-0'>
          <div className='space-y-1.5'>
            <Label>模型</Label>
            <Select
              value={model || models[0]?.id || ''}
              onValueChange={onModelChange}
            >
              <SelectTrigger>
                <SelectValue placeholder='选择模型' />
              </SelectTrigger>
              <SelectContent>
                {models.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.label || m.display_name || m.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className='space-y-1.5'>
            <Label>Prompt</Label>
            <Textarea
              value={prompt}
              onChange={(event) => onPromptChange(event.target.value)}
            />
          </div>
          <div className='space-y-1.5'>
            <Label>{isCodex ? '思考档位' : '思考预算'}</Label>
            {isCodex ? (
              <Select
                value={reasoningEffort}
                onValueChange={onReasoningEffortChange}
              >
                <SelectTrigger className='w-40'>
                  <SelectValue placeholder='medium' />
                </SelectTrigger>
                <SelectContent>
                  {CODEX_EFFORTS.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                type='number'
                min={1}
                max={128000}
                className='w-32'
                value={maxTokens}
                onChange={(event) => {
                  const value = Number(event.target.value)
                  onMaxTokensChange(
                    !Number.isFinite(value) || value <= 0
                      ? 8192
                      : Math.min(128000, Math.max(1, Math.floor(value)))
                  )
                }}
              />
            )}
          </div>
          <div className='space-y-1'>
            <Label>凭证</Label>
            <p className='text-xs text-muted-foreground'>
              {isCodex
                ? 'GPT OAuth · Codex kernel / OpenAI Responses'
                : credType === 'none'
                  ? '无凭证 · 测试会被拒绝，请先导入凭证'
                  : `${credTypeLabel(credType)}${
                      credType === 'setup-token' || credType === 'apikey'
                        ? ' · 按 inference 入站，不走官方 Claude Code 四门'
                        : ' · 官方 Claude Code 入站'
                    }`}
            </p>
          </div>
          {isCodex ? null : (
            <div className='space-y-1'>
              <Label>内核</Label>
              <p className='text-xs text-muted-foreground'>
                {kernelRouteLabel(dataplane, cragKernelVersion)}。
                {kernelRouteHint(dataplane, cragKernelVersion)}
              </p>
            </div>
          )}
          <div className='flex gap-2'>
            <Button onClick={onTest} disabled={running} loading={running}>
              开始测试
            </Button>
            {canRefreshModels ? (
              <Button
                variant='ghost'
                onClick={onRefreshModels}
                loading={modelsRefreshing}
              >
                刷新列表
              </Button>
            ) : null}
          </div>
          {schedule}
        </CardContent>
      </Card>
      <TestChatResultCard result={result} running={running} vm={vm} />
    </>
  )
}
