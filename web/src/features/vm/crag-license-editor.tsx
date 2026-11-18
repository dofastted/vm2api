import { useId } from 'react'
import { Link } from '@tanstack/react-router'
import { VIEW_TITLES } from '@/config/nav'
import type { CragLicenseResponse, CragLicenseStatus } from '@/types/panel-vm'
import { toast } from 'sonner'
import { isApiError } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { CragHostSubscription } from './crag-host-subscription'
import { cragSubscriptionErrors } from './crag-subscription-errors'

/**
 * 错误码 → 文案，一码一句。宿主订阅（按槽位计）的错误码来自
 * `cragSubscriptionErrors`，这里只写本槽授权与设备授权独有的码。
 *
 * 三类兑换冲突必须可区分：
 * - `host_redeem_conflict`：订阅兑换码已在别的宿主机兑换
 * - `license_redeem_conflict`：设备兑换码已绑定另一台设备
 * - `payload_key_conflict`：内核版本（CRAG 包）冲突
 */
const licenseMessages: Record<string, string> = {
  ...cragSubscriptionErrors,
  license_required:
    '尚未授权。可绑定宿主订阅（占用槽位），或使用设备兑换码、离线通用码授权本槽。',
  license_expired: '授权已到期。请向授权方申请续期，并在下方替换注册码。',
  license_not_yet_valid:
    '授权尚未生效。请核对服务器 UTC 时间和生效时间；如签发时间有误，请联系授权方重新签发。',
  license_invalid:
    '注册码无法通过校验，可能不完整、已被修改或签发密钥不匹配。请重新复制完整注册码，或联系授权方重新签发。',
  license_binding_mismatch:
    '注册码不属于本槽或当前机器。请使用下方机器码申请匹配的注册码。',
  license_crag_host_over_quota:
    '使用中的槽位超过充值可用槽位，本槽已暂停调度。请继续充值，或停止其他正在运行的 CRAG 槽。',
  license_unconfigured:
    '服务器尚未配置可信授权公钥或加密 CRAG 包。请联系管理员安装受信任的完整软件包后重试。',
  license_redeem_unavailable:
    '设备兑换码无效、已过期或已使用。若兑换时连接中断，请联系签发方核对兑换记录。',
  license_redeem_conflict:
    '此设备兑换码已绑定另一台设备，不能用于本槽。请回到原槽使用。',
  license_redeem_target_changed:
    '激活期间目标槽、设备或授权发生变化，未覆盖现有授权。请联系管理员核对本次签发。',
  license_redeem_subscription:
    '本槽已在使用宿主订阅，不需要设备兑换码。请在下方「宿主订阅」管理绑定。',
  license_redeem_service:
    '未确认联网激活。请在同一槽使用原码重试；若提示已使用，请联系签发方核对兑换记录。',
  license_redeem_origin: '请在当前面板页提交兑换，不要从其他站点发起。',
  issuer_mismatch: '授权服务不认可目标内核的发行方，本次未兑换。',
  crag_v2_unsupported_placement:
    '此槽不支持该授权方式。设备兑换码需要本机 Linux Docker 槽。',
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

export function CragShopLink() {
  return (
    <Button variant='outline' size='sm' asChild>
      <Link to='/crag-subscription'>{VIEW_TITLES['crag-subscription']}</Link>
    </Button>
  )
}

function utcTimestamp(seconds?: number) {
  if (seconds == null || !Number.isFinite(seconds)) return '—'
  const date = new Date(seconds * 1000)
  if (!Number.isFinite(date.getTime())) return '—'
  return date.toISOString().replace('T', ' ').replace('.000Z', ' UTC')
}

export function CragLicenseSummary({
  license,
}: {
  license: CragLicenseStatus
}) {
  const term = { '1m': '1 个月', '3m': '3 个月', '6m': '6 个月', '1y': '1 年' }
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
            {license.scope === 'host'
              ? `宿主订阅 · 绑定编号 ${license.seat ?? '—'}`
              : license.kind === 'offline'
                ? '设备授权 · 离线通用码'
                : '设备授权 · 在线兑换'}
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
  vmId,
  data,
  loading,
  loadError,
  onRefresh,
  onClose,
}: {
  vmId: string
  data?: CragLicenseResponse
  loading: boolean
  loadError: unknown
  onRefresh: () => void
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
  const busy = loading

  return (
    <section
      className='min-w-0 space-y-4 border-t pt-4'
      aria-label='CRAG 授权管理'
      aria-busy={busy}
    >
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <h4 className='text-sm font-medium'>本槽 CRAG 授权</h4>
        <div className='flex gap-2'>
          <CragShopLink />
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
      <CragHostSubscription vmId={vmId} />
      {data?.machine_code ? (
        <section
          className='min-w-0 space-y-2 border-t pt-4'
          aria-labelledby={`${formId}-device-heading`}
        >
          <h4 id={`${formId}-device-heading`} className='text-sm font-medium'>
            设备授权（按机器码）
          </h4>
          <p className='text-sm text-muted-foreground'>
            设备注册码只绑定本槽机器码与匹配的内核版本，不占用宿主订阅的槽位。
          </p>
          <details className='space-y-2'>
            <summary className='cursor-pointer text-sm'>
              签发设备注册码所需的机器码
            </summary>
            <div className='flex flex-wrap items-center justify-between gap-2'>
              <Label htmlFor={`${formId}-machine`}>本槽机器码</Label>
              <Button
                type='button'
                variant='outline'
                disabled={busy}
                onClick={async () => {
                  try {
                    const challenge = data.payload_key_id
                      ? JSON.stringify({
                          machine_code: data.machine_code,
                          payload_key_id: data.payload_key_id,
                        })
                      : data.machine_code
                    await navigator.clipboard.writeText(challenge)
                    toast.success(
                      data.payload_key_id
                        ? '机器码和目标载荷已复制'
                        : '机器码已复制'
                    )
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
              value={
                data.payload_key_id
                  ? JSON.stringify(
                      {
                        machine_code: data.machine_code,
                        payload_key_id: data.payload_key_id,
                      },
                      null,
                      2
                    )
                  : data.machine_code
              }
              spellCheck={false}
              onFocus={(event) => event.currentTarget.select()}
              className='max-h-36 resize-y font-mono text-sm break-all'
              aria-describedby={`${formId}-machine-help`}
            />
            <p
              id={`${formId}-machine-help`}
              className='text-xs leading-relaxed text-muted-foreground'
            >
              将完整机器码交给授权方；若显示载荷
              ID，请一并复制。注册码只对本槽和匹配的内核版本有效。
            </p>
          </details>
        </section>
      ) : null}
    </section>
  )
}
