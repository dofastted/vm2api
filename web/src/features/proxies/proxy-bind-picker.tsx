import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

export type ProxyBindOption = {
  value: string
  label: string
  hint?: string
  disabled?: boolean
}

type ProxyBindPickerProps = {
  options: ProxyBindOption[]
  value: string
  onValueChange: (value: string) => void
  onConfirm: () => void
  confirmLabel?: string
  confirmDisabled?: boolean
  busy?: boolean
  placeholder?: string
  emptyText: string
  triggerClassName?: string
}

/**
 * 代理 ↔ VM 绑定选择器。代理池表格「选 VM 绑代理」和 VM 详情页「选代理绑 VM」
 * 两处方向相反但交互形状一致（Select + 确认按钮 + 空态），故共用一个组件。
 */
export function ProxyBindPicker(props: ProxyBindPickerProps) {
  const {
    options,
    value,
    onValueChange,
    onConfirm,
    confirmLabel = '绑定',
    confirmDisabled,
    busy,
    placeholder = '选择',
    emptyText,
    triggerClassName,
  } = props

  if (!options.length) {
    return <span className='text-muted-foreground'>{emptyText}</span>
  }

  return (
    <span className='inline-flex items-center gap-1'>
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger
          className={triggerClassName || 'h-7 w-[128px]'}
          aria-label={confirmLabel}
        >
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value} disabled={o.disabled}>
              {o.label}
              {o.hint ? ` · ${o.hint}` : ''}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        size='sm'
        variant='outline'
        className='h-7 px-2'
        disabled={busy || !value || confirmDisabled}
        onClick={onConfirm}
      >
        {confirmLabel}
      </Button>
    </span>
  )
}
