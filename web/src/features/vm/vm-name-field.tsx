import { useEffect, useState } from 'react'
import type { Vm } from '@/types/panel-vm'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

/** Matches `VM_DISPLAY_NAME_MAX` in vm-registry. */
export const VM_DISPLAY_NAME_MAX = 80

const VM_ID_MAX = 64
const RESERVED_VM_IDS: Record<string, true> = {
  active: true,
  create: true,
  'create-options': true,
  import: true,
  package: true,
}

type VmNameFieldProps = {
  vm: Vm
  canEdit: boolean
  saving: boolean
  savingId?: boolean
  onSave: (name: string) => void
  onSaveId?: (id: string) => void
}

export function vmIdError(value: string, current: string): string {
  if (value === current) return ''
  if (
    !value ||
    value.length > VM_ID_MAX ||
    !/^[A-Za-z0-9_-]+$/.test(value) ||
    RESERVED_VM_IDS[value.toLowerCase()] ||
    value.toLowerCase().endsWith('-chat')
  ) {
    return '编号只能用字母、数字、下划线和连字符，且不能用保留名'
  }
  return ''
}

/** Panel label and the slot id. The id can change only while the slot is stopped. */
export function VmNameField({
  vm,
  canEdit,
  saving,
  savingId = false,
  onSave,
  onSaveId,
}: VmNameFieldProps) {
  const current = String(vm.name || '')
  const currentId = String(vm.id || '')
  const [draft, setDraft] = useState(current)
  const [idDraft, setIdDraft] = useState(currentId)
  useEffect(() => setDraft(current), [current])
  useEffect(() => setIdDraft(currentId), [currentId])
  const next = draft.trim()
  const nextId = idDraft.trim()
  const dirty = next !== current
  const idDirty = nextId !== currentId
  const tooLong = [...next].length > VM_DISPLAY_NAME_MAX
  const idProblem = vmIdError(nextId, currentId)
  const busy = saving || savingId

  if (!canEdit) {
    return (
      <div className='mb-4 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm'>
        <span>
          名称 <span className='font-medium'>{current || '—'}</span>
        </span>
        <span className='text-muted-foreground'>
          编号 <span className='font-mono text-xs'>{currentId}</span>
        </span>
      </div>
    )
  }

  return (
    <div className='mb-4 space-y-2'>
      <div className='flex flex-wrap items-end gap-2'>
        <form
          className='flex flex-wrap items-end gap-2'
          onSubmit={(event) => {
            event.preventDefault()
            if (busy || !dirty || !next || tooLong) return
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
              disabled={busy}
              spellCheck={false}
              className='h-8 w-56'
              aria-label='自定义名称'
              onChange={(event) => setDraft(event.target.value)}
            />
          </div>
          <Button
            size='sm'
            type='submit'
            className='cursor-pointer'
            disabled={busy || !dirty || !next || tooLong}
            loading={saving}
          >
            保存名称
          </Button>
        </form>
        <form
          className='flex flex-wrap items-end gap-2'
          onSubmit={(event) => {
            event.preventDefault()
            if (busy || !idDirty || idProblem || !onSaveId) return
            onSaveId(nextId)
          }}
        >
          <div className='space-y-1'>
            <Label htmlFor='vm-id' className='text-xs text-muted-foreground'>
              编号
            </Label>
            <Input
              id='vm-id'
              value={idDraft}
              maxLength={VM_ID_MAX}
              disabled={busy || !onSaveId}
              spellCheck={false}
              className='h-8 w-40 font-mono text-xs'
              aria-label='编号'
              onChange={(event) => setIdDraft(event.target.value)}
            />
          </div>
          <Button
            size='sm'
            type='submit'
            className='cursor-pointer'
            disabled={busy || !idDirty || !!idProblem || !onSaveId}
            loading={savingId}
          >
            保存编号
          </Button>
        </form>
      </div>
      <p className='text-xs text-muted-foreground'>
        编号在关机后可改。运行中和远程节点不能改。在线设备授权绑定编号，改号后要重新激活。名称只用于面板显示。
      </p>
      {tooLong ? (
        <p className='text-xs text-[color:var(--status-bad)]'>
          名称最长 {VM_DISPLAY_NAME_MAX} 个字符
        </p>
      ) : null}
      {idProblem && idDirty ? (
        <p className='text-xs text-[color:var(--status-bad)]'>{idProblem}</p>
      ) : null}
    </div>
  )
}
