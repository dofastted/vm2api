import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CragPreviewPage, type PreviewCanvas } from './crag-preview'
import type { PreviewField } from './crag-preview-field'

const state = vi.hoisted(() => ({
  values: [] as unknown[],
  refs: [] as Array<{ current: unknown }>,
  cursor: 0,
  refCursor: 0,
  effects: [] as Array<() => void | (() => void)>,
  layouts: [] as Array<() => void>,
  fields: [] as Array<Parameters<typeof PreviewField>[0]>,
}))

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useState: (initial: unknown) => {
    const index = state.cursor++
    if (index >= state.values.length) state.values[index] = initial
    return [
      state.values[index],
      (next: unknown) => {
        state.values[index] = next
      },
    ]
  },
  useRef: (initial: unknown) => {
    const index = state.refCursor++
    state.refs[index] ??= { current: initial }
    return state.refs[index]
  },
  useEffect: (effect: () => void | (() => void)) => state.effects.push(effect),
  useLayoutEffect: (effect: () => void) => state.layouts.push(effect),
}))
vi.mock('./crag-preview-field', () => ({
  PreviewField: (props: Parameters<typeof PreviewField>[0]) => {
    state.fields.push(props)
    return props.value || props.fallback
  },
}))
vi.mock('@/lib/api', () => {
  throw new Error('Preview must not import purchase APIs')
})

const origin = 'https://admin.example'
const draft = {
  type: 'crag-preview:draft',
  theme: 'dark',
  edit: true,
  seq: 1,
  selected: 'draft-1',
  draft: {
    plans: [
      {
        sku: 'draft-1',
        term: '1m',
        amount_minor: 100,
        slot_limit: 1,
        name: '已应用名称',
      },
    ],
  },
}
const parent = { postMessage: vi.fn() }
const listeners = new Map<string, (event: MessageEvent) => void>()
let classes: Set<string>
let html = ''
let cleanup: void | (() => void)

function render() {
  state.cursor = 0
  state.refCursor = 0
  state.effects = []
  state.layouts = []
  state.fields = []
  const element = CragPreviewPage()
  html = renderToStaticMarkup(element)
  return element as ReactElement<Parameters<typeof PreviewCanvas>[0]>
}

function receive(
  data: unknown = draft,
  source: unknown = parent,
  from = origin
) {
  listeners.get('message')?.({ data, source, origin: from } as MessageEvent)
}

beforeEach(() => {
  state.values = []
  state.refs = []
  listeners.clear()
  classes = new Set(['light', 'unrelated-class'])
  parent.postMessage.mockReset()
  vi.stubGlobal('window', {
    parent,
    location: { ancestorOrigins: [origin, 'https://outer.example'] },
    addEventListener: (type: string, listener: (event: MessageEvent) => void) =>
      listeners.set(type, listener),
    removeEventListener: (type: string) => listeners.delete(type),
  })
  vi.stubGlobal('document', {
    referrer: '',
    documentElement: {
      classList: {
        contains: (name: string) => classes.has(name),
        add: (...names: string[]) => names.forEach((name) => classes.add(name)),
        remove: (...names: string[]) =>
          names.forEach((name) => classes.delete(name)),
      },
    },
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('No preview network requests')
    })
  )
  render()
  cleanup = state.effects[0]()
})

afterEach(() => {
  cleanup?.()
  expect(fetch).not.toHaveBeenCalled()
  vi.unstubAllGlobals()
})

