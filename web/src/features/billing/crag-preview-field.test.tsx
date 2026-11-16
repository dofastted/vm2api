import type { InputHTMLAttributes, KeyboardEvent, ReactElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PreviewField } from './crag-preview-field'

const state = vi.hoisted(() => ({
  value: null as string | null,
  composing: { current: false },
  effects: [] as Array<() => void>,
}))
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useState: () => [
    state.value,
    (value: string | null) => {
      state.value = value
    },
  ],
  useRef: () => state.composing,
  useEffect: (effect: () => void) => state.effects.push(effect),
}))

type Element = ReactElement<
  {
    children?: Element[] | Element | string
    onClick?: () => void
  } & InputHTMLAttributes<HTMLInputElement>
>

const saved = vi.fn()
const props = {
  label: '套餐名称',
  value: '原名称',
  fallback: '月卡',
  editable: true,
  maxLength: 120,
  onSave: saved,
}

function render(overrides: Partial<Parameters<typeof PreviewField>[0]> = {}) {
  return PreviewField({ ...props, ...overrides }) as Element
}

function input(element: Element) {
  return (element.props.children as Element[])[0]
}

function buttons(element: Element) {
  return (element.props.children as Element[])[1].props.children as Element[]
}

function key(key: string, isComposing = false, keyCode = 0) {
  return {
    key,
    keyCode,
    nativeEvent: { isComposing },
    stopPropagation: vi.fn(),
    preventDefault: vi.fn(),
  } as unknown as KeyboardEvent<HTMLInputElement>
}

beforeEach(() => {
  state.value = null
  state.composing.current = false
  state.effects = []
  saved.mockReset()
})

describe('inline draft field', () => {
  it('offers a keyboard-accessible edit button with hover and focus hints', () => {
    const field = render()
    expect(field.type).toBe('button')
    expect(field.props['aria-label']).toBe('编辑套餐名称')
    expect(field.props.className).toContain('cursor-text')
    expect(field.props.className).toContain('decoration-dashed')
    expect(field.props.className).toContain('hover:underline')
    expect(field.props.className).toContain('focus-visible:underline')
    field.props.onClick?.()
    expect(input(render()).props.autoFocus).toBe(true)
  })

  it('keeps controlled Chinese input across parent refreshes without changing its element identity', () => {
    render().props.onClick?.()
    const initial = input(render())
    expect(initial.type).toBe('input')
    expect(initial.props.value).toBe('原名称')
    initial.props.onChange?.({ target: { value: '中文草稿' } } as Parameters<
      NonNullable<typeof initial.props.onChange>
    >[0])
    const refreshed = input(render({ value: '父端刷新值' }))
    expect(refreshed.type).toBe(initial.type)
    expect(refreshed.key).toBe(initial.key)
    expect(refreshed.props.value).toBe('中文草稿')
    refreshed.props.onKeyDown?.(key('Enter'))
    expect(saved).toHaveBeenCalledExactlyOnceWith('中文草稿')
    expect(state.value).toBeNull()
  })

  it('does not save or cancel during IME composition, including legacy keyCode 229', () => {
    render().props.onClick?.()
    state.value = '中文'
    const control = input(render())
    control.props.onCompositionStart?.(
      {} as Parameters<NonNullable<typeof control.props.onCompositionStart>>[0]
    )
    control.props.onKeyDown?.(key('Enter'))
    control.props.onKeyDown?.(key('Escape'))
    buttons(render())[0].props.onClick?.()
    expect(saved).not.toHaveBeenCalled()
    expect(state.value).toBe('中文')
    control.props.onCompositionEnd?.(
      {} as Parameters<NonNullable<typeof control.props.onCompositionEnd>>[0]
    )
    control.props.onKeyDown?.(key('Enter', true))
    control.props.onKeyDown?.(key('Enter', false, 229))
    expect(saved).not.toHaveBeenCalled()
    input(render()).props.onKeyDown?.(key('Enter'))
    expect(saved).toHaveBeenCalledExactlyOnceWith('中文')
  })

  it('cancels by Escape or cancel button without sending edits', () => {
    render().props.onClick?.()
    input(render()).props.onKeyDown?.(key('Escape'))
    expect(state.value).toBeNull()
    render().props.onClick?.()
    buttons(render())[1].props.onClick?.()
    expect(state.value).toBeNull()
    expect(saved).not.toHaveBeenCalled()
  })

  it('requires explicit save for multiline text and allows clearing fields', () => {
    render().props.onClick?.()
    state.value = '第一行\n第二行'
    const editing = render({ multiline: true, maxLength: 500 })
    expect(input(editing).type).toBe('textarea')
    expect(input(editing).props.maxLength).toBe(500)
    input(editing).props.onKeyDown?.(key('Enter'))
    expect(saved).not.toHaveBeenCalled()
    buttons(editing)[0].props.onClick?.()
    expect(saved).toHaveBeenLastCalledWith('第一行\n第二行')
    render().props.onClick?.()
    state.value = ''
    buttons(render())[0].props.onClick?.()
    expect(saved).toHaveBeenLastCalledWith('')
  })

  it('drops unsaved input when the parent disables editing', () => {
    render().props.onClick?.()
    state.value = '未保存'
    const readOnly = render({ editable: false })
    expect(readOnly.props.children).toBe('原名称')
    state.effects.forEach((effect) => effect())
    expect(state.value).toBeNull()
    expect(saved).not.toHaveBeenCalled()
  })
})
