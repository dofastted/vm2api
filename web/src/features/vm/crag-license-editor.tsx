import { useId, useState } from 'react'
import type { CragLicenseResponse, CragLicenseStatus } from '@/types/panel-vm'
import { toast } from 'sonner'
import { isApiError } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'

const licenseMessages: Record<string, string> = {
  license_required:
    '本槽尚未授权。可直接粘贴离线通用码，或复制机器码申请在线设备授权。',
  license_expired: '授权已到期。请向授权方申请续期，并在下方替换注册码。',
  license_not_yet_valid:
    '授权尚未生效。请核对服务器 UTC 时间和生效时间；如签发时间有误，请联系授权方重新签发。',
  license_invalid:
    '注册码无法通过校验，可能不完整、已被修改或签发密钥不匹配。请重新复制完整注册码，或联系授权方重新签发。',
  license_binding_mismatch:
    '注册码不属于本槽或当前机器。请使用下方机器码申请匹配的注册码。',
  license_unconfigured:
    '服务器尚未配置可信授权公钥或加密 CRAG 包。请联系管理员安装受信任的完整软件包后重试。',
}

const statusLabels: Record<CragLicenseStatus['status'], string> = {
  unlicensed: '未授权',
  valid: '授权有效',
  expired: '已到期',
  not_yet_valid: '尚未生效',
  invalid: '授权无效',
  unconfigured: '授权服务未配置',
}

const statusCodes: Record<CragLicenseStatus['status'], string> = {
  unlicensed: 'license_required',
  valid: '',
  expired: 'license_expired',
  not_yet_valid: 'license_not_yet_valid',
  invalid: 'license_invalid',
  unconfigured: 'license_unconfigured',
}

export function cragLicenseErrorMessage(error: unknown) {
  if (isApiError(error)) {
    if (licenseMessages[error.code]) return licenseMessages[error.code]
    if (error.status === 401) return '登录已过期，请重新登录后重试。'
    if (error.status === 403) return '没有管理本槽授权的权限，请联系管理员。'
  }
  return '无法完成授权请求。请检查连接和服务器配置后重试；仍然失败时请联系管理员。'
}

function utcTimestamp(seconds?: number) {
  if (seconds == null || !Number.isFinite(seconds)) return '—'
  const date = new Date(seconds * 1000)
  if (!Number.isFinite(date.getTime())) return '—'
  return date.toISOString().replace('T', ' ').replace('.000Z', ' UTC')
}

function codeMode(code: string) {
  const value = code.trim()
  if (value.startsWith('CRAGU1.')) return 'offline' as const
  if (value.startsWith('CRAGL1.')) return 'online' as const
  return null
}

export function CragLicenseSummary({
  license,
}: {
  license: CragLicenseStatus
}) {
  const term = { '1m': '1 个月', '6m': '6 个月', '1y': '1 年' }
  return (
    <dl className='grid min-w-0 gap-3 text-sm sm:grid-cols-2'>
      <div>
        <dt className='text-xs text-muted-foreground'>CRAG 授权</dt>
        <dd className='mt-1 font-medium'>
          {statusLabels[license.status] || '状态未知，请刷新授权状态'}
        </dd>
      </div>
      {license.kind ? (
        <div>
          <dt className='text-xs text-muted-foreground'>授权方式</dt>
          <dd className='mt-1'>
            {license.kind === 'offline' ? '离线通用码' : '在线设备授权'}
          </dd>
        </div>
      ) : null}
      <div>
        <dt className='text-xs text-muted-foreground'>签发期限</dt>
        <dd className='mt-1'>
          {license.term ? term[license.term] || '—' : '—'}
        </dd>
      </div>
      <div>
        <dt className='text-xs text-muted-foreground'>生效时间</dt>
        <dd className='mt-1 break-words tabular-nums'>
          {utcTimestamp(license.not_before)}
        </dd>
      </div>
      <div>
        <dt className='text-xs text-muted-foreground'>到期时间</dt>
        <dd className='mt-1 break-words tabular-nums'>
          {utcTimestamp(license.expires_at)}
        </dd>
      </div>
    </dl>
  )
}

