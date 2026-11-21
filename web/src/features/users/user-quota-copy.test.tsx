import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

let RoleFields: typeof import('./index').RoleFields

beforeAll(async () => {
  vi.stubGlobal('localStorage', { getItem: () => '', setItem: () => {} })
  ;({ RoleFields } = await import('./index'))
}, 20_000)
afterAll(() => vi.unstubAllGlobals())

describe('user quota wording', () => {
  it('limits the zero quota explanation to tenants', () => {
    const html = renderToStaticMarkup(
      <RoleFields
        role='user'
        quota={0}
        concurrency='0'
        setRole={() => {}}
        setQuota={() => {}}
        setConcurrency={() => {}}
      />
    )
    expect(html).toContain('aria-describedby="user-quota-help"')
    expect(html).toContain('仅租户受此配额限制；0 表示禁止自建 VM')
    expect(html).toContain('0 为不限')
  })
})
