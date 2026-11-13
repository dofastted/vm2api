import { useEffect, useState } from 'react'
import type { Vm } from '@/types/panel-vm'
import { statusColorForPct } from '@/lib/fable-status'
import { fmtCountdown } from '@/lib/format'
import { poolQuota, type PoolWindow } from '@/lib/pool-quota'
import { useNow } from '@/hooks/use-now'
import { PanelCard } from '@/features/overview/panel-card'

/**
 * 单凭证竖条：高度 = 已用比例，颜色走 `statusColorForPct` 三档阈值
 * （健康是默认绿，异常才升 caution/warn/bad）。未探测的凭证画虚线空段——
 * 计容量但不冒充「确认可用」。
 */
function SegBar({
  usedPct,
  probed,
  name,
  live,
  delayMs,
}: {
  usedPct: number
  probed: boolean
  name: string
  live: boolean
  delayMs: number
}) {
  if (!probed) {
    return (
      <i
        title={`${name} · 未探测`}
        className='h-full min-w-1 flex-1 rounded-[2px] border border-dashed border-[color:var(--status-none)] opacity-60'
        style={{ maxWidth: 18 }}
      />
    )
  }
  return (
    <i
      title={`${name} · 已用 ${usedPct.toFixed(0)}%`}
      className='relative h-full min-w-1 flex-1 overflow-hidden rounded-[2px] bg-muted'
      style={{ maxWidth: 18 }}
    >
      <i
        className='absolute inset-x-0 bottom-0 block transition-[height] duration-700 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none'
        style={{
          height: live ? `${usedPct}%` : '0%',
          background: statusColorForPct(usedPct),
          transitionDelay: `${delayMs}ms`,
        }}
      />
    </i>
  )
}

function WindowCell({
  win,
  live,
  now,
}: {
  win: PoolWindow
  live: boolean
  now: number
}) {
  const usedPoolPct = 100 - win.remainPct
  // 最早的未来重置 = 池容量下一次回血的时刻。已到点未刷新的不选，
  // 免得倒计时钉死在 0；后端刷新窗口后自然跳到下一张。
  const next = win.segs.reduce<{ at: number; name: string } | null>(
    (best, s) =>
      s.resetAt > now && (!best || s.resetAt < best.at)
        ? { at: s.resetAt, name: s.name }
        : best,
    null
  )
  // 池级数字只在逼近耗尽时着色——健康是默认，不需要颜色。
  const valueColor =
    win.capacity && usedPoolPct >= 85
      ? statusColorForPct(usedPoolPct)
      : undefined
  return (
    <div className='min-w-0 bg-card px-4 py-3'>
      <div className='flex items-baseline justify-between gap-2'>
        <span className='text-[11.5px] text-muted-foreground'>{win.label}</span>
        {win.capacity ? (
          <span className='text-[11px] text-muted-foreground tabular-nums'>
            余 {win.remainPct.toFixed(0)}%
          </span>
        ) : null}
      </div>
      <div
        className='mt-0.5 text-[20px] leading-tight font-semibold tracking-tight tabular-nums'
        style={valueColor ? { color: valueColor } : undefined}
      >
        {win.capacity ? (
          <>
            {win.remainAccounts.toFixed(1)}
            <small className='ml-1 text-[13px] font-medium text-muted-foreground'>
              / {win.capacity} 账号
            </small>
          </>
        ) : (
          '—'
        )}
      </div>
      {win.capacity ? (
        <>
          <div className='mt-0.5 flex items-baseline justify-between gap-2 text-[11px] text-muted-foreground tabular-nums'>
            <span>已耗 {win.usedAccounts.toFixed(1)} 账号当量</span>
            {next ? (
              <span
                title={`${next.name} · ${new Date(next.at).toLocaleString()}`}
              >
                最早重置 {fmtCountdown(next.at - now)}
              </span>
            ) : null}
          </div>
          <div
            role='img'
            aria-label={`${win.label} 剩余 ${win.remainPct.toFixed(0)}%，已耗 ${win.usedAccounts.toFixed(1)} / ${win.capacity} 账号`}
            className='mt-2 flex h-9 items-stretch gap-[2px]'
          >
            {win.segs.map((s, i) => (
              <SegBar
                key={s.id}
                usedPct={s.usedPct}
                probed={s.probed}
                name={
                  s.resetAt > now
                    ? `${s.name} · 重置 ${fmtCountdown(s.resetAt - now)}`
                    : s.name
                }
                live={live}
                delayMs={Math.min(i * 30, 420)}
              />
            ))}
          </div>
        </>
      ) : (
        <div className='mt-0.5 text-[11px] text-muted-foreground'>
          无 Fable 窗口数据
        </div>
      )}
    </div>
  )
}

/**
 * 号池三窗口（5h / 7d / Fable）总额度。容量按「有效凭证」全量计
 * （每张 = 1 个满窗口，含调度关 / 冷却 / 限制中——额度真实存在），
 * 消耗逐凭证相加；无效 / 过期 / revoke 不计入。口径与 KPI「可用账号」
 * 同源（都走 accountUsable，凭证有效=可用）；Fable 按套餐窗口或上游返回的窗口计入。
 * 竖条一凭证一段、按已用降序——风险集中在最左侧，值班扫一眼即得。
 */
export function PoolQuota({ vms }: { vms: Vm[] }) {
  const { windows, eligible, withToken } = poolQuota(vms)
  const now = useNow()
  // 首帧后再放开高度，让分段条从 0 涨到实际用量；数据刷新时同一 transition 平滑跟随。
  const [live, setLive] = useState(false)
  useEffect(() => {
    const id = requestAnimationFrame(() => setLive(true))
    return () => cancelAnimationFrame(id)
  }, [])
  return (
    <PanelCard
      title='号池额度'
      meta={`${eligible} 张有效凭证 / 共 ${withToken} · 无效与 revoke 不计`}
    >
      <div className='grid gap-px bg-border/60 sm:grid-cols-3'>
        {windows.map((w) => (
          <WindowCell key={w.key} win={w} live={live} now={now} />
        ))}
      </div>
    </PanelCard>
  )
}
