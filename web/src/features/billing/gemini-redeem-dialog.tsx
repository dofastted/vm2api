import { useId, useRef, useState, type FormEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api, isApiError } from '@/lib/api'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { geminiInventoryOptions } from '@/features/import/gemini-environments'

export function GeminiRedeemDialog() {
  const [open, setOpen] = useState(false)
  const [code, setCode] = useState('')
  const [version, setVersion] = useState<string>()
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const redeeming = useRef(false)
  const codeId = useId()
  const queryClient = useQueryClient()

  async function redeem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const trimmed = code.trim()
    if (redeeming.current || !trimmed || version) return
    redeeming.current = true
    setPending(true)
    setError('')
    try {
      const result = await api<{ kernel_version: string }>(
        '/api/panel/gemini/payload/redeem',
        { method: 'POST', body: JSON.stringify({ redemption_code: trimmed }) }
      )
      setCode('')
      setVersion(result.kernel_version)
      void queryClient.invalidateQueries({
        queryKey: geminiInventoryOptions().queryKey,
      })
    } catch (failure) {
      setError(
        isApiError(failure) && failure.code?.startsWith('gemini_')
          ? failure.message
          : '无法确认兑换结果，请重试。'
      )
    } finally {
      redeeming.current = false
      setPending(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (redeeming.current) return
        if (!next) {
          setCode('')
          setError('')
          setVersion(undefined)
        }
        setOpen(next)
      }}
    >
      <DialogTrigger asChild>
        <Button size='sm' variant='outline'>
          兑换 CRAGGemini
        </Button>
      </DialogTrigger>
      <DialogContent showCloseButton={!pending}>
        <DialogHeader>
          <DialogTitle>兑换 CRAGGemini 内核</DialogTitle>
          <DialogDescription>
            使用当前版本的授权码激活本机签名载荷，不占用 Claude CRAG 订阅槽位。
          </DialogDescription>
        </DialogHeader>
        {version ? (
          <>
            <p role='status' className='text-sm'>
              CRAGGemini {version} 已激活。Google 账号授权与推理支持状态请在
              Gemini 环境中查看。
            </p>
            <DialogFooter>
              <DialogClose asChild>
                <Button type='button'>完成</Button>
              </DialogClose>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={(event) => void redeem(event)} className='grid gap-4'>
            <div className='grid gap-2'>
              <Label htmlFor={codeId}>CRAGGemini 授权码</Label>
              <Input
                id={codeId}
                type='password'
                autoComplete='off'
                spellCheck={false}
                maxLength={128}
                value={code}
                readOnly={pending}
                onChange={(event) => setCode(event.target.value)}
                aria-invalid={Boolean(error)}
                aria-describedby={error ? `${codeId}-error` : undefined}
                required
              />
              {error ? (
                <p
                  id={`${codeId}-error`}
                  role='alert'
                  className='text-sm text-destructive'
                >
                  {error}
                </p>
              ) : null}
            </div>
            <DialogFooter>
              <DialogClose asChild>
                <Button type='button' variant='outline' disabled={pending}>
                  取消
                </Button>
              </DialogClose>
              <Button type='submit' disabled={pending || !code.trim()}>
                {pending ? '正在验签并兑换…' : '兑换内核'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
