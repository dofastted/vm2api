import { useEffect, useRef, useState } from 'react'
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
import {
  personaInjectFromPreset,
  personaPresetFromCompat,
} from '@/lib/persona-template'
import { cn } from '@/lib/utils'
import { isCodexVm } from '@/lib/vm-kind'
import { PageHeader } from '@/components/page-header'
import { QueryGate } from '@/components/query-gate'
import { dashboardQueryOptions } from '@/features/overview/queries'
import { AboutPane } from '@/features/settings/about-pane'
import { BackupPane } from '@/features/settings/backup-pane'
import { HealthPane } from '@/features/settings/health-pane'
import { LogsPane } from '@/features/settings/logs-pane'
import {
  SETTINGS_TAB_LABELS,
  settingsTabId,
  type SettingsTabId,
} from '@/features/settings/navigation'
import { NotifyPane } from '@/features/settings/notify-pane'
import { OfficialCcSettingsPane } from '@/features/settings/official-cc-pane'
import { OpenaiPane } from '@/features/settings/openai-pane'
import { PoolPane } from '@/features/settings/pool-pane'
import {
  cchEnabledFromCompat,
  inheritProtocolOnSlots,
  sessionIdleTtlFromInference,
  thinkingDisplayFromCompat,
} from '@/features/settings/protocol-authority'
import {
  notifyQueryOptions,
  outboundProfileQueryOptions,
  routingQueryOptions,
} from '@/features/settings/queries'
import { QuotaTierPane } from '@/features/settings/quota-tier-pane'
import { SaveBar } from '@/features/settings/save-bar'
import { SettingsNav } from '@/features/settings/settings-nav'
import { SettingsSkeleton } from '@/features/settings/settings-skeleton'
import { Socks5Pane } from '@/features/settings/socks5-pane'
import { StickyPane } from '@/features/settings/sticky-pane'
import { uploadIntervalOf } from '@/features/settings/telemetry-interval'
import { TelemetryPane } from '@/features/settings/telemetry-pane'
import { ProtocolPane } from './protocol-pane'

