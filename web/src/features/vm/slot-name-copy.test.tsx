import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  CRAG_DEBIAN13_SLOT_NOTICE,
  isCragDebian13Kernel,
} from './create-options'
import { CreateVmForm, draftSpecRows } from './create-vm-form'

const draft = {
  name: '测试槽',
  setName: () => {},
  platform: 'anthropic',
  setPlatform: () => {},
  dataplane: 'wrap',
  setDataplane: () => {},
  cragDisabledReason: null,
  kernel: 'ubuntu-24.04',
  setKernel: () => {},
  placement: { visible: false, nodeId: '', nodes: [] },
  kvmAvail: { status: 'ready' },
  kvmBlocked: false,
  runtimeType: 'docker',
  setRuntime: () => {},
  memory: '1g',
  setMemory: () => {},
  vcpus: 2,
  setVcpus: () => {},
  diskGb: 20,
  setDiskGb: () => {},
  region: 'auto',
  setRegion: () => {},
  locale: 'en_US.UTF-8',
  setLocale: () => {},
  typedName: '测试槽',
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

  it('lists crag-debian13 in import flow with explicit CRAG slot occupancy notice and locks CRAG dataplane when selected', () => {
    expect(isCragDebian13Kernel('crag-debian13')).toBe(true)
    expect(isCragDebian13Kernel('debian-13')).toBe(true)
    expect(isCragDebian13Kernel('ubuntu-24.04')).toBe(false)

    const flowHtml = renderToStaticMarkup(
      <CreateVmForm
        draft={
          { ...draft, kernel: 'crag-debian13', dataplane: 'crag' } as never
        }
        variant='flow'
      />
    )
    expect(flowHtml).toContain('CRAG Debian 13')
    expect(flowHtml).toContain('使用会占用 CRAG 槽位')
    expect(flowHtml).toContain(CRAG_DEBIAN13_SLOT_NOTICE)
    expect(flowHtml).toContain('CRAG Debian 13 仅支持 CRAG 推理内核')

    const specRows = draftSpecRows({
      ...draft,
      kernel: 'crag-debian13',
      dataplane: 'crag',
    } as never)
    const osRow = specRows.find((r) => r.label === '系统')
    expect(osRow?.value).toBe('CRAG Debian 13（占用 CRAG 槽位）')

    const codexHtml = renderToStaticMarkup(
      <CreateVmForm
        draft={
          { ...draft, platform: 'openai', kernel: 'ubuntu-24.04' } as never
        }
        variant='flow'
      />
    )
    expect(codexHtml).toContain('CRAG Debian 13 仅支持 Claude / CRAG 槽位')
  })
})
