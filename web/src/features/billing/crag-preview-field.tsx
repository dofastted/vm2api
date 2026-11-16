import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from 'react'
import { Pencil } from 'lucide-react'

export function PreviewField({
  value,
  fallback,
  label,
  editable,
  placeholder = false,
  multiline = false,
  maxLength,
  onSave,
}: {
  value: string
  fallback: string
  label: string
  editable: boolean
  placeholder?: boolean
  multiline?: boolean
  maxLength: number
  onSave: (value: string) => void
}) {
  const [input, setInput] = useState<string | null>(null)
  const composing = useRef(false)

  useEffect(() => {
    if (editable) return
    setInput(null)
    composing.current = false
  }, [editable])

  function save() {
    if (input === null || composing.current) return
    onSave(input)
    setInput(null)
  }

  function keyDown(
    event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>
  ) {
    event.stopPropagation()
    if (
      event.nativeEvent.isComposing ||
      composing.current ||
      event.keyCode === 229
    )
      return
    if (event.key === 'Escape') {
      event.preventDefault()
      setInput(null)
    } else if (event.key === 'Enter' && !multiline) {
      event.preventDefault()
      save()
    }
  }

  if (!editable) return <>{value || fallback}</>
  if (input === null)
    return (
      <button
        type='button'
        aria-label={`编辑${label}`}
        title='点击编辑'
        className='group relative -mx-1 max-w-full cursor-text rounded-md px-1 text-start whitespace-pre-line decoration-primary/60 decoration-dashed underline-offset-4 transition-colors hover:bg-primary/5 hover:underline focus-visible:underline focus-visible:outline-2 focus-visible:outline-ring'
        onClick={() => setInput(value)}
      >
        {value ||
          (placeholder ? (
            <span className='text-muted-foreground/70 italic'>{fallback}</span>
          ) : (
            fallback
          ))}
        <Pencil
          aria-hidden
          className='pointer-events-none absolute -top-1.5 -right-2.5 size-3 text-primary/70 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100'
        />
      </button>
    )

  const props = {
    'aria-label': label,
    value: input,
    maxLength,
    autoFocus: true,
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setInput(event.target.value),
    onKeyDown: keyDown,
    onCompositionStart: () => {
      composing.current = true
    },
    onCompositionEnd: () => {
      composing.current = false
    },
    className:
      'w-full min-w-0 rounded-md border border-primary/50 bg-background px-2.5 py-1.5 text-sm font-normal text-foreground shadow-xs ring-3 ring-primary/15 outline-none',
  }
  return (
    <span
      className='inline-grid w-full min-w-0 gap-1.5'
      onClick={(event) => event.stopPropagation()}
    >
      {multiline ? <textarea {...props} rows={3} /> : <input {...props} />}
      <span className='flex items-center gap-1.5 text-xs font-normal'>
        <button
          type='button'
          className='rounded-md bg-primary px-2.5 py-1 font-medium text-primary-foreground hover:bg-primary/90'
          onClick={save}
        >
          保存
        </button>
        <button
          type='button'
          className='rounded-md border bg-background px-2.5 py-1 hover:bg-muted'
          onClick={() => setInput(null)}
        >
          取消
        </button>
      </span>
    </span>
  )
}