export function CragLicenseEditor({
  data,
  loading,
  loadError,
  activationError,
  registrationCode,
  activating,
  onChange,
  onRefresh,
  onActivate,
  onClose,
}: {
  data?: CragLicenseResponse
  loading: boolean
  loadError: unknown
  activationError: unknown
  registrationCode: string
  activating: boolean
  onChange: (code: string) => void
  onRefresh: () => void
  onActivate: () => void
  onClose: () => void
}) {
  const formId = useId()
  const license = data?.license
  const statusMessage =
    license && !license.valid
      ? licenseMessages[license.code || ''] ||
        licenseMessages[statusCodes[license.status]] ||
        '授权状态未知。请刷新状态，并联系管理员检查授权配置。'
      : null
  const busy = loading || activating
  const detected = codeMode(registrationCode)
  const [chosen, setChosen] = useState<'offline' | 'online' | null>(null)
  const mode =
    detected ?? chosen ?? (license?.kind === 'online' ? 'online' : 'offline')

  return (
    <section
      className='min-w-0 space-y-4 border-t pt-4'
      aria-label='CRAG 授权管理'
      aria-busy={busy}
    >
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <h4 className='text-sm font-medium'>本槽 CRAG 授权</h4>
        <div className='flex gap-2'>
          <Button
            type='button'
            variant='ghost'
            disabled={busy}
            onClick={onRefresh}
          >
            {loading ? '读取中…' : '刷新状态'}
          </Button>
          <Button
            type='button'
            variant='ghost'
            disabled={busy}
            onClick={onClose}
          >
            收起
          </Button>
        </div>
      </div>
      {loading && !data ? (
        <div role='status' className='space-y-2'>
          <span className='text-sm text-muted-foreground'>
            正在读取本槽授权与机器码…
          </span>
          <Skeleton className='h-16 w-full' />
        </div>
      ) : null}
      {loadError ? (
        <p role='alert' className='text-sm text-destructive'>
          {cragLicenseErrorMessage(loadError)}
          {data ? ' 下方为上次读取的状态，请刷新后再操作。' : ''}
        </p>
      ) : null}
      {license ? <CragLicenseSummary license={license} /> : null}
      {statusMessage ? (
        <p
          role='status'
          className='text-sm leading-relaxed text-muted-foreground'
        >
          {statusMessage}
        </p>
      ) : null}
      <div className='flex flex-wrap gap-2' role='group' aria-label='授权方式'>
        <Button
          type='button'
          variant={mode === 'offline' ? 'default' : 'outline'}
          disabled={busy}
          aria-pressed={mode === 'offline'}
          onClick={() => setChosen('offline')}
        >
          离线码
        </Button>
        <Button
          type='button'
          variant={mode === 'online' ? 'default' : 'outline'}
          disabled={busy}
          aria-pressed={mode === 'online'}
          onClick={() => {
            setChosen('online')
            if (!data?.machine_code) onRefresh()
          }}
        >
          在线授权
        </Button>
      </div>
      {mode === 'online' && data?.machine_code ? (
        <div className='space-y-2'>
          <div className='flex flex-wrap items-center justify-between gap-2'>
            <Label htmlFor={`${formId}-machine`}>本槽机器码</Label>
            <Button
              type='button'
              variant='outline'
              disabled={busy}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(data.machine_code)
                  toast.success('机器码已复制')
                } catch {
                  toast.error('复制失败，请选中机器码后手动复制')
                }
              }}
            >
              复制机器码
            </Button>
          </div>
          <Textarea
            id={`${formId}-machine`}
            readOnly
            rows={3}
            value={data.machine_code}
            spellCheck={false}
            onFocus={(event) => event.currentTarget.select()}
            className='max-h-36 resize-y font-mono text-sm break-all'
            aria-describedby={`${formId}-machine-help`}
          />
          <p
            id={`${formId}-machine-help`}
            className='text-xs leading-relaxed text-muted-foreground'
          >
            将机器码交给授权方换取在线设备码。该码只属于本槽；期限由签名确定，不能在此修改。
          </p>
        </div>
      ) : null}
      <form
        className='space-y-3'
        onSubmit={(event) => {
          event.preventDefault()
          if (!busy && registrationCode.trim() && data && !loadError)
            onActivate()
        }}
      >
        <div className='space-y-2'>
          <Label htmlFor={`${formId}-registration`}>
            {mode === 'offline' ? '离线通用码' : '在线设备授权码'}
          </Label>
          <Textarea
            id={`${formId}-registration`}
            rows={4}
            value={registrationCode}
            onChange={(event) => onChange(event.target.value)}
            disabled={busy || !data || !!loadError}
            autoComplete='off'
            autoCapitalize='none'
            spellCheck={false}
            className='max-h-48 resize-y font-mono text-sm break-all'
            aria-invalid={!!activationError}
            aria-describedby={`${formId}-registration-help${activationError ? ` ${formId}-error` : ''}`}
          />
          <p
            id={`${formId}-registration-help`}
            className='text-xs leading-relaxed text-muted-foreground'
          >
            {mode === 'offline'
              ? '粘贴 CRAGU1 离线通用码。不需要机器码，也不绑定本槽。校验通过后才替换当前授权。'
              : '粘贴与上方机器码对应的 CRAGL1。不属于本槽的码会被拒绝，已有授权不会被破坏。'}
          </p>
        </div>
        {activationError ? (
          <p
            id={`${formId}-error`}
            role='alert'
            className='text-sm text-destructive'
          >
            {cragLicenseErrorMessage(activationError)}
          </p>
        ) : null}
        <Button
          type='submit'
          disabled={busy || !registrationCode.trim() || !data || !!loadError}
        >
          {activating
            ? '正在校验并激活…'
            : license?.valid
              ? '校验并替换授权'
              : '校验并激活'}
        </Button>
      </form>
    </section>
  )
}