describe('preview parent channel', () => {
  it('acknowledges only after rendering and the commit effect, then restores theme', () => {
    expect(parent.postMessage).toHaveBeenCalledExactlyOnceWith(
      { type: 'crag-preview:ready' },
      '*'
    )
    receive()
    expect(parent.postMessage).toHaveBeenCalledTimes(1)
    render()
    expect(html).toContain('已应用名称')
    expect(parent.postMessage).toHaveBeenCalledTimes(1)
    parent.postMessage.mockImplementation((data) => {
      if (data.type !== 'crag-preview:applied') return
      expect(html).toContain('已应用名称')
      expect(classes.has('dark')).toBe(true)
    })
    state.layouts.forEach((effect) => effect())
    expect(parent.postMessage).toHaveBeenLastCalledWith(
      { type: 'crag-preview:applied', seq: 1 },
      origin
    )
    cleanup?.()
    cleanup = undefined
    expect(classes).toEqual(new Set(['light', 'unrelated-class']))
    expect(listeners.size).toBe(0)
  })

  it('rejects foreign sources, non-ancestor origins, malformed drafts and stale sequences', () => {
    receive(draft, {})
    receive(draft, parent, 'null')
    receive(draft, parent, 'https://outer.example')
    receive({ ...draft, theme: 'system' })
    render()
    expect(html).toContain('等待后台')
    receive({ ...draft, seq: 4 })
    receive({ ...draft, seq: 5 }, parent, 'https://stranger.example')
    receive({ ...draft, seq: 3 })
    receive({ ...draft, seq: 4, edit: false })
    receive({ ...draft, seq: undefined })
    expect(render().props.edit).toBe(true)
    state.layouts.forEach((effect) => effect())
    expect(parent.postMessage).toHaveBeenLastCalledWith(
      { type: 'crag-preview:applied', seq: 4 },
      origin
    )
  })

  it('pins the first valid parent origin when ancestor/referrer metadata is unavailable', () => {
    cleanup?.()
    Object.defineProperty(window, 'location', { value: {}, configurable: true })
    render()
    cleanup = state.effects[0]()
    receive({ bad: true }, parent, 'https://invalid.example')
    receive()
    receive({ ...draft, edit: false, seq: 2 }, parent, 'https://other.example')
    const canvas = render()
    expect(canvas.props.edit).toBe(true)
    canvas.props.onPick('draft-1')
    expect(parent.postMessage).toHaveBeenLastCalledWith(
      { type: 'crag-preview:select', sku: 'draft-1' },
      origin
    )
  })

  it('pins the accepted source for incoming drafts and outgoing messages', () => {
    receive()
    const replacement = { postMessage: vi.fn() }
    Object.defineProperty(window, 'parent', {
      value: replacement,
      configurable: true,
    })
    receive({ ...draft, seq: 2, edit: false }, replacement)
    const canvas = render()
    expect(canvas.props.edit).toBe(true)
    canvas.props.onPick('draft-1')
    expect(parent.postMessage).toHaveBeenLastCalledWith(
      { type: 'crag-preview:select', sku: 'draft-1' },
      origin
    )
    state.layouts.forEach((effect) => effect())
    expect(parent.postMessage).toHaveBeenLastCalledWith(
      { type: 'crag-preview:applied', seq: 1 },
      origin
    )
    expect(replacement.postMessage).not.toHaveBeenCalled()
  })

  it('applies successive dark and light drafts before acknowledging their sequence', () => {
    receive()
    render()
    state.layouts.forEach((effect) => effect())
    expect(classes).toEqual(new Set(['dark', 'unrelated-class']))
    receive({ ...draft, seq: 2, theme: 'light' })
    expect(classes.has('dark')).toBe(true)
    render()
    state.layouts.forEach((effect) => effect())
    expect(classes).toEqual(new Set(['light', 'unrelated-class']))
    expect(parent.postMessage).toHaveBeenLastCalledWith(
      { type: 'crag-preview:applied', seq: 2 },
      origin
    )
  })

  it('sends exact select, focus and edit envelopes and honors edit=false', () => {
    receive()
    const canvas = render()
    canvas.props.onPick('draft-1')
    expect(parent.postMessage).toHaveBeenLastCalledWith(
      { type: 'crag-preview:select', sku: 'draft-1' },
      origin
    )
    canvas.props.onFocus?.('draft-1')
    expect(parent.postMessage).toHaveBeenLastCalledWith(
      { type: 'crag-preview:focus', sku: 'draft-1', field: 'price' },
      origin
    )
    state.fields.find((field) => field.label === '页面标题')?.onSave('新标题')
    expect(parent.postMessage).toHaveBeenLastCalledWith(
      {
        type: 'crag-preview:edit',
        target: 'copy',
        key: 'title',
        value: '新标题',
      },
      origin
    )
    state.fields.find((field) => field.label === '套餐名称')?.onSave('新名称')
    expect(parent.postMessage).toHaveBeenLastCalledWith(
      {
        type: 'crag-preview:edit',
        target: 'plan',
        sku: 'draft-1',
        field: 'name',
        value: '新名称',
      },
      origin
    )
    state.fields.find((field) => field.label === '套餐说明')?.onSave('新说明')
    expect(parent.postMessage).toHaveBeenLastCalledWith(
      {
        type: 'crag-preview:edit',
        target: 'plan',
        sku: 'draft-1',
        field: 'description',
        value: '新说明',
      },
      origin
    )
    receive({ ...draft, seq: 2, edit: false })
    const readOnly = render()
    parent.postMessage.mockClear()
    readOnly.props.onEdit?.({ target: 'copy', key: 'title', value: '不允许' })
    expect(parent.postMessage).not.toHaveBeenCalled()
  })
})
