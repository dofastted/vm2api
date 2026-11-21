import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { VmEnvironmentCard } from './environment-card'

function render(proxy: unknown) {
  return renderToStaticMarkup(
    <VmEnvironmentCard
      vm={{ timezone: 'UTC' } as never}
      proxy={proxy as never}
      saving={false}
      onSave={() => {}}
      onFollowProxy={() => {}}
    />
  )
}

describe('proxy timezone wording', () => {
  it('keeps missing proxy data distinct from geo data without a valid timezone', () => {
    expect(render(undefined)).toContain('暂无代理出口信息')
    const invalid = render({
      geo: { country: 'US', city: 'NYC', timezone: 'bad' },
    })
    expect(invalid).toContain('代理出口时区不可用')
    expect(invalid).toContain('US · NYC')
    expect(invalid).toContain('title="代理出口时区不可用"')
  })
})
