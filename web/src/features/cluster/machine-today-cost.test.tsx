import type { ReactNode } from 'react'
import type { Vm } from '@/types/panel-vm'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { MachineDetail } from './machine-detail'
import { MachineTable } from './machine-table'
import { LINK_TONE, type ClusterMachine } from './model'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, title }: { children?: ReactNode; title?: string }) => (
    <a title={title}>{children}</a>
  ),
}))

const machine = {
  id: 'local',
  role: 'local',
  name: '本机 VPS',
  address: '192.0.2.10',
  link: 'ok',
  tone: LINK_TONE.ok,
  linkSub: '直连',
  cpu: null,
  mem: null,
  memPressure: null,
  disk: null,
  slots: [{ id: 'slot-1', today_cost: 1.25 } as Vm],
  capacity: null,
  todayUsd: 1.25,
} as ClusterMachine

describe('machine today cost wording', () => {
  it('names Shanghai-calendar spend as Beijing time', () => {
    const table = renderToStaticMarkup(
      <MachineTable
        machines={[machine]}
        selectedId='local'
        onSelect={() => undefined}
      />
    )
    const detail = renderToStaticMarkup(
      <MachineDetail
        machines={[machine]}
        selectedId='local'
        onSelect={() => undefined}
        poolNameOf={() => null}
        canManage={false}
        localDetails={{ rows: null, summary: '', checkedAt: null }}
        localRefresh={{ pending: false, run: () => undefined }}
        onOpenNode={() => undefined}
        onRemove={() => undefined}
        onCreate={() => undefined}
        onMigrate={() => undefined}
      />
    )

    for (const html of [table, detail]) {
      expect(html).toContain('今日花费 · 北京时间')
      expect(html).toContain('$1.25')
      expect(html).not.toContain('>今日<')
    }
  })
})
