import { useEffect, useState } from 'react'
import type { Vm } from '@/types/panel-vm'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

/** Matches `VM_DISPLAY_NAME_MAX` in vm-registry. */
export const VM_DISPLAY_NAME_MAX = 80

type VmNameFieldProps = {
  vm: Vm
  canEdit: boolean
  saving: boolean
  onSave: (name: string) => void
}

/** Creation number stays fixed. Only the panel label is editable. */
export function VmNameField({ vm, canEdit, saving, onSave }: VmNameFieldProps) {
  const current = String(vm.name || '')
  const [draft, setDraft] = useState(current)
  useEffect(() => setDraft(current), [current])
  const next = draft.trim()
  const dirty = next !== current
  const tooLong = [...next].length > VM_DISPLAY_NAME_MAX

  if (!canEdit) {
    return (
      <div className='mb-4 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm'>
        <span>
          名称 <span className='font-medium'>{current || '—'}</span>
        </span>
        <span className='text-muted-foreground'>
          编号 <span className='font-mono text-xs'>{vm.id}</span>
        </span>
      </div>
    )
  }

  return (
    <form
      className='mb-4 flex flex-wrap items-end gap-2'
      onSubmit={(event) => {
        event.preventDefault()
        if (saving || !dirty || !next || tooLong) return
        onSave(next)
      }}
    >
      <div className='space-y-1'>
        <Label
          htmlFor='vm-display-name'
          className='text-xs text-muted-foreground'
        >
          自定义名称
        </Label>
        <Input
          id='vm-display-name'
          value={draft}
          maxLength={VM_DISPLAY_NAME_MAX}
          disabled={saving}
          spellCheck={false}
          className='h-8 w-56'
          aria-label='自定义名称'
          onChange={(event) => setDraft(event.target.value)}
        />
      </div>
      <div className='space-y-1'>
        <div className='text-xs text-muted-foreground'>编号</div>
        <div className='flex h-8 items-center font-mono text-xs'>{vm.id}</div>
      </div>
      <Button
        size='sm'
        type='submit'
        disabled={saving || !dirty || !next || tooLong}
        loading={saving}
      >
        保存名称
      </Button>
      <p className='pb-1 text-xs text-muted-foreground'>
        编号在创建时生成，不能改。名称只用于面板显示。
      </p>
      {tooLong ? (
        <p className='w-full text-xs text-[color:var(--status-bad)]'>
          最长 {VM_DISPLAY_NAME_MAX} 个字符
        </p>
      ) : null}
    </form>
  )
}
