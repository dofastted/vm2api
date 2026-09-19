import { useEffect, useState } from 'react'
import type { Vm, VmProxySnap } from '@/types/panel-vm'
import {
  TIMEZONE_SOURCE_LABELS,
  validTimezone,
  zoneNowLabel,
} from '@/lib/timezone'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Field } from '@/features/vm/detail-section-primitives'
import { TimezonePicker } from '@/features/vm/timezone-picker'

type VmEnvironmentCardProps = {
  vm: Vm
  proxy: VmProxySnap
  saving: boolean
  onSave: (timezone: string) => void
  onFollowProxy: () => void
}

/**
 * 槽位环境设置。目前只有时区：它同时决定容器 `TZ`、persona 的
 * `# Environment - Timezone` 和工作站指纹，所以改它等于改槽位对上游的自述。
 *
 * 改动即时写档并在下次 worker 重载后生效；容器内的 `TZ` 环境变量要等重建
 * 容器才会换，卡片里直接写明，免得运维以为没生效。
 */
export function VmEnvironmentCard({
  vm,
  proxy,
  saving,
  onSave,
  onFollowProxy,
}: VmEnvironmentCardProps) {
  const current = String(vm.timezone || '')
  const [draft, setDraft] = useState(current)
  // 槽位切换或后端回写新时区后，草稿跟随服务端值重置。
  useEffect(() => setDraft(current), [current])

  const proxyZone = validTimezone(proxy?.geo?.timezone)
  const geoText = [proxy?.geo?.country, proxy?.geo?.city]
    .filter(Boolean)
    .join(' · ')
  const dirty = draft.trim() !== current
  const valid = !!validTimezone(draft)

  return (
    <Card>
      <CardHeader className='pb-2'>
        <CardTitle className='text-sm'>环境</CardTitle>
      </CardHeader>
      <p className='px-6 pb-2 text-xs text-muted-foreground'>
        时区写进容器 TZ、persona 的 Environment 段和工作站指纹。换容器后 TZ
        才会在槽内生效，persona 下一次请求就跟上。
      </p>
      <CardContent className='divide-y pt-0'>
        <Field label='当前时区'>
          <span className='flex items-center gap-2 text-xs'>
            <span className='field-host'>{current || '—'}</span>
            <span className='text-muted-foreground'>
              {TIMEZONE_SOURCE_LABELS[String(vm.timezone_source || 'auto')] ||
                '自动'}
            </span>
            <span className='field-metric text-muted-foreground'>
              {zoneNowLabel(current)}
            </span>
          </span>
        </Field>
        <Field label='代理出口'>
          <span className='text-xs text-muted-foreground'>
            {proxyZone
              ? `${proxyZone}${geoText ? ` · ${geoText}` : ''}`
              : '未检测（到代理池点「地理」）'}
          </span>
        </Field>
        <Field label='设置时区'>
          <div className='w-full max-w-[320px] space-y-2'>
            <TimezonePicker
              value={draft}
              onChange={setDraft}
              disabled={saving}
            />
            <div className='flex flex-wrap gap-2'>
              <Button
                size='sm'
                disabled={saving || !dirty || !valid}
                loading={saving}
                onClick={() => onSave(draft.trim())}
              >
                保存
              </Button>
              <Button
                size='sm'
                variant='outline'
                disabled={saving || !proxyZone || proxyZone === current}
                title={
                  proxyZone
                    ? `改为 ${proxyZone}`
                    : '代理还没有地理位置，先在代理池检测'
                }
                onClick={onFollowProxy}
              >
                跟随代理时区
              </Button>
            </div>
            {dirty && !valid ? (
              <p className='text-xs text-[color:var(--status-bad)]'>
                不是有效的 IANA 时区
              </p>
            ) : null}
          </div>
        </Field>
      </CardContent>
    </Card>
  )
}
