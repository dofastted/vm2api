import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ProtocolPane } from './protocol-pane'

const render = (compat: Record<string, unknown>) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <ProtocolPane
        compat={compat}
        inference={{}}
        onCompatChange={() => {}}
        onInferenceChange={() => {}}
      />
    </QueryClientProvider>
  )

describe('count_tokens switch wording', () => {
  it('says the entries 404 while off, and names both of them when on', () => {
    expect(render({})).toContain('已关：上述两个入口返回 404')
    const on = render({ count_tokens: true })
    expect(on).toContain('/v1/messages/count_tokens')
    expect(on).toContain('不绑定 sticky、不计费')
  })
})

describe('blocked client wording', () => {
  it('does not claim an unblocked client is answered 400 upstream', () => {
    // relocateThirdPartySystem keys on the content of `system` (78223cdf1), so an
    // official-CLI request with an appended foreign block is served, not refused.
    // Copy saying otherwise would push an operator to switch on a block they do not
    // need -- and the block runs before relocation, giving up a working request.
    const off = render({})
    expect(off).toContain('会被搬到首个 user 轮次后正常服务')
    expect(off).not.toContain('会被上游认成第三方应用而 400')
    expect(render({ blocked_clients: { openclaw: true } })).toContain(
      '这发生在第三方 system 搬移之前'
    )
  })
})

describe('strict official CC verification scope wording', () => {
  it('explains that multi-signal verification applies to official traffic/passthrough as well as claude_code_only', () => {
    const off = render({ claude_code_only: false })
    expect(off).toContain('官方流量判定与官方透传始终执行严格校验')
    expect(off).toContain('非零 64-hex device_id + UUIDv4 session_id')
    expect(off).toContain('拒绝 cch=00000')
    expect(off).toContain('区分大小写官方 PascalCase / mcp__')
    expect(off).toContain('排除第三方仿冒/克隆')
    expect(off).not.toContain('opacity-55')

    const on = render({ claude_code_only: true })
    expect(on).toContain(
      '官方流量判定、官方透传与「仅允许 Claude Code」共用同一套严格校验'
    )
  })
})
