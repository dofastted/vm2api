import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DeleteActiveVmHint } from './delete-active-hint'

const target = { id: 'slot-1', node_id: 'node-1', active: true } as never
const replacementFields = {
  id: 'slot-2',
  node_id: 'node-1',
  has_token: true,
}
const replacement = replacementFields as never
const unschedulable = { ...replacementFields, schedulable: false } as never

describe('force delete wording', () => {
  it('keeps takeover and blocked reasons while explaining skipped cleanup', () => {
    const switched = renderToStaticMarkup(
      <DeleteActiveVmHint target={target} vms={[target, replacement]} force />
    )
    expect(switched).toContain('接管槽位')
    expect(switched).toContain('删除面板侧槽位数据')
    const blocked = renderToStaticMarkup(
      <DeleteActiveVmHint target={target} vms={[target, unschedulable]} force />
    )
    expect(blocked).toContain('没有其它可调度、凭证有效的槽可自动接管')
    expect(blocked).not.toContain('确认后将先把活跃切到下方候选')
    expect(blocked).toContain('不清理远端节点上的容器和文件')
  })
})
