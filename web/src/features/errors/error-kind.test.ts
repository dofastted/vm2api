import { describe, expect, it } from 'vitest'
import { routeErrorKind } from './error-kind'

describe('route error kind', () => {
  it('classifies a failed code-split chunk as an asset error, not a server error', () => {
    for (const message of [
      'Failed to fetch dynamically imported module: https://panel.example/assets/risk-DQ8f.js',
      'error loading dynamically imported module',
      'Importing a module script failed.',
      'Loading chunk 42 failed.',
    ]) {
      expect(routeErrorKind(new Error(message))).toBe('asset')
    }
    expect(routeErrorKind({ name: 'ChunkLoadError', message: 'nope' })).toBe(
      'asset'
    )
  })

  it('treats anything else as an application error', () => {
    expect(
      routeErrorKind(
        new Error("Cannot read properties of undefined (reading 'x')")
      )
    ).toBe('app')
    expect(
      routeErrorKind(new Error('Request failed with status code 500'))
    ).toBe('app')
    expect(routeErrorKind(undefined)).toBe('app')
    expect(routeErrorKind(null)).toBe('app')
    expect(routeErrorKind('boom')).toBe('app')
    expect(routeErrorKind({})).toBe('app')
  })

  it('reduces the error to a kind so no asset URL can reach the page', () => {
    const url = 'https://panel.example/assets/chunk-with-a-long-hash.js'
    const kind = routeErrorKind(
      new Error(`Failed to fetch dynamically imported module: ${url}`)
    )
    expect(kind).toBe('asset')
    expect(JSON.stringify(kind)).not.toContain('panel.example')
  })
})
