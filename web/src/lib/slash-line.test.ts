import { describe, expect, it } from 'vitest'
import { SLASH_IDLE, type SlashLine, slashInput } from './slash-line'

const NAMES = ['/usage', '/wrap', '/reload', '/help', '/clear']

/** 逐键喂入，收集发给 shell 的字节与执行的指令。 */
function feed(
  keys: string[],
  intercept = true,
  start: SlashLine = SLASH_IDLE,
  names = NAMES
) {
  let line = start
  let shell = ''
  const runs: string[] = []
  for (const key of keys) {
    const step = slashInput(line, key, names, intercept)
    line = step.line
    for (const a of step.actions) {
      if (a.kind === 'shell') shell += a.data
      if (a.kind === 'run') runs.push(a.name)
    }
  }
  return { line, shell, runs }
}

const keys = (s: string) => [...s]

describe('slashInput', () => {
  it('runs an exact command on Enter without touching the shell', () => {
    const r = feed([...keys('/usage'), '\r'])
    expect(r.runs).toEqual(['/usage'])
    expect(r.shell).toBe('')
    expect(r.line).toEqual(SLASH_IDLE)
  })

  it('hands absolute paths to the shell once they leave every command prefix', () => {
    const r = feed([...keys('/usr/bin/id'), '\r'])
    expect(r.runs).toEqual([])
    expect(r.shell).toBe('/usr/bin/id\r')
  })

  it('hands an unknown complete prefix to the shell on Enter', () => {
    const r = feed([...keys('/re'), '\r'])
    expect(r.runs).toEqual([])
    expect(r.shell).toBe('/re\r')
  })

  it('does not intercept mid-line or inside full-screen programs', () => {
    expect(feed(keys('ls /usage')).shell).toBe('ls /usage')
    const vim = feed([...keys('/usage'), '\r'], false)
    expect(vim.runs).toEqual([])
    expect(vim.shell).toBe('/usage\r')
  })

  it('passes native CLI /usage through when the shell-prompt marker is not active', () => {
    const r = feed(
      [...keys('/usage'), '\r'],
      true,
      SLASH_IDLE,
      NAMES.filter((name) => name !== '/usage')
    )
    expect(r.runs).toEqual([])
    expect(r.shell).toBe('/usage\r')
  })

  it('re-arms after Enter and Ctrl-C but not after arrow keys', () => {
    expect(feed([...keys('ls'), '\r', ...keys('/wrap'), '\r']).runs).toEqual([
      '/wrap',
    ])
    expect(feed(['x', '\x03', ...keys('/wrap'), '\r']).runs).toEqual(['/wrap'])
    const arrow = feed(['\x1b[A', ...keys('/wrap'), '\r'])
    expect(arrow.runs).toEqual([])
    expect(arrow.shell).toBe('\x1b[A/wrap\r')
  })

  it('completes a unique prefix with Tab and leaves ambiguous ones', () => {
    expect(feed([...keys('/u'), '\t', '\r']).runs).toEqual(['/usage'])
    const amb = feed([...keys('/'), '\t'])
    expect(amb.line.buf).toBe('/')
  })

  it('backspacing past the slash leaves a clean, non-intercepting line', () => {
    const r = feed(['/', '\x7f', ...keys('ls'), '\r'])
    expect(r.shell).toBe('ls\r')
    expect(r.runs).toEqual([])
  })

  it('passes control sequences typed mid-command through with the buffer', () => {
    const r = feed([...keys('/us'), '\x1b[D'])
    expect(r.shell).toBe('/us\x1b[D')
    expect(r.line.buf).toBeNull()
  })
})
