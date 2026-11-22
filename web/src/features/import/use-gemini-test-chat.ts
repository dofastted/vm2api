import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api, isApiError } from '@/lib/api'
import {
  GEMINI_INVENTORY_KEY,
  type GeminiError,
  geminiError,
  useGeminiMutation,
} from './gemini-operations'

type TestInput = { model: string; prompt: string }
type TestSnapshot = {
  state: 'running' | 'completed' | 'failed'
  text: string
  usage?: {
    input_tokens?: number
    output_tokens?: number
    total_tokens?: number
  }
  error?: GeminiError
}
type TestResult = Omit<TestSnapshot, 'state'> & {
  state: TestSnapshot['state'] | 'cancelling' | 'cancelled'
  model: string
}
type Run = {
  poll: AbortController
  cancelled: boolean
  closed: boolean
}

function nextPoll(signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, 500)
    signal.addEventListener('abort', done, { once: true })
  })
}

export function useGeminiTestChat(resource: string) {
  const client = useQueryClient()
  const mounted = useRef(false)
  const active = useRef<Run | null>(null)
  const [result, setResult] = useState<TestResult | null>(null)
  const [cancelError, setCancelError] = useState<GeminiError | null>(null)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      const run = active.current
      if (!run) return
      run.closed = true
      run.poll.abort()
    }
  }, [])

  const test = useGeminiMutation({
    mutationFn: async (input: TestInput) => {
      if (!mounted.current) return
      const run: Run = {
        poll: new AbortController(),
        cancelled: false,
        closed: false,
      }
      active.current = run
      let latest: TestResult = {
        state: 'running',
        model: input.model,
        text: '',
      }
      const publish = (next: TestResult) => {
        latest = next
        if (!run.closed) setResult(next)
      }
      setCancelError(null)
      publish(latest)
      try {
        // Keep awaiting the start response on close so a late run ID can be cancelled.
        const { run_id } = await api<{ run_id: string }>(
          `${resource}/test-chat`,
          {
            method: 'POST',
            body: JSON.stringify(input),
          }
        )
        void client.invalidateQueries({ queryKey: GEMINI_INVENTORY_KEY })
        const statusPath = `${resource}/test-chat/${encodeURIComponent(run_id)}`
        const cancel = async () => {
          const ended = await api<{ cancelled: boolean }>(statusPath, {
            method: 'DELETE',
            signal: AbortSignal.timeout(10_000),
          })
          if (!ended.cancelled) throw new Error('Cancellation not confirmed')
        }
        while (true) {
          if (run.closed || run.cancelled) {
            try {
              await cancel()
              publish({ ...latest, state: 'cancelled' })
              return
            } catch (error) {
              if (run.closed) return
              if (isApiError(error) && error.status === 404) throw error
              setCancelError(
                geminiError(error, '未能取消测试，正在继续读取结果。')
              )
              run.cancelled = false
              run.poll = new AbortController()
              publish({ ...latest, state: 'running' })
            }
          }

          const signal = run.poll.signal
          try {
            const snapshot = await api<TestSnapshot>(statusPath, {
              signal,
              cache: 'no-store',
            })
            if (!signal.aborted) {
              publish({
                ...snapshot,
                model: input.model,
                // Snapshots are cumulative. Keep partial text if a final failure omits it.
                text: snapshot.text || latest.text,
                usage: snapshot.usage ?? latest.usage,
              })
              if (snapshot.state !== 'running') return
              await nextPoll(signal)
            }
          } catch (error) {
            if (signal.aborted) continue
            // Polling could fail while a paid upstream request is still running.
            // Cancel before releasing the mutation lock or showing a retry action.
            if (!isApiError(error) || error.status !== 404) {
              try {
                await cancel()
              } catch (cleanupError) {
                if (
                  !run.closed &&
                  (!isApiError(cleanupError) || cleanupError.status !== 404)
                ) {
                  setCancelError(
                    geminiError(
                      cleanupError,
                      '未能停止测试，正在重新读取结果。'
                    )
                  )
                  await nextPoll(signal)
                  continue
                }
              }
            }
            publish({
              ...latest,
              state: 'failed',
              error: geminiError(error, '读取测试结果失败。'),
            })
            return
          }
        }
      } catch (error) {
        publish({
          ...latest,
          state: 'failed',
          error: geminiError(error, '无法启动或继续测试。'),
        })
      } finally {
        active.current = null
      }
    },
    onSettled: () =>
      client.invalidateQueries({ queryKey: GEMINI_INVENTORY_KEY }),
  })

  function cancel() {
    const run = active.current
    if (!run || run.cancelled || run.closed) return
    run.cancelled = true
    setCancelError(null)
    setResult((current) => current && { ...current, state: 'cancelling' })
    run.poll.abort()
  }

  return {
    result,
    cancelError,
    running: test.isPending,
    start: test.mutate,
    cancel,
  }
}
