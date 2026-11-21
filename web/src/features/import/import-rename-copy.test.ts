import { describe, expect, it } from 'vitest'
import { progressOf } from './vm-package-card'

describe('import rename wording', () => {
  it('keeps a rename notice beside the start failure', () => {
    const progress = progressOf(
      {
        vm: { id: 'slot-2' },
        renamed_from: 'slot-1',
        start_error: '启动失败',
      },
      false,
      0
    )
    expect(progress?.detail).toContain('slot-1 已占用，落到 slot-2')
    expect(progress?.detail).toContain('启动失败')
  })
})
