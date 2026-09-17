import type { ComponentProps } from 'react'
import type { Dashboard } from '@/types/panel-overview'
import type { Vm } from '@/types/panel-vm'
import {
  type CredType,
  authSchemeLabel,
  authSchemeOf,
  credTypeLabel,
} from '@/lib/cred-type'
import { extraUsageText } from '@/lib/fable-status'
import { fmtExpiresAt, fmtNum, pct } from '@/lib/format'
import { isCodexVm } from '@/lib/vm-kind'
import { claudeTier, credExpiry } from '@/lib/vm-status'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { TabsContent } from '@/components/ui/tabs'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { StatusMark } from '@/components/status-mark'
import { AllowedModelsCard } from '@/features/vm/allowed-models-card'
import { AuthSchemeEditor } from '@/features/vm/auth-scheme-editor'
import { CodexCredentialPanel } from '@/features/vm/codex-credential-panel'
import { ConvertOauthToSetupButton } from '@/features/vm/convert-oauth-button'
import { CredentialEditorButton } from '@/features/vm/credential-editor'
import { CredentialPanel } from '@/features/vm/credential-panel'
import { Field, Meter } from '@/features/vm/detail-section-primitives'
import { OfficialCcCard } from '@/features/vm/official-cc-card'
import { OpenaiPlanBadge } from '@/features/vm/openai-plan-badge'

type VmAccountTabProps = {
  id: string
  vm: Vm
  acc: Record<string, unknown>
  dash: { data: Dashboard | undefined }
  credType: CredType
  officialCc: boolean
  u5: number
  u7: number
  tierKey: string
  todayReadCache: number
  todayWriteCache: number
  todayHit: number | null
  canRefresh: boolean
  refreshBlocked: string
  busyPath?: string | null
  onNeedProxy: () => void
  onAction: (path: string, body?: unknown) => void
  onCredentialCommitted: NonNullable<
    ComponentProps<typeof CredentialPanel>['onCommitted']
  >
}

