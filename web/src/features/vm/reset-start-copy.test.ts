import { describe, expect, it } from 'vitest'
import { resetNotice } from './reset-start-copy'

describe('reset start wording', () => {
  it('warns when the rebuilt slot failed to start', () => {
    expect(resetNotice('keep', 'slot-1', { runtime: { ok: false } })).toEqual({
      level: 'warning',
      message: '槽位已重建，但启动失败，当前已停止',
    })
    expect(resetNotice('keep', 'slot-1', { runtime: { ok: true } })).toEqual({
      level: 'success',
      message: '已保留原数据重建 slot-1',
    })
  })
})
