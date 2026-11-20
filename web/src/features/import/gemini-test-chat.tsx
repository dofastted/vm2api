import { useId, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { api, isApiError } from '@/lib/api'
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
import { TestChatResultCard } from '@/features/vm/test-chat-result-card'
import type { TestChatResult } from '@/features/vm/test-chat-types'
import type { GeminiEnvironment } from './gemini-environments'

export function GeminiTestChat({
  environment,
  payloadReady,
}: {
  environment: GeminiEnvironment
  payloadReady: boolean
}) {
  const modelId = useId()
  const promptId = useId()
  const [open, setOpen] = useState(false)
  const [choice, setChoice] = useState('')
  const [prompt, setPrompt] = useState('请回复 pong。')
  const models = environment.models.filter((model) =>
    model.startsWith('gemini-')
  )
  const model = models.includes(choice) ? choice : (models[0] ?? '')
  const blocked =
    environment.auth_state !== 'authorized'
      ? '请先完成此环境的账号授权。'
      : environment.auth_method !== 'api_key'
        ? '当前签名载荷不支持 Google OAuth 推理测试。'
        : !payloadReady
          ? '请先兑换本机 CRAGGemini 载荷。'
          : environment.proxy_ready === false
            ? '绑定代理不可用，请检查代理后再试。'
            : !model
              ? '请先刷新账号数据，读取可用模型。'
              : null
  const test = useMutation({
    mutationFn: () =>
      api<TestChatResult>(
        `/api/panel/gemini/environments/${encodeURIComponent(environment.id)}/test-chat`,
        {
          method: 'POST',
          body: JSON.stringify({ model, prompt }),
        }
      ),
  })
  const result = test.isError
    ? {
        ok: false,
        log: [],
        duration_ms: 0,
        error: {
          ...(isApiError(test.error) && {
            code: test.error.code,
            status: test.error.status,
          }),
          message: test.error.message,
        },
      }
    : (test.data ?? null)

  return (
    <div className='space-y-3'>
      <Button
        type='button'
        variant='outline'
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        测试对话
      </Button>
      {open ? (
        <>
          <Card>
            <CardHeader className='pb-2'>
              <CardTitle className='text-sm'>发一条测试对话</CardTitle>
            </CardHeader>
            <CardContent className='pt-0'>
              {blocked ? (
                <p role='status' className='text-sm text-muted-foreground'>
                  {blocked}
                </p>
              ) : (
                <form
                  className='space-y-3'
                  onSubmit={(event) => {
                    event.preventDefault()
                    if (
                      !test.isPending &&
                      prompt.trim() &&
                      new TextEncoder().encode(prompt).length <= 4096
                    )
                      test.mutate()
                  }}
                >
                  <p className='text-sm text-muted-foreground'>
                    使用此环境的 API Key 和绑定代理调用
                    Google。测试可能产生上游用量。
                  </p>
                  <div className='space-y-1.5'>
                    <Label htmlFor={modelId}>模型</Label>
                    <Select
                      value={model}
                      onValueChange={setChoice}
                      disabled={test.isPending}
                    >
                      <SelectTrigger id={modelId} className='max-w-full'>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {models.map((id) => (
                          <SelectItem key={id} value={id}>
                            {id}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className='space-y-1.5'>
                    <Label htmlFor={promptId}>测试内容</Label>
                    <Textarea
                      id={promptId}
                      value={prompt}
                      maxLength={4096}
                      readOnly={test.isPending}
                      onChange={(event) => setPrompt(event.target.value)}
                      required
                    />
                    {new TextEncoder().encode(prompt).length > 4096 ? (
                      <p role='status' className='text-sm text-destructive'>
                        测试内容最多 4096 字节。
                      </p>
                    ) : null}
                  </div>
                  <Button
                    type='submit'
                    disabled={
                      test.isPending ||
                      !prompt.trim() ||
                      new TextEncoder().encode(prompt).length > 4096
                    }
                  >
                    {test.isPending ? '测试中…' : '开始测试'}
                  </Button>
                </form>
              )}
            </CardContent>
          </Card>
          {!blocked || result || test.isPending ? (
            <TestChatResultCard result={result} running={test.isPending} />
          ) : null}
        </>
      ) : null}
    </div>
  )
}
