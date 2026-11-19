import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { TestModelsPayload, Vm } from '@/types/panel-vm'
import { toast } from 'sonner'
import { api, isApiError } from '@/lib/api'
import { isAntigravityVm, isCodexVm } from '@/lib/vm-kind'
import { testModelsQueryOptions } from '@/features/vm/queries'
import type { TestChatResult } from '@/features/vm/test-chat-types'
import { useVmPerms } from '@/features/vm/vm-perms'

/** 详情页测试 Tab 与列表弹窗共用：模型列表、参数、发送与结果。 */
export function useVmTestChat(vm: Vm) {
  const id = vm.id
  const qc = useQueryClient()
  const canTest = useVmPerms().testModels
  const testModels = useQuery({
    ...testModelsQueryOptions(id),
    enabled: canTest && !!id,
  })
  const [prompt, setPrompt] = useState('hello')
  const [model, setModel] = useState('')
  const [maxTokens, setMaxTokens] = useState(8192)
  const [reasoningEffort, setReasoningEffort] = useState('medium')
  const [result, setResult] = useState<TestChatResult | null>(null)
  const edited = useRef({
    model: false,
    prompt: false,
    maxTokens: false,
    reasoningEffort: false,
  })
  const models = useMemo(
    () => testModels.data?.items || testModels.data?.models || [],
    [testModels.data]
  )

  useEffect(() => {
    if (!models.length) return
    if (!model || !models.some((item) => item.id === model)) {
      setModel(models[0].id)
    }
  }, [models, model])

  const onModelChange = useCallback((value: string) => {
    edited.current.model = true
    setModel(value)
  }, [])
  const onPromptChange = useCallback((value: string) => {
    edited.current.prompt = true
    setPrompt(value)
  }, [])
  const onMaxTokensChange = useCallback((value: number) => {
    edited.current.maxTokens = true
    setMaxTokens(value)
  }, [])
  const onReasoningEffortChange = useCallback((value: string) => {
    edited.current.reasoningEffort = true
    setReasoningEffort(value)
  }, [])
  const onLoadSchedule = useCallback(
    (schedule: {
      model: string
      prompt: string
      max_tokens: number | null
      reasoning_effort: string | null
    }) => {
      if (!edited.current.model) setModel(schedule.model)
      if (!edited.current.prompt) setPrompt(schedule.prompt)
      if (isCodexVm(vm)) {
        if (!edited.current.reasoningEffort) {
          setReasoningEffort(schedule.reasoning_effort || 'medium')
        }
      } else if (!edited.current.maxTokens) {
        setMaxTokens(schedule.max_tokens || 64)
      }
    },
    [vm]
  )

  const send = useMutation({
    mutationFn: () =>
      api<TestChatResult>(
        `/api/panel/vms/${encodeURIComponent(id)}/test-chat`,
        {
          method: 'POST',
          body: JSON.stringify({
            model: model || models[0]?.id,
            prompt,
            ...(isCodexVm(vm)
              ? { reasoning_effort: reasoningEffort }
              : isAntigravityVm(vm)
                ? { max_tokens: maxTokens, reasoning_effort: reasoningEffort }
                : { max_tokens: maxTokens }),
          }),
        }
      ),
    onSuccess: (data) => {
      setResult(data)
      // 外层 envelope 的 ok 恒为 true（业务成败在剥壳后的 data.ok），
      // 所以失败也会走到这里 —— 不能只 toast.success。
      if (data?.ok) {
        toast.success(`测试成功 · ${data.duration_ms ?? 0}ms`)
      } else {
        const code = data?.error?.code
        const msg = data?.error?.message || '未知错误'
        toast.error(code ? `测试失败：[${code}] ${msg}` : `测试失败：${msg}`)
      }
    },
    onError: (error: Error) => {
      setResult({
        ok: false,
        duration_ms: 0,
        log: [],
        error: {
          message: error.message,
          ...(isApiError(error)
            ? {
                code: error.code || undefined,
                status: error.status || undefined,
                type: error.type,
              }
            : {}),
        },
      })
      const code = isApiError(error) ? error.code : ''
      toast.error(code ? `测试失败：[${code}] ${error.message}` : error.message)
    },
  })

  const refreshModels = useMutation({
    mutationFn: () =>
      api<TestModelsPayload>(
        `/api/panel/test-models?vm_id=${encodeURIComponent(id)}&refresh=1`
      ),
    onSuccess: (data) => {
      qc.setQueryData(testModelsQueryOptions(id).queryKey, data)
    },
    onError: (error: Error) => {
      toast.error(error.message || '刷新模型失败')
    },
  })

  return {
    models,
    model,
    prompt,
    maxTokens,
    reasoningEffort,
    result,
    running: send.isPending,
    modelsRefreshing: testModels.isFetching || refreshModels.isPending,
    canRefreshModels: canTest,
    onModelChange,
    onPromptChange,
    onMaxTokensChange,
    onReasoningEffortChange,
    onLoadSchedule,
    onTest: () => {
      setResult(null)
      send.mutate()
    },
    onRefreshModels: () => {
      if (!refreshModels.isPending) refreshModels.mutate()
    },
  }
}