export function SettingsPage() {
  const { tab: raw } = useParams({ from: '/_authenticated/settings/$tab' })
  const tab = settingsTabId(raw)
  const routing = useQuery(routingQueryOptions())
  const qc = useQueryClient()
  const [draft, setDraft] = useState<Record<string, unknown>>({})
  const [discardKey, setDiscardKey] = useState(0)
  const hydrated = useRef(false)
  const serverSnapshot = useRef<Record<string, unknown> | null>(null)
  const acceptNextServer = useRef(false)
  useEffect(() => {
    if (!routing.data) return
    const next = routing.data
    const shouldAccept = acceptNextServer.current
    acceptNextServer.current = false
    const previousSnapshot = serverSnapshot.current
    const wasHydrated = hydrated.current
    setDraft((current) => {
      const clean =
        previousSnapshot === null ||
        JSON.stringify(current) === JSON.stringify(previousSnapshot)
      if (!wasHydrated || clean || shouldAccept) return next
      return current
    })
    serverSnapshot.current = next
    hydrated.current = true
  }, [routing.data])

  const save = useMutation({
    mutationFn: () => {
      const body = { ...draft }
      const compat = (body.compatibility as Record<string, unknown>) || {}
      if (tab === 'protocol') {
        const preset = personaPresetFromCompat(compat)
        const breakpoints = cacheBreakpointsFromCompat(compat)
        body.compatibility = {
          ...compat,
          persona_preset: preset,
          overlay_preset: 'off',
          persona_standing: String(compat.persona_standing ?? ''),
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
          claude_code_only: compat.claude_code_only === true,
          official_cc_passthrough: compat.official_cc_passthrough === true,
          cch_enabled: cchEnabledFromCompat(compat),
          thinking_display: thinkingDisplayFromCompat(compat),
        }
      }
      if (tab === 'init') {
        const official = (body.official_cc as Record<string, unknown>) || {}
        body.official_cc = { ...official, inference: 'cli-hop' }
      }
      if (tab === 'protocol') {
        const inference = (body.inference as Record<string, unknown>) || {}
        body.inference = {
          ...inference,
          engine: 'rust',
          fallback_to_go: false,
          session_idle_ttl_seconds: sessionIdleTtlFromInference(inference),
        }
      }
      return api<RoutingSaveResult>('/api/panel/routing', {
        method: 'PUT',
        body: JSON.stringify(body),
      })
    },
    onSuccess: async (saved) => {
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
      toast.success(
        settingsSaveToast(
          tab,
          inherited,
          saved?.kernel_persona,
          saved?.telemetry_sync
        )
      )
      acceptNextServer.current = true
      await Promise.all([
        qc.invalidateQueries({ queryKey: routingQueryOptions().queryKey }),
        qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
        qc.invalidateQueries({
          queryKey: outboundProfileQueryOptions().queryKey,
        }),
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
  const serverJson = routing.data ? JSON.stringify(routing.data) : null
  const dirty =
    serverJson !== null &&
    Object.keys(draft).length > 0 &&
    JSON.stringify(draft) !== serverJson
  const hideSave = tab === 'socks5' || tab === 'backup' || tab === 'about'
  const showSaveBar = dirty && !hideSave

  const discard = () => {
    const next = routing.data ?? {}
    setDraft(next)
    serverSnapshot.current = next
    hydrated.current = true
    setDiscardKey((k) => k + 1)
  }

  // Ctrl/Cmd+S = 保存。设置页里浏览器的「保存网页」永远不是本意，直接拦。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== 's') return
      e.preventDefault()
      if (!dirty || hideSave || save.isPending) return
      save.mutate()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <PageHeader
      title={VIEW_TITLES.settings}
      description={
        tab === 'quota'
          ? 'Claude 配额闸线、并发和 RPM。GPT 配额在 OpenAI 页。个人自用引导会把闸关掉并拉到上限；这里仍可再改。'
          : tab === 'openai'
            ? 'GPT 传输、准入、配额与客户端画像。全局 WebSocket 只作用于推理，不影响终端或集群。'
            : undefined
      }
    >
      <div className='@2xl/content:grid @2xl/content:grid-cols-[10.5rem_1fr] @2xl/content:gap-8'>
        <SettingsNav active={tab} />
        <div
          className={cn(
            'mt-4 min-w-0 @2xl/content:mt-0',
            showSaveBar && 'pb-16'
          )}
        >
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
                  saving={save.isPending}
                  pending={dirty}
                  onChange={(patch) =>
                    setDraft((current) => ({
                      ...current,
                      sticky: {
                        ...((current.sticky as Record<string, unknown>) || {}),
                        ...patch,
                      },
                    }))
                  }
                />
              ) : null}
              {tab === 'pool' ? (
                <div className='space-y-4'>
                  <PoolPane
                    pool={pool}
                    failover={failover}
                    inference={inference}
                    saving={save.isPending}
                    pending={dirty}
                    onPoolChange={(patch) =>
                      setDraft((current) => ({
                        ...current,
                        pool: {
                          ...((current.pool as Record<string, unknown>) || {}),
                          ...patch,
                        },
                      }))
                    }
                    onFailoverChange={(patch) =>
                      setDraft((current) => ({
                        ...current,
                        failover: {
                          ...((current.failover as Record<string, unknown>) ||
                            {}),
                          ...patch,
                        },
                      }))
                    }
                    onInferenceChange={(patch) =>
                      setDraft((current) => ({
                        ...current,
                        inference: {
                          ...((current.inference as Record<string, unknown>) ||
                            {}),
                          ...patch,
                        },
                      }))
                    }
                  />
                </div>
              ) : null}
              {tab === 'quota' ? (
                <QuotaTierPane
                  tiers={
                    (draft.tiers as
                      Record<string, QuotaTierPolicy> | undefined) || {}
                  }
                  quota={quota}
                  onChange={(tier, next) =>
                    setDraft((current) => {
                      const currentTiers =
                        (current.tiers as
                          Record<string, QuotaTierPolicy> | undefined) || {}
                      return {
                        ...current,
                        tiers: {
                          ...currentTiers,
                          [tier]: {
                            ...(currentTiers[tier] || {}),
                            ...next,
                          },
                        },
                      }
                    })
                  }
                  onQuotaChange={(patch) =>
                    setDraft((current) => {
                      const currentQuota =
                        (current.quota as Record<string, unknown>) || {}
                      const currentWeekly =
                        (currentQuota.weekly_split as
                          Record<string, unknown> | undefined) || {}
                      return {
                        ...current,
                        quota: {
                          ...currentQuota,
                          ...patch,
                          ...(patch.weekly_split
                            ? {
                                weekly_split: {
                                  ...currentWeekly,
                                  ...(patch.weekly_split as Record<
                                    string,
                                    unknown
                                  >),
                                },
                              }
                            : {}),
                        },
                      }
                    })
                  }
                  saving={save.isPending}
                  pending={dirty}
                />
              ) : null}
              {tab === 'openai' ? (
                <OpenaiPane
                  websocket={
                    (draft.websocket as Record<string, unknown> | undefined) ||
                    {}
                  }
                  codex={
                    (draft.codex as Record<string, unknown> | undefined) || {}
                  }
                  onWebsocketChange={(next) =>
                    setDraft((current) => ({ ...current, websocket: next }))
                  }
                  onCodexChange={(next) =>
                    setDraft((current) => ({ ...current, codex: next }))
                  }
                  saving={save.isPending}
                  pending={dirty}
                />
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
                <ProtocolPane
                  compat={
                    (draft.compatibility as
                      Record<string, unknown> | undefined) || {}
                  }
                  inference={inference}
                  onCompatChange={(next) =>
                    setDraft((current) => ({ ...current, compatibility: next }))
                  }
                  onInferenceChange={(patch) =>
                    setDraft((current) => ({
                      ...current,
                      inference: {
                        ...((current.inference as
                          Record<string, unknown> | undefined) || {}),
                        ...patch,
                      },
                    }))
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
                  compatibility={
                    (draft.compatibility as
                      Record<string, unknown> | undefined) || {}
                  }
                  onFailoverChange={(next) =>
                    setDraft({ ...draft, failover: next })
                  }
                  onHealthProbeChange={(next) =>
                    setDraft({ ...draft, health_probe: next })
                  }
                  onCompatibilityChange={(next) =>
                    setDraft({ ...draft, compatibility: next })
                  }
                />
              ) : null}
              {tab === 'notify' ? (
                <NotifyPane
                  value={draft.notify as NotifyConfig | undefined}
                  onChange={(next) => setDraft({ ...draft, notify: next })}
                />
              ) : null}
              {tab === 'telemetry' ? (
                <TelemetryPane
                  interval={uploadIntervalOf(
                    (draft.telemetry as Record<string, unknown> | undefined)
                      ?.upload_interval_seconds
                  )}
                  onIntervalChange={(seconds) =>
                    setDraft((current) => ({
                      ...current,
                      telemetry: {
                        ...((current.telemetry as Record<string, unknown>) ||
                          {}),
                        upload_interval_seconds: seconds,
                      },
                    }))
                  }
                />
              ) : null}
              {tab === 'socks5' ? <Socks5Pane /> : null}
              {tab === 'backup' ? <BackupPane /> : null}
              {tab === 'about' ? <AboutPane /> : null}
            </div>
          </QueryGate>
        </div>
      </div>
      {showSaveBar ? (
        <SaveBar
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
  inherited: number,
  kernel?: { updated?: number } | null,
  telemetry?: RoutingSaveResult['telemetry_sync']
) {
  if (tab === 'protocol') {
    const hot =
      kernel && typeof kernel.updated === 'number'
        ? kernel.updated > 0
          ? `kernel 配置已热更新 ${kernel.updated} 个槽`
          : 'kernel 配置已一致'
        : '已写入'
    if (!inherited) return `已保存 · ${hot}`
    return `已保存 · ${inherited} 个槽位改为跟随全局 · ${hot}`
  }
  if (tab === 'openai') return '已保存 · GPT 配置'
  if (tab === 'telemetry' && telemetry) {
    const queued = telemetry.queued
      ? ` · ${telemetry.queued} 个集群槽已排队推送到节点`
      : ''
    const failed = telemetry.failed?.length
      ? ` · ${telemetry.failed.length} 个写入失败：${telemetry.failed.slice(0, 3).join('、')}`
      : ''
    return `已保存 · ${telemetry.updated ?? 0} 个本机槽已热更新${queued}${failed}`
  }
  return '已保存'
}

function protocolFollowError(message: string) {
  if (/config_missing|kernel_start_failed|wrap_cli_missing/i.test(message)) {
    return '内核文件缺失，先到内核页拉取 wrap/crag 二进制再同步'
  }
  return message
}

type RoutingSaveResult = {
  kernel_persona?: { updated?: number; skipped?: number } | null
  telemetry_sync?: {
    updated?: number
    queued?: number
    skipped?: number
    failed?: string[]
  } | null
}
