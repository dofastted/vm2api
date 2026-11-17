import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { NodeGoneDeleteOption } from './delete-active-hint'

const render = (gone: 'missing' | 'offline' | null, checked = false) =>
  renderToStaticMarkup(
    <NodeGoneDeleteOption
      gone={gone}
      checked={checked}
      onCheckedChange={() => {}}
    />
  )

describe('NodeGoneDeleteOption', () => {
  it('stays hidden while the node is reachable or the slot is local', () => {
    expect(render(null)).toBe('')
  })

  it('spells out that only the panel record goes and the node is re-checked', () => {
    const html = render('offline')
    expect(html).toContain('节点不可达：只删除面板记录，节点上的容器不清理')
    expect(html).toContain('节点当前连不上。')
    expect(html).toContain('连得上就拒绝，请改用普通删除')
    expect(html).toContain('role="checkbox"')
    expect(html).toContain('aria-checked="false"')
    expect(render('missing', true)).toContain('节点已不在集群列表里。')
    expect(render('missing', true)).toContain('aria-checked="true"')
  })
})
