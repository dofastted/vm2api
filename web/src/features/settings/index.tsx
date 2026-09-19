import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useParams } from '@tanstack/react-router'
import { VIEW_TITLES } from '@/config/nav'
import type { Dashboard } from '@/types/panel-overview'
import type { NotifyConfig } from '@/types/panel-routing'
import type { QuotaTierPolicy } from '@/types/panel-vm'
import { toast } from 'sonner'
import { api, patchVm } from '@/lib/api'
import {
  cacheBreakpointsFromCompat,
  cacheTtlFromCompat,
  detectProxiedOfficialCcFromCompat,
} from '@/lib/cache-breakpoints'
import { cleanPersonaRules, personaRulesFromCompat } from '@/lib/persona-rules'
import {
  personaInjectFromPreset,
  personaPresetFromCompat,
  personaPresetLabel,
} from '@/lib/persona-template'
import { cn } from '@/lib/utils'
import { isCodexVm } from '@/lib/vm-kind'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { PageHeader } from '@/components/page-header'
import { QueryGate } from '@/components/query-gate'
import { SettingRow } from '@/components/setting-row'
import { dashboardQueryOptions } from '@/features/overview/queries'
import { BackupPane } from '@/features/settings/backup-pane'
import { CacheBreakpointsPane } from '@/features/settings/cache-breakpoints-pane'
import { CredentialWeightPane } from '@/features/settings/credential-weight-pane'
import { HealthPane } from '@/features/settings/health-pane'
import { KernelRoutingPane } from '@/features/settings/kernel-routing-pane'
import { LogsPane } from '@/features/settings/logs-pane'
import {
  SETTINGS_TAB_LABELS,
  settingsTabId,
  type SettingsTabId,
} from '@/features/settings/navigation'
import { NotifyPane } from '@/features/settings/notify-pane'
import { OfficialCcSettingsPane } from '@/features/settings/official-cc-pane'
import { PersonaPane } from '@/features/settings/persona-pane'
import { PersonaRulesPane } from '@/features/settings/persona-rules-pane'
import { PoolPane } from '@/features/settings/pool-pane'
import { inheritProtocolOnSlots } from '@/features/settings/protocol-authority'
import {
  notifyQueryOptions,
  routingQueryOptions,
} from '@/features/settings/queries'
import { QuotaTierPane } from '@/features/settings/quota-tier-pane'
import { SaveBar } from '@/features/settings/save-bar'
import { SettingsNav } from '@/features/settings/settings-nav'
import { SettingsSkeleton } from '@/features/settings/settings-skeleton'
import { Socks5Pane } from '@/features/settings/socks5-pane'
import { StickyPane } from '@/features/settings/sticky-pane'
import { TelemetryPane } from '@/features/settings/telemetry-pane'

