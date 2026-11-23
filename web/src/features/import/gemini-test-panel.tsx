import { useId, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { isGeminiHostIssue } from '@/lib/gemini-recovery'
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
import { GeminiMaintenanceLink } from '@/features/settings/gemini-maintenance-link'
import type { GeminiEnvironment } from './gemini-environments'
import {
  GEMINI_INVENTORY_KEY,
  type GeminiError,
  geminiError,
  geminiResource,
  syncGeminiEnvironment,
  useGeminiBusy,
  useGeminiMutation,
} from './gemini-operations'
import { useGeminiTestChat } from './use-gemini-test-chat'

const MAX_PROMPT_BYTES = 4096
const promptEncoder = new TextEncoder()

const usageFields = [
  ['input_tokens', '输入'],
  ['output_tokens', '输出'],
  ['total_tokens', '总计'],
] as const

const resultLabels = {
  running: '正在测试…',
  cancelling: '正在取消…',
  cancelled: '测试已取消',
  completed: '测试完成',
  failed: '测试失败',
}

function ErrorMessage({ error }: { error: GeminiError }) {
  return (
    <div className='space-y-1'>
      <p role='alert' className='text-sm text-destructive'>
        {error.message}
        {error.code ? ` (${error.code})` : ''}
      </p>
      {isGeminiHostIssue(error.code) ? <GeminiMaintenanceLink /> : null}
    </div>
  )
}

export function GeminiTestPanel({
  environment,
}: {
  environment: GeminiEnvironment
}) {
  const client = useQueryClient()
  const busy = useGeminiBusy()
  const modelId = useId()
  const promptId = useId()
  const [model, setModel] = useState('')
  const [prompt, setPrompt] = useState('')
  const resource = geminiResource(environment.id)
  const test = useGeminiTestChat(resource)
  const isOAuth = environment.auth_method === 'oauth'
  const authorizationHint = isOAuth
    ? '请在「账号」完成 Google 授权后再试。'
    : '此 API Key 未处于已授权状态。'
  const unavailable =
    environment.auth_state !== 'authorized'
      ? authorizationHint
      : isOAuth && environment.oauth_imported
        ? '已导入 OAuth 凭据，仍需在「账号」完成官方 Google 授权后再测试。'
        : !environment.proxy_id || environment.proxy_ready === false
          ? '请在「代理」绑定可用的 IPv4 SOCKS5 代理。'
          : null
  const licenseBlocked =
    !unavailable &&
    isOAuth &&
    environment.crag_license &&
    environment.crag_license.valid === false
      ? '请先在「账号」绑定 CRAGGemini 订阅席位，再发起 OAuth 测试对话。'
      : null
  const pull = useGeminiMutation({
    mutationFn: () =>
      api<GeminiEnvironment>(`${resource}/models`, { method: 'POST' }),
    onSuccess: (updated) => syncGeminiEnvironment(client, updated),
    onError: () => client.invalidateQueries({ queryKey: GEMINI_INVENTORY_KEY }),
  })
  const modelError = pull.isError
    ? geminiError(pull.error, '拉取模型失败，请重试。')
    : null
  const models =
    environment.models_discovered === true &&
    modelError?.code !== 'gemini_models_empty'
      ? [...new Set(environment.models.filter(Boolean))]
      : []
  const selected = models.includes(model) ? model : ''
  const trimmedPrompt = prompt.trim()
  const promptTooLong =
    promptEncoder.encode(trimmedPrompt).length > MAX_PROMPT_BYTES
  const inputDisabled = busy || !!unavailable
  const startDisabled =
    inputDisabled ||
    Boolean(licenseBlocked) ||
    !selected ||
    !trimmedPrompt ||
    promptTooLong
  const result = test.result
  const usage = result?.usage

  return (
    <div className='min-w-0 space-y-3'>
      <Card>
        <CardHeader className='pb-2'>
          <CardTitle className='text-sm'>发一条 Gemini 测试对话</CardTitle>
        </CardHeader>
        <CardContent className='pt-0'>
          <form
            className='space-y-3'
            onSubmit={(event) => {
              event.preventDefault()
              if (!startDisabled) {
                test.start({ model: selected, prompt: trimmedPrompt })
              }
            }}
          >
            <p className='text-sm text-muted-foreground'>
              {isOAuth
                ? '使用此环境的 Google 授权。回复会在测试成功后显示。'
                : '使用此环境的 Gemini API Key。回复会在测试成功后显示。'}
            </p>
            {unavailable || licenseBlocked ? (
              <p role='status' className='text-sm text-muted-foreground'>
                {unavailable || licenseBlocked}
              </p>
            ) : null}
            <div className='space-y-1.5'>
              <Label htmlFor={modelId}>模型</Label>
              <Select
                value={selected}
                onValueChange={setModel}
                disabled={inputDisabled || !models.length}
              >
                <SelectTrigger id={modelId} className='w-full'>
                  <SelectValue
                    placeholder={
                      models.length ? '选择已发现的模型' : '请先拉取模型'
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {models.map((id) => (
                    <SelectItem value={id} key={id}>
                      {id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className='flex flex-wrap items-center gap-2'>
              <Button
                type='button'
                variant='outline'
                size='sm'
                disabled={inputDisabled}
                loading={pull.isPending}
                onClick={() => pull.mutate(undefined)}
              >
                拉取模型
              </Button>
              {pull.isSuccess ? (
                <p role='status' className='text-sm text-muted-foreground'>
                  {models.length
                    ? `已拉取 ${models.length} 个模型。`
                    : '未发现可用模型。'}
                </p>
              ) : null}
            </div>
            {modelError ? <ErrorMessage error={modelError} /> : null}
            <div className='space-y-1.5'>
              <Label htmlFor={promptId}>提示词</Label>
              <Textarea
                id={promptId}
                rows={4}
                maxLength={MAX_PROMPT_BYTES}
                value={prompt}
                disabled={inputDisabled}
                aria-invalid={promptTooLong}
                aria-describedby={`${promptId}-limit`}
                onChange={(event) => setPrompt(event.target.value)}
              />
              <p
                id={`${promptId}-limit`}
                className={
                  promptTooLong
                    ? 'text-xs text-destructive'
                    : 'text-xs text-muted-foreground'
                }
              >
                {promptTooLong ? '提示词过长，' : ''}上限 {MAX_PROMPT_BYTES} 个
                UTF-8 字节。
              </p>
            </div>
            <div className='flex flex-wrap gap-2'>
              <Button
                type='submit'
                disabled={startDisabled}
                loading={test.running}
              >
                开始测试
              </Button>
              {test.running ? (
                <Button
                  type='button'
                  variant='outline'
                  disabled={result?.state !== 'running'}
                  onClick={test.cancel}
                >
                  取消测试
                </Button>
              ) : null}
            </div>
          </form>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className='pb-2'>
          <CardTitle className='text-sm'>测试结果</CardTitle>
        </CardHeader>
        <CardContent className='min-w-0 space-y-3 pt-0'>
          <p
            role='status'
            className='text-sm break-words text-muted-foreground'
          >
            {result
              ? `${resultLabels[result.state]} · ${result.model}`
              : '尚未运行测试。'}
          </p>
          {result?.text ? (
            <div className='max-h-72 overflow-auto rounded-md border bg-muted/30 p-3 text-sm [overflow-wrap:anywhere] whitespace-pre-wrap'>
              {result.text}
            </div>
          ) : null}
          {usage ? (
            <dl className='flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums'>
              {usageFields.map(([key, label]) => {
                const count = usage[key]
                return count == null ? null : (
                  <div key={key} className='flex gap-1'>
                    <dt className='text-muted-foreground'>{label}</dt>
                    <dd>{count.toLocaleString()} tokens</dd>
                  </div>
                )
              })}
            </dl>
          ) : null}
          {result?.state === 'failed' ? (
            <ErrorMessage
              error={result.error ?? { message: 'Gemini 测试未完成。' }}
            />
          ) : null}
          {test.cancelError && result?.state === 'running' ? (
            <ErrorMessage error={test.cancelError} />
          ) : null}
        </CardContent>
      </Card>
    </div>
  )
}
