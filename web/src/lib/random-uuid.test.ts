import { afterEach, describe, expect, it, vi } from 'vitest'
import { isRfc4122Uuid, randomUUID } from './random-uuid'

describe('randomUUID', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses crypto.randomUUID when available', () => {
    const native = vi.fn(() => '11111111-1111-4111-8111-111111111111')
    vi.stubGlobal('crypto', {
      randomUUID: native,
      getRandomValues: vi.fn(),
    })
    expect(randomUUID()).toBe('11111111-1111-4111-8111-111111111111')
    expect(native).toHaveBeenCalledTimes(1)
  })

  it('returns an RFC4122 v4 UUID when randomUUID is absent', () => {
    const fill = vi.fn((buf: Uint8Array) => {
      for (let i = 0; i < buf.length; i++) buf[i] = (i * 17) % 256
      return buf
    })
    vi.stubGlobal('crypto', { getRandomValues: fill })
    const id = randomUUID()
    expect(fill).toHaveBeenCalled()
    expect(isRfc4122Uuid(id)).toBe(true)
    expect(id[14]).toBe('4')
    expect('89ab').toContain(id[19]!.toLowerCase())
  })

  it('still returns a UUID when neither randomUUID nor getRandomValues exist', () => {
    vi.stubGlobal('crypto', undefined)
    const id = randomUUID()
    expect(isRfc4122Uuid(id)).toBe(true)
  })
})
