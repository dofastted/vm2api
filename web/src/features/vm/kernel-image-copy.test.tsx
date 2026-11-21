import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Dialog } from '@/components/ui/dialog'
import { KernelRepairChoices } from './detail-ops-tab'

describe('kernel image wording', () => {
  it('keeps identity rebuild local and describes remote updates plainly', () => {
    const remote = renderToStaticMarkup(
      <Dialog open>
        <KernelRepairChoices
          remote
          kernelMode='keep'
          setKernelMode={() => {}}
          onCancel={() => {}}
          onConfirm={() => {}}
        />
      </Dialog>
    )
    expect(remote).toContain('更新 kernel；不会清空家目录或重建身份。')
    expect(remote).not.toContain('重建新特征')
    const local = renderToStaticMarkup(
      <Dialog open>
        <KernelRepairChoices
          remote={false}
          kernelMode='traits'
          setKernelMode={() => {}}
          onCancel={() => {}}
          onConfirm={() => {}}
        />
      </Dialog>
    )
    expect(local).toContain('重建新特征')
  })
})