export function VmAccountTab(props: VmAccountTabProps) {
  const {
    id,
    vm,
    acc,
    credType,
    officialCc,
    todayReadCache,
    todayWriteCache,
    todayHit,
    canRefresh,
    refreshBlocked,
    busyPath,
    onNeedProxy,
    onAction,
    onCredentialCommitted,
  } = props
  const blocked = vm.can_import_credential === false
  const gpt = isCodexVm(vm)
  const probe =
    ((acc.last_probe as Record<string, unknown> | undefined) ||
      vm.last_probe) ??
    {}

  return (
    <TabsContent value='account' className='space-y-3 pt-3'>
      <div className='grid gap-3 xl:grid-cols-[minmax(0,1.15fr)_minmax(20rem,0.85fr)]'>
        <Card>
          <CardHeader className='pb-2'>
            <CardTitle className='text-sm'>导入凭证</CardTitle>
          </CardHeader>
          <CardContent className='pt-0'>
            {blocked ? (
              <div className='space-y-3'>
                <p className='text-sm text-muted-foreground'>
                  该槽需要已绑定且健康的 SOCKS5 才能换票。
                </p>
                <Button size='sm' onClick={onNeedProxy}>
                  去绑定代理
                </Button>
              </div>
            ) : gpt ? (
              <CodexCredentialPanel
                vm={vm}
                onCommitted={onCredentialCommitted}
              />
            ) : (
              <CredentialPanel
                vm={vm}
                onCommitted={onCredentialCommitted}
                showConvert={false}
              />
            )}
          </CardContent>
        </Card>

        <div className='space-y-3'>
          <Card>
            <CardHeader className='pb-2'>
              <CardTitle className='text-sm'>账号</CardTitle>
            </CardHeader>
            <CardContent className='divide-y pt-0'>
              <Field label='类型' compact>
                {credType === 'none' ? '—' : credTypeLabel(credType)}
              </Field>
              <Field label='状态' compact>
                <StatusMark tone={credExpiry(vm)} variant='pill' />
              </Field>
              {claudeTier(vm).key !== 'none' ? (
                <Field label='套餐' compact>
                  {gpt ? (
                    <OpenaiPlanBadge vm={vm} />
                  ) : (
                    <StatusMark tone={claudeTier(vm)} variant='pill' />
                  )}
                </Field>
              ) : null}
              {credType === 'apikey' ? (
                <Field label='Key' compact>
                  {vm.has_token ? '已写入' : '—'}
                </Field>
              ) : (
                <>
                  <Field label='Access' compact>
                    {vm.has_token ? '已绑定' : '—'}
                  </Field>
                  <Field label='Refresh' compact>
                    {vm.has_refresh ? '已绑定' : '—'}
                  </Field>
                  <Field label='过期' compact>
                    {fmtExpiresAt(vm.expires_at)}
                  </Field>
                </>
              )}
              {gpt ? null : (
                <Field label='上游认证' compact>
                  <div className='flex items-center gap-1'>
                    <span>{authSchemeLabel(authSchemeOf(vm))}</span>
                    {vm.auth_scheme ? null : (
                      <span className='text-xs text-muted-foreground'>
                        默认
                      </span>
                    )}
                    <AuthSchemeEditor vm={vm} />
                  </div>
                </Field>
              )}
              <Field label={gpt ? 'ChatGPT 账号' : 'UUID'} compact>
                {gpt ? (
                  <span className='text-sm'>
                    {String(
                      vm.email || vm.account_uuid || acc.account_id || '—'
                    )}
                  </span>
                ) : (
                  <span className='font-mono text-xs'>
                    {String(vm.account_uuid || acc.account_id || '—')}
                  </span>
                )}
              </Field>
              <Field label='Org' compact>
                <span className='font-mono text-xs'>
                  {String(vm.org_uuid || '—')}
                </span>
              </Field>
              {gpt ? null : (
                <Field label='来源' compact>
                  {String(vm.oauth_source || '—')}
                </Field>
              )}
              <div className='flex flex-wrap items-center gap-2 pt-2'>
                {gpt ? null : (
                  <ConvertOauthToSetupButton
                    vm={vm}
                    onCommitted={onCredentialCommitted}
                  />
                )}
                {gpt ? null : <CredentialEditorButton vmId={id} />}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span>
                      <Button
                        size='sm'
                        variant='outline'
                        disabled={!canRefresh}
                        loading={busyPath === '/oauth/refresh'}
                        onClick={() => onAction('/oauth/refresh', {})}
                      >
                        刷新凭证
                      </Button>
                    </span>
                  </TooltipTrigger>
                  {refreshBlocked ? (
                    <TooltipContent>{refreshBlocked}</TooltipContent>
                  ) : null}
                </Tooltip>
              </div>
            </CardContent>
          </Card>

          <div className='grid grid-cols-2 gap-3'>
            <Card>
              <CardHeader className='pb-2'>
                <CardTitle className='text-sm'>探测</CardTitle>
              </CardHeader>
              <CardContent className='divide-y pt-0'>
                <Field label='时间' compact>
                  <span className='font-mono text-xs'>
                    {String(probe.at || '未探测')}
                  </span>
                </Field>
                <Field label='来源' compact>
                  {String(acc.probe_source ?? vm.probe_source ?? '—')}
                </Field>
                {gpt ? null : (
                  <Field label='超额' compact>
                    {extraUsageText(acc.extra_usage ?? vm.extra_usage)}
                  </Field>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader className='pb-2'>
                <CardTitle className='text-sm'>今日</CardTitle>
              </CardHeader>
              <CardContent className='space-y-2 pt-0'>
                <div className='grid grid-cols-3 gap-2 text-center'>
                  <div>
                    <div className='text-[11px] text-muted-foreground'>
                      请求
                    </div>
                    <div className='text-sm font-semibold tabular-nums'>
                      {fmtNum(acc.requests ?? vm.requests)}
                    </div>
                  </div>
                  <div>
                    <div className='text-[11px] text-muted-foreground'>入</div>
                    <div className='text-sm font-semibold tabular-nums'>
                      {fmtNum(acc.tokens_in ?? vm.tokens_in)}
                    </div>
                  </div>
                  <div>
                    <div className='text-[11px] text-muted-foreground'>出</div>
                    <div className='text-sm font-semibold tabular-nums'>
                      {fmtNum(acc.tokens_out ?? vm.tokens_out)}
                    </div>
                  </div>
                </div>
                <Meter
                  label='缓存命中'
                  value={todayHit ?? 0}
                  kind='remain'
                  hint={`${fmtNum(todayReadCache)} 读 / ${fmtNum(todayWriteCache)} 写`}
                />
                {gpt ? null : (
                  <Meter
                    label='7 天 Sonnet'
                    value={pct(
                      acc.utilization_7d_sonnet ?? vm.utilization_7d_sonnet
                    )}
                  />
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>

      {gpt ? null : officialCc ? (
        <OfficialCcCard vmId={id} />
      ) : credType !== 'none' ? (
        <p className='text-xs text-muted-foreground'>
          官方 Claude Code 初装仅支持完整 OAuth 凭证，当前槽为{' '}
          {credTypeLabel(credType)}。
        </p>
      ) : null}

      <AllowedModelsCard vm={vm} />
    </TabsContent>
  )
}