export function SettingsPage() {
  const { tab: raw } = useParams({ from: '/_authenticated/settings/$tab' })
  const tab = settingsTabId(raw)
  const routing = useQuery(routingQueryOptions())
  const qc = useQueryClient()
  const [draft, setDraft] = useState<Record<string, unknown>>({})
  // persona 面板把校验结果上报到这里，保存前拦住畸形模板，避免吞一个后端 400
  const [personaProblems, setPersonaProblems] = useState<string[]>([])
  // 放弃草稿时 +1：persona 等面板持有内部草稿，靠重挂载从重置后的 draft 重新播种
  const [discardKey, setDiscardKey] = useState(0)
  useEffect(() => {
    if (routing.data) setDraft(routing.data)
  }, [routing.data])

  const save = useMutation({
    mutationFn: () => {
      const body = { ...draft }
      const compat = (body.compatibility as Record<string, unknown>) || {}
      if (tab === 'protocol' || tab === 'whitelist') {
        const preset = personaPresetFromCompat(compat)
        const rules = cleanPersonaRules(personaRulesFromCompat(compat))
        const breakpoints = cacheBreakpointsFromCompat(compat)
        body.compatibility = {
          ...compat,
          persona_preset: preset,
          overlay_preset: 'off',
          persona_standing: String(compat.persona_standing ?? ''),
          persona_leak_append: '',
          persona_inject: personaInjectFromPreset(
            preset,
            compat.persona_inject
          ),
          persona_park: false,
          cache_ttl: cacheTtlFromCompat(compat),
          cache_breakpoints: {
            ...breakpoints,
            system_tail: false,
            tools_tail: false,
            messages: 'cli-hop',
          },
          detect_proxied_official_cc: detectProxiedOfficialCcFromCompat(compat),
          persona_rules: rules,
        }
      }
      if (tab === 'protocol') {
        const inference = (body.inference as Record<string, unknown>) || {}
        body.inference = {
          ...inference,
          engine: 'rust',
          fallback_to_go: false,
        }
      }
      return api('/api/panel/routing', {
        method: 'PUT',
        body: JSON.stringify(body),
      })
    },
    onSuccess: async () => {
      const compat = draft.compatibility as Record<string, unknown> | undefined
      let inherited = 0
      if (tab === 'protocol') {
        try {
          const dash = await api<Dashboard>('/api/panel/dashboard')
          const follow = await inheritProtocolOnSlots(
            (dash.vms || []).filter((vm) => !isCodexVm(vm)),
            patchVm
          )
          inherited = follow.changed
          if (follow.errors.length) {
            toast.error(
              `协议已保存，${follow.errors.length} 个槽位未跟随：${follow.errors
                .slice(0, 3)
                .map(
                  (item) => `${item.id} ${protocolFollowError(item.message)}`
                )
                .join('；')}`
            )
          }
        } catch (error) {
          toast.error(
            `协议已保存，槽位未跟随全局：${protocolFollowError(
              error instanceof Error ? error.message : String(error)
            )}`
          )
        }
      }
      toast.success(settingsSaveToast(tab, compat, inherited))
      await Promise.all([
        qc.invalidateQueries({ queryKey: routingQueryOptions().queryKey }),
        qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
        ...(tab === 'notify'
          ? [qc.invalidateQueries({ queryKey: notifyQueryOptions().queryKey })]
          : []),
      ])
    },
    onError: (error: Error) => toast.error(protocolFollowError(error.message)),
  })
  const sticky = (draft.sticky as Record<string, unknown> | undefined) || {}
  const pool = (draft.pool as Record<string, unknown> | undefined) || {}
  const failover = (draft.failover as Record<string, unknown> | undefined) || {}
  const quota = (draft.quota as Record<string, unknown> | undefined) || {}
  const logging = (draft.logging as Record<string, unknown> | undefined) || {}
  const inference =
    (draft.inference as Record<string, unknown> | undefined) || {}
  const hideSave = tab === 'socks5' || tab === 'telemetry' || tab === 'backup'
  // 两个 tab 都写 compatibility，而 persona_templates 是在协议页编辑的：
  // 只拦协议页的话，用户可以带着畸形模板切到白名单页保存，照样吃后端 400。
  const blocked =
    (tab === 'protocol' || tab === 'whitelist') && personaProblems.length > 0

  // dirty = 草稿偏离服务端快照。两边对象来自同一份 JSON，展开更新不改键序，
  // 串比较足够；首帧 draft 还是 {} 时不算 dirty。
  const serverJson = routing.data ? JSON.stringify(routing.data) : null
  const dirty =
    serverJson !== null &&
    Object.keys(draft).length > 0 &&
    JSON.stringify(draft) !== serverJson
  const showSaveBar = dirty && !hideSave

  const discard = () => {
    setDraft(routing.data ?? {})
    setPersonaProblems([])
    setDiscardKey((k) => k + 1)
  }

  // Ctrl/Cmd+S = 保存。设置页里浏览器的「保存网页」永远不是本意，直接拦。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== 's') return
      e.preventDefault()
      if (!dirty || hideSave || save.isPending) return
      if (blocked) {
        toast.error(personaProblems[0])
        return
      }
      save.mutate()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <PageHeader title={VIEW_TITLES.settings}>
      <div className='md:grid md:grid-cols-[10.5rem_1fr] md:gap-8'>
        <SettingsNav active={tab} />
        <div className={cn('mt-4 min-w-0 md:mt-0', showSaveBar && 'pb-16')}>
          <QueryGate
            loading={routing.isLoading}
            error={routing.error}
            skeleton={<SettingsSkeleton />}
          >
            <div
              key={`${tab}:${discardKey}`}
              className='animate-settings-pane-in space-y-3'
            >
              {tab === 'sticky' ? (
                <StickyPane
                  value={sticky}
                  onChange={(next) => setDraft({ ...draft, sticky: next })}
                />
              ) : null}
              {tab === 'pool' ? (
                <div className='space-y-3'>
                  <PoolPane
                    pool={pool}
                    failover={failover}
                    onPoolChange={(next) => setDraft({ ...draft, pool: next })}
                    onFailoverChange={(next) =>
                      setDraft({ ...draft, failover: next })
                    }
                  />
                  <CredentialWeightPane />
                </div>
              ) : null}
              {tab === 'quota' ? (
                <div className='space-y-3'>
                  <QuotaTierPane
                    tiers={
                      (draft.tiers as
                        Record<string, QuotaTierPolicy> | undefined) || {}
                    }
                    defaultRpm={
                      Number(
                        (
                          draft.concurrency as
                            Record<string, unknown> | undefined
                        )?.default_max_rpm
                      ) || 0
                    }
                    onChange={(tier, next) =>
                      setDraft({
                        ...draft,
                        tiers: {
                          ...((draft.tiers as Record<
                            string,
                            QuotaTierPolicy
                          >) || {}),
                          [tier]: next,
                        },
                      })
                    }
                  />
                  <Card>
                    <CardHeader>
                      <CardTitle>配额</CardTitle>
                    </CardHeader>
                    <CardContent className='divide-y'>
                      <SettingRow label='5h 打满阻断'>
                        <Switch
                          checked={quota.block_on_5h !== false}
                          onCheckedChange={(on) =>
                            setDraft({
                              ...draft,
                              quota: { ...quota, block_on_5h: on },
                            })
                          }
                        />
                      </SettingRow>
                      <SettingRow label='7d 打满阻断'>
                        <Switch
                          checked={quota.block_on_7d !== false}
                          onCheckedChange={(on) =>
                            setDraft({
                              ...draft,
                              quota: { ...quota, block_on_7d: on },
                            })
                          }
                        />
                      </SettingRow>
                      <SettingRow label='周仓拆分'>
                        <Switch
                          checked={
                            !!(
                              quota.weekly_split as
                                Record<string, unknown> | undefined
                            )?.enabled
                          }
                          onCheckedChange={(on) =>
                            setDraft({
                              ...draft,
                              quota: {
                                ...quota,
                                weekly_split: {
                                  ...((quota.weekly_split as object) || {}),
                                  enabled: on,
                                  fable_share: 0.5,
                                },
                              },
                            })
                          }
                        />
                      </SettingRow>
                    </CardContent>
                  </Card>
                </div>
              ) : null}
              {tab === 'logs' ? (
                <LogsPane
                  value={logging}
                  onChange={(next) => setDraft({ ...draft, logging: next })}
                />
              ) : null}
              {tab === 'init' ? (
                <OfficialCcSettingsPane
                  config={
                    (draft.official_cc as
                      Record<string, unknown> | undefined) || {}
                  }
                  onChange={(next) => setDraft({ ...draft, official_cc: next })}
                />
              ) : null}
              {tab === 'protocol' ? (
                <>
                  <KernelRoutingPane
                    value={inference}
                    onChange={(next) => setDraft({ ...draft, inference: next })}
                  />
                  <PersonaPane
                    compat={
                      (draft.compatibility as
                        Record<string, unknown> | undefined) || {}
                    }
                    onChange={(next) =>
                      setDraft({ ...draft, compatibility: next })
                    }
                    onProblemsChange={setPersonaProblems}
                  />
                  <CacheBreakpointsPane
                    compat={
                      (draft.compatibility as
                        Record<string, unknown> | undefined) || {}
                    }
                    onChange={(next) =>
                      setDraft({ ...draft, compatibility: next })
                    }
                  />
                </>
              ) : null}
              {tab === 'whitelist' ? (
                <PersonaRulesPane
                  compat={
                    (draft.compatibility as
                      Record<string, unknown> | undefined) || {}
                  }
                  onChange={(next) =>
                    setDraft({ ...draft, compatibility: next })
                  }
                />
              ) : null}
              {tab === 'health' ? (
                <HealthPane
                  title={SETTINGS_TAB_LABELS[tab]}
                  failover={failover}
                  healthProbe={
                    draft.health_probe as Record<string, unknown> | undefined
                  }
                  onFailoverChange={(next) =>
                    setDraft({ ...draft, failover: next })
                  }
                />
              ) : null}
              {tab === 'notify' ? (
                <NotifyPane
                  value={draft.notify as NotifyConfig | undefined}
                  onChange={(next) => setDraft({ ...draft, notify: next })}
                />
              ) : null}
              {tab === 'telemetry' ? <TelemetryPane /> : null}
              {tab === 'socks5' ? <Socks5Pane /> : null}
              {tab === 'backup' ? <BackupPane /> : null}
            </div>
          </QueryGate>
        </div>
      </div>
      {showSaveBar ? (
        <SaveBar
          blockedReason={blocked ? personaProblems[0] : undefined}
          saving={save.isPending}
          onSave={() => save.mutate()}
          onDiscard={discard}
        />
      ) : null}
    </PageHeader>
  )
}

function settingsSaveToast(
  tab: SettingsTabId,
  compat: Record<string, unknown> | undefined,
  inherited: number
) {
  if (tab === 'protocol') {
    const label = personaPresetLabel(personaPresetFromCompat(compat))
    if (!inherited) return `已保存 · ${label}`
    return `已保存 · ${label} · ${inherited} 个槽位改为跟随全局`
  }
  if (tab === 'whitelist') {
    const count = cleanPersonaRules(personaRulesFromCompat(compat)).length
    return `已保存 · ${count} 条规则`
  }
  return '已保存'
}

function protocolFollowError(message: string) {
  if (/config_missing|kernel_start_failed|wrap_cli_missing/i.test(message)) {
    return 'wrap 配置缺失，先到 Wrap 页同步母样本，再切 rust cli-hop'
  }
  return message
}
