import {
  SESSION_IDLE_TTL_SECONDS_DEFAULT,
  SESSION_IDLE_TTL_SECONDS_MAX,
  SESSION_IDLE_TTL_SECONDS_MIN,
} from '@/types/panel-routing'
import type { Vm } from '@/types/panel-vm'
import { patchVm, type VmPatch } from '@/lib/api'
import { isCodexVm } from '@/lib/vm-kind'

export type ProtocolSlot = {
  id: string
  persona_preset?: string | null
  inference_engine?: string | null
  platform?: string | null
  family?: string | null
  kind?: string | null
  codex_kernel?: boolean
}

/** `routing.compatibility.cch_enabled`：缺省开，只有显式 false 才关。 */
export function cchEnabledFromCompat(
  compat: Record<string, unknown> | undefined
): boolean {
  return compat?.cch_enabled !== false
}
/** `routing.compatibility.cc_entrypoint`：只有显式 sdk-cli 离开 cli 缺省。 */
export function ccEntrypointFromCompat(
  compat: Record<string, unknown> | undefined
): 'sdk-cli' | 'cli' {
  return compat?.cc_entrypoint === 'sdk-cli' ? 'sdk-cli' : 'cli'
}

/** `routing.compatibility.thinking_display`：缺省 summarized，显式 passthrough 才关。 */
export function thinkingDisplayFromCompat(
  compat: Record<string, unknown> | undefined
): 'summarized' | 'passthrough' {
  return compat?.thinking_display === 'passthrough'
    ? 'passthrough'
    : 'summarized'
}

/**
 * `routing.compatibility.crag_drop_foreign_thinking`：三态，缺省 off。
 * 与后端 `cragForeignThinkingMode`（src/lib/pool/thinking-owner.mjs）同口径：
 * `true` → all（含无签名记录的块一并丢），`'foreign_only'` → 只丢记在别账号的，
 * 其余（含 false、缺省）→ off。
 */
export function cragDropForeignThinkingFromCompat(
  compat: Record<string, unknown> | undefined
): 'off' | 'foreign_only' | 'all' {
  const value = compat?.crag_drop_foreign_thinking
  if (value === true) return 'all'
  if (value === 'foreign_only') return 'foreign_only'
  return 'off'
}

/** 面板三档值 → 配置写入值（off 写 false，保持既有配置语义）。 */
export function cragDropForeignThinkingToCompat(
  mode: 'off' | 'foreign_only' | 'all'
): boolean | string {
  if (mode === 'all') return true
  if (mode === 'foreign_only') return 'foreign_only'
  return false
}

/** `routing.inference.session_idle_ttl_seconds`：kernel 原生 sticky 槽空闲，默认 600。 */
export function sessionIdleTtlFromInference(
  inference: Record<string, unknown> | undefined
): number {
  const n = Number(inference?.session_idle_ttl_seconds)
  if (
    !Number.isInteger(n) ||
    n < SESSION_IDLE_TTL_SECONDS_MIN ||
    n > SESSION_IDLE_TTL_SECONDS_MAX
  ) {
    return SESSION_IDLE_TTL_SECONDS_DEFAULT
  }
  return n
}

/** 槽位显式 persona 会盖掉 system提示词。空 PATCH 表示跟随全局。
 * 不在每次协议保存时清 inference_engine：那会触发 rust 重建，wrap 未同步就 config_missing。
 */
export function protocolInheritPatch(vm: ProtocolSlot): VmPatch | null {
  if (isCodexVm(vm as Vm)) return null
  if (!String(vm.persona_preset ?? '').trim()) return null
  return { persona_preset: '' }
}

export async function inheritProtocolOnSlots(
  vms: ProtocolSlot[],
  apply: (id: string, body: VmPatch) => Promise<unknown> = patchVm
): Promise<{ changed: number; errors: { id: string; message: string }[] }> {
  let changed = 0
  const errors: { id: string; message: string }[] = []
  for (const vm of vms) {
    const patch = protocolInheritPatch(vm)
    if (!patch) continue
    try {
      await apply(vm.id, patch)
      changed += 1
    } catch (error) {
      errors.push({
        id: vm.id,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return { changed, errors }
}
