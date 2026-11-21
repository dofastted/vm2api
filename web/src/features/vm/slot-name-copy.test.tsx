import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CreateVmForm } from './create-vm-form'

const draft = {
  name: '测试槽',
  setName: () => {},
  placement: { visible: false, nodeId: '' },
  kvmAvail: { status: 'ready' },
  kvmBlocked: false,
  runtimeType: 'docker',
  create: { isPending: false, mutate: () => {} },
  blocked: false,
  placementChecks: [],
  pinnedAfter: true,
}

describe('slot name wording', () => {
  it('keeps the display-name explanation visible', () => {
    const html = renderToStaticMarkup(
      <CreateVmForm draft={draft as never} variant='dialog' />
    )
    expect(html).toContain('aria-describedby="slot-name-help"')
    expect(html).toContain(
      '名称会显示在列表中；可用的字母或数字也会用于生成槽位 ID。留空或只填中文时自动编号'
    )
    expect(html).toContain('并发跟随设置里的全局默认')
  })
})
