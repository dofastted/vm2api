import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useParams } from '@tanstack/react-router'
import { VIEW_TITLES } from '@/config/nav'
import type { NotifyConfig } from '@/types/panel-routing'
import type { QuotaTierPolicy } from '@/types/panel-vm'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { PageHeader } from '@/components/page-header'
import { QueryGate } from '@/components/query-gate'
import { dashboardQueryOptions } from '@/features/overview/queries'
import { AboutPane } from '@/features/settings/about-pane'
import { BackupPane } from '@/features/settings/backup-pane'
import { GeminiConfigPane } from '@/features/settings/gemini-config-pane'
import { GeminiInstallPane } from '@/features/settings/gemini-install-pane'
import { HealthPane } from '@/features/settings/health-pane'
import { LogsPane } from '@/features/settings/logs-pane'
import {
  SETTINGS_TAB_LABELS,
  settingsTabId,
} from '@/features/settings/navigation'
import { NotifyPane } from '@/features/settings/notify-pane'
import { OfficialCcSettingsPane } from '@/features/settings/official-cc-pane'
import { OpenaiPane } from '@/features/settings/openai-pane'
import { PoolPane } from '@/features/settings/pool-pane'
import {
  geminiDaemonStatusQueryOptions,
  healthProbeQueryOptions,
  notifyQueryOptions,
  outboundProfileQueryOptions,
  routingQueryOptions,
} from '@/features/settings/queries'
import { QuotaTierPane } from '@/features/settings/quota-tier-pane'
import {
  buildRoutingSavePayload,
  changedRoutingSections,
  computePendingCards,
  computeSettingsBlockedReason,
  dirtySettingsTabLabels,
  settingsSaveToast,
  type RoutingSaveResult,
} from '@/features/settings/routing-draft'
import { SaveBar } from '@/features/settings/save-bar'
import { SettingsNav } from '@/features/settings/settings-nav'
import { SettingsSkeleton } from '@/features/settings/settings-skeleton'
import { Socks5Pane } from '@/features/settings/socks5-pane'
import { StickyPane } from '@/features/settings/sticky-pane'
import { uploadIntervalOf } from '@/features/settings/telemetry-interval'
import { TelemetryPane } from '@/features/settings/telemetry-pane'
import { ProtocolPane } from './protocol-pane'
import { RedactionPane } from './redaction-pane'

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
        changedRoutingSections(current, previousSnapshot).size === 0
      if (!wasHydrated || clean || shouldAccept) return next
      return current
    })
    serverSnapshot.current = next
    hydrated.current = true
  }, [routing.data])

  const save = useMutation({
    mutationFn: async () => {
      const { body, changedSections, telemetryOptIn } = buildRoutingSavePayload(
        draft,
        routing.data
      )
      const saved = await api<RoutingSaveResult>('/api/panel/routing', {
        method: 'PUT',
        body: JSON.stringify(body),
      })
      return { saved, changedSections, telemetryOptIn }
    },
    onSuccess: async ({ saved, changedSections, telemetryOptIn }) => {
      const notice = settingsSaveToast({
        changedSections,
        telemetryOptIn,
        saved,
      })
      if (notice.level === 'warning') {
        toast.warning(notice.message)
      } else {
        toast.success(notice.message)
      }
      acceptNextServer.current = true
      await Promise.all([
        qc.invalidateQueries({ queryKey: routingQueryOptions().queryKey }),
        qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
        qc.invalidateQueries({
          queryKey: outboundProfileQueryOptions().queryKey,
        }),
        ...(changedSections.has('notify')
          ? [qc.invalidateQueries({ queryKey: notifyQueryOptions().queryKey })]
          : []),
        ...(changedSections.has('gemini')
          ? [
              qc.invalidateQueries({
                queryKey: geminiDaemonStatusQueryOptions().queryKey,
              }),
            ]
          : []),
        ...(changedSections.has('health_probe')
          ? [
              qc.invalidateQueries({
                queryKey: healthProbeQueryOptions().queryKey,
              }),
            ]
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
  const changedSections = changedRoutingSections(draft, routing.data)
  const dirty =
    routing.data != null &&
    Object.keys(draft).length > 0 &&
    changedSections.size > 0
  const pendingCards = computePendingCards(draft, routing.data)
  const saveBlockedReason = dirty
    ? computeSettingsBlockedReason(draft, changedSections)
    : undefined
  const isNonRoutingTab =
    tab === 'socks5' || tab === 'backup' || tab === 'about' || tab === 'gemini'
  const dirtyLabels = dirty ? dirtySettingsTabLabels(draft, routing.data) : []
  const saveBarSummary = dirty
    ? isNonRoutingTab ||
      dirtyLabels.length > 1 ||
      (dirtyLabels.length === 1 && dirtyLabels[0] !== SETTINGS_TAB_LABELS[tab])
      ? `有未保存的设置更改（${dirtyLabels.join('、')}）`
      : '有未保存的更改'
    : undefined
  const showSaveBar = dirty
  const maxBodyMib =
    typeof routing.data?.max_body_mib === 'number'
      ? routing.data.max_body_mib
      : typeof routing.data?.max_body_bytes === 'number'
        ? Math.floor(routing.data.max_body_bytes / (1024 * 1024))
        : undefined

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
      if (!dirty || save.isPending || !!saveBlockedReason) return
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
          ? 'Claude 配额闸线、并发、RPM，以及请求体上限。GPT 配额在 OpenAI 页。个人自用引导会把闸关掉并拉到上限；这里仍可再改。'
          : tab === 'openai'
            ? 'GPT 传输、准入、配额与客户端画像。全局 WebSocket 只作用于推理，不影响终端或集群。'
            : tab === 'gemini-config'
              ? 'Gemini 入口准入、CRAGGemini 单进程分片接管、并发调度、性能配置与故障保护。宿主安装与升级在「Gemini 维护」页。'
              : tab === 'logs'
                ? '设置请求日志的记录模式、保留天数与 Debug 载荷上限。逐条记录在日志页查看。'
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
                  pendingCards={pendingCards.sticky}
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
                    pendingCards={pendingCards.pool}
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
                  failover={failover}
                  maxBodyMib={maxBodyMib}
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
                  saving={save.isPending}
                  pending={dirty}
                  pendingCards={pendingCards.quota}
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
                  pendingQuotaCards={pendingCards.openai}
                />
              ) : null}
              {tab === 'gemini-config' ? (
                <GeminiConfigPane
                  value={
                    (draft.gemini as Record<string, unknown> | undefined) || {}
                  }
                  onChange={(next) =>
                    setDraft((current) => ({ ...current, gemini: next }))
                  }
                  saving={save.isPending}
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
              {tab === 'redaction' ? (
                <RedactionPane
                  redaction={
                    (draft.redaction as
                      Record<string, unknown> | undefined) || {
                      enabled: false,
                      secrets: true,
                      personal: true,
                      words: [],
                      wordsAnyCase: false,
                      rules: [],
                      kinds: {},
                      allow: [],
                    }
                  }
                  runtime={
                    (draft.redaction_runtime as
                      Record<string, unknown> | undefined) || {}
                  }
                  onChange={(next) =>
                    setDraft((current) => ({ ...current, redaction: next }))
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
                  defaultEnabled={
                    (draft.telemetry as Record<string, unknown> | undefined)
                      ?.default_enabled === true
                  }
                  disableNonessentialTraffic={
                    (draft.telemetry as Record<string, unknown> | undefined)
                      ?.disable_nonessential_traffic === true
                  }
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
                  onDefaultEnabledChange={(enabled) =>
                    setDraft((current) => ({
                      ...current,
                      telemetry: {
                        ...((current.telemetry as Record<string, unknown>) ||
                          {}),
                        default_enabled: enabled,
                      },
                    }))
                  }
                  onDisableNonessentialTrafficChange={(enabled) =>
                    setDraft((current) => ({
                      ...current,
                      telemetry: {
                        ...((current.telemetry as Record<string, unknown>) ||
                          {}),
                        disable_nonessential_traffic: enabled,
                      },
                    }))
                  }
                />
              ) : null}
              {tab === 'socks5' ? <Socks5Pane /> : null}
              {tab === 'backup' ? <BackupPane /> : null}
              {tab === 'about' ? <AboutPane /> : null}
              {tab === 'gemini' ? <GeminiInstallPane /> : null}
            </div>
          </QueryGate>
        </div>
      </div>
      {showSaveBar ? (
        <SaveBar
          blockedReason={saveBlockedReason}
          summary={saveBarSummary}
          saving={save.isPending}
          onSave={() => save.mutate()}
          onDiscard={discard}
        />
      ) : null}
    </PageHeader>
  )
}

function protocolFollowError(message: string) {
  if (/config_missing|kernel_start_failed|wrap_cli_missing/i.test(message)) {
    return '内核文件缺失，先到内核页拉取 wrap/crag 二进制再同步'
  }
  return message
}
