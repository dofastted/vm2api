import { describe, expect, it } from 'vitest'
import {
  captureLoginAuthUrl,
  loginAuthCode,
  loginAuthUrl,
  parseTerminalFrame,
} from './login-terminal'

const url = 'https://claude.com/cai/oauth/authorize?code=true&state=abc'

describe('login terminal shortcuts', () => {
  it('extracts the authorize URL from terminal text', () => {
    expect(loginAuthUrl(`Browser didn't open? ${url}\nPaste code`)).toBe(url)
    expect(loginAuthUrl('https://example.com/nope')).toBe('')
    expect(captureLoginAuthUrl('', url).url).toBe('')
  })
  it('joins an authorize URL split across terminal frames', () => {
    const cut = url.indexOf('oauth')
    const first = captureLoginAuthUrl(
      '',
      `If the browser didn't open, visit: ${url.slice(0, cut)}`
    )
    expect(first.url).toBe('')
    const second = captureLoginAuthUrl(first.pending, url.slice(cut, -1))
    expect(second.url).toBe('')
    const third = captureLoginAuthUrl(
      second.pending,
      `${url.slice(-1)}\r\nPaste code here if prompted >`
    )
    expect(third.url).toBe(url)
  })

  it('handles line wrapping and terminal control sequences', () => {
    const wrapped = url.replace('&state=', '&\r\nstate=')
    expect(captureLoginAuthUrl('', `\x1b]8;;${wrapped}\x07\x1b[0m`).url).toBe(
      url
    )
    expect(
      captureLoginAuthUrl(
        '',
        'https://claude.com/cai/oauth/authorize?code=true&\r\n'
      ).url
    ).toBe('')
  })

  it('accepts only a code and its state', () => {
    expect(loginAuthCode(' code#state ')).toBe('code#state')
    expect(loginAuthCode('code only')).toBe('')
    expect(loginAuthCode('code#state#extra')).toBe('')
    expect(loginAuthCode('code#sta\x1bte')).toBe('')
  })

  it('normalizes only recognized callback links with exactly one safe code and state', () => {
    const callback = 'https://platform.claude.com/oauth/code/callback'
    expect(loginAuthCode(`${callback}?state=abc&code=oauth%2Dcode`)).toBe(
      'oauth-code#abc'
    )
    expect(
      loginAuthCode(
        'https://console.anthropic.com/oauth/code/callback?code=valid&state=abc'
      )
    ).toBe('valid#abc')
    expect(loginAuthCode(`${callback}?code=abc%0Dexit&state=abc`)).toBe('')
    expect(loginAuthCode(`${callback}?code=valid&state=abc&state=xyz`)).toBe('')
    expect(
      loginAuthCode(`${callback}?error=access_denied&code=valid&state=abc`)
    ).toBe('')
    expect(
      loginAuthCode(
        'https://platform.claude.com.example.test/oauth/code/callback?code=valid&state=abc'
      )
    ).toBe('')
  })

  it('confirms commits only on an explicit successful login frame', () => {
    const result = {
      official_cc_bootstrap: {
        scheduled: false,
        reason: 'already_initialized',
      },
    }
    expect(
      parseTerminalFrame(JSON.stringify({ t: 'login', ok: true, ...result }))
    ).toEqual({ t: 'login', result })
    expect(parseTerminalFrame('{"t":"error","message":"凭证未同步"}')).toEqual({
      t: 'error',
      message: '凭证未同步',
    })
    expect(parseTerminalFrame('{"t":"exit","code":0}')).toEqual({
      t: 'exit',
      code: 0,
    })
    expect(parseTerminalFrame('{"t":"login","ok":false}')).toBeNull()
    expect(parseTerminalFrame('{"t":"login"}')).toBeNull()
    expect(parseTerminalFrame('not JSON')).toBeNull()
  })
})
