import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from 'react'
import { api, isApiError } from '@/lib/api'
import { isGeminiHostIssue } from '@/lib/gemini-recovery'
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
import { GeminiMaintenanceLink } from '@/features/settings/gemini-maintenance-link'

type SubscriptionRedeemResult = {
  active: boolean
  slot_limit: number | 'unlimited'
  used_slots?: number | null
  available_slots?: number | null
  expires_at?: number | null
  quota_grants?: Array<{ expires_at: number; slot_limit?: number | null }>
}

const KNOWN_REDEEM_ERROR_CODES = new Set([
  'slot_limit_reached',
  'host_subscription_inactive',
  'host_binding_conflict',
  'redeem_unavailable',
  'host_redeem_conflict',
  'issuer_mismatch',
  'payload_key_unknown',
  'payload_key_conflict',
  'renewal_unavailable',
  'host_transfer_cooldown',
  'request_conflict',
  'invalid_request',
  'not_found',
  'auth_forbidden',
])

function isDisplayableRedeemError(code?: string) {
  return Boolean(
    code &&
    (code.startsWith('gemini_') ||
      code.startsWith('license_') ||
      KNOWN_REDEEM_ERROR_CODES.has(code))
  )
}

export function GeminiRedeemDialog({
  mode = 'legacy_release',
  triggerVisible = true,
  triggerLabel,
  returnFocusTo,
  onRedeemed,
}: {
  mode?: 'legacy_release' | 'crag_subscription'
  triggerVisible?: boolean
  triggerLabel?: string
  returnFocusTo?: RefObject<HTMLElement | null>
  onRedeemed: () => void
}) {
  const isSubscriptionMode = mode === 'crag_subscription'
  const [open, setOpen] = useState(false)
  const [code, setCode] = useState('')
  const [successMessage, setSuccessMessage] = useState<string>()
  const [error, setError] = useState<{ message: string; code?: string } | null>(
    null
  )
  const [pending, setPending] = useState(false)
  const redeeming = useRef(false)
  const done = useRef<HTMLButtonElement>(null)
  const codeId = useId()

  useEffect(() => {
    if (successMessage) done.current?.focus()
  }, [successMessage])

  async function redeem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const trimmed = code.trim()
    if (redeeming.current || !trimmed || successMessage) return
    redeeming.current = true
    setPending(true)
    setError(null)
    const useSubscriptionEndpoint =
      trimmed.startsWith('CRAGR1.') ||
      (isSubscriptionMode && !trimmed.startsWith('CGG1-'))
    try {
      if (useSubscriptionEndpoint) {
        const result = await api<SubscriptionRedeemResult>(
          '/api/panel/gemini/crag-subscription/redeem',
          { method: 'POST', body: JSON.stringify({ redemption_code: trimmed }) }
        )
        const limitLabel =
          result.slot_limit === 'unlimited' ? '不限' : String(result.slot_limit)
        const availableLabel =
          result.available_slots != null ? String(result.available_slots) : '—'
        const stackedSuffix =
          result.quota_grants && result.quota_grants.length > 1
            ? `，当前已叠加 ${result.quota_grants.length} 张有效兑换码`
            : ''
        setCode('')
        setSuccessMessage(
          `CRAGGemini 宿主订阅已激活（席位额度 ${limitLabel}，可用席位 ${availableLabel}${stackedSuffix}）。请为需要的 Google OAuth 环境绑定席位。`
        )
      } else {
        const result = await api<{ kernel_version: string }>(
          '/api/panel/gemini/payload/redeem',
          { method: 'POST', body: JSON.stringify({ redemption_code: trimmed }) }
        )
        setCode('')
        setSuccessMessage(
          `CRAGGemini ${result.kernel_version} 已激活。Google 账号仍需单独授权。`
        )
      }
      onRedeemed()
    } catch (failure) {
      setError({
        message:
          isApiError(failure) && isDisplayableRedeemError(failure.code)
            ? failure.message
            : '无法确认兑换结果，请重试。',
        code: isApiError(failure) ? failure.code : undefined,
      })
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
          setError(null)
          setSuccessMessage(undefined)
        }
        setOpen(next)
      }}
    >
      {triggerVisible ? (
        <DialogTrigger asChild>
          <Button type='button' size='sm' variant='outline'>
            {triggerLabel ??
              (isSubscriptionMode ? '兑换 CRAGGemini 订阅' : '兑换 CRAGGemini')}
          </Button>
        </DialogTrigger>
      ) : null}
      <DialogContent
        showCloseButton={!pending}
        onCloseAutoFocus={(event) => {
          if (!triggerVisible && returnFocusTo?.current) {
            event.preventDefault()
            returnFocusTo.current.focus()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {isSubscriptionMode ? '兑换 CRAGGemini 订阅' : '兑换 CRAGGemini'}
          </DialogTitle>
          <DialogDescription>
            {isSubscriptionMode
              ? '输入 CRAGGemini 宿主机兑换码（CRAGR1.…，支持 1个月/10槽可叠加码与 7天/10槽测试码）以开通或叠加席位，不占用 Claude CRAG 槽位。'
              : '支持 CRAGGemini 兑换码（CRAGR1.…，含 1个月/10槽可叠加码与 7天/10槽测试码）或旧版内核授权码（CGG1-…），不占用 Claude CRAG 槽位。'}
          </DialogDescription>
        </DialogHeader>
        {successMessage ? (
          <>
            <p role='status' className='text-sm'>
              {successMessage}
            </p>
            <DialogFooter>
              <DialogClose asChild>
                <Button ref={done} type='button'>
                  完成
                </Button>
              </DialogClose>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={(event) => void redeem(event)} className='grid gap-4'>
            <div className='grid gap-2'>
              <Label htmlFor={codeId}>
                {isSubscriptionMode ? 'CRAGGemini 订阅码' : 'CRAGGemini 兑换码'}
              </Label>
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
                <div className='space-y-1'>
                  <p
                    id={`${codeId}-error`}
                    role='alert'
                    className='text-sm text-destructive'
                  >
                    {error.message}
                  </p>
                  {isGeminiHostIssue(error.code) ? (
                    <GeminiMaintenanceLink />
                  ) : null}
                </div>
              ) : null}
            </div>
            <DialogFooter>
              <DialogClose asChild>
                <Button type='button' variant='outline' disabled={pending}>
                  取消
                </Button>
              </DialogClose>
              <Button type='submit' disabled={pending || !code.trim()}>
                {pending
                  ? '正在验签并兑换…'
                  : isSubscriptionMode
                    ? '兑换订阅'
                    : '确认兑换'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
