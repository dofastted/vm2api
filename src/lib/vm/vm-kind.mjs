/**
 * One VM holds one credential kind.
 * platform/family is the source of truth; Claude inference is rust-only.
 */
import { platformDescriptor } from '../platforms/registry.mjs'

export const VM_KIND_CLAUDE = 'claude'
export const VM_KIND_CODEX = 'codex'
export const VM_KIND_ANTIGRAVITY = 'antigravity'
export const VM_KIND_UNKNOWN = 'unknown'

function labelOf(vm, key) {
  return String(vm?.[key] || '')
    .trim()
    .toLowerCase()
}

/**
 * Resolve credential kind. Explicit platform/family/kind win.
 * Unmarked VMs fall back to legacy Codex flags, otherwise Claude.
 */
export function normalizeVmKind(vm = {}) {
  const src = vm && typeof vm === 'object' ? vm : {}
  const platform = labelOf(src, 'platform')
  const family = labelOf(src, 'family')
  const kind = labelOf(src, 'kind') || labelOf(src, 'credential_kind')
  for (const label of [platform, family, kind]) {
    if (!label) continue
    const descriptor = platformDescriptor(label)
    if (descriptor) return { platform: descriptor.id, family: descriptor.family, kind: descriptor.kind }
    // An explicit platform cannot fall through to a different credential kind.
    if (label === platform) return { platform: 'unknown', family: 'unknown', kind: VM_KIND_UNKNOWN }
  }
  if (src.codex_kernel === true) return { platform: 'openai', family: 'codex', kind: VM_KIND_CODEX }
  if (labelOf(src, 'inference_engine') === 'codex') {
    return { platform: 'openai', family: 'codex', kind: VM_KIND_CODEX }
  }
  if (String(src.runtime?.codex_kernel || '').trim() === '1') {
    return { platform: 'openai', family: 'codex', kind: VM_KIND_CODEX }
  }
  return { platform: 'anthropic', family: 'claude', kind: VM_KIND_CLAUDE }
}

export function isCodexVm(vm = {}) {
  return normalizeVmKind(vm).kind === VM_KIND_CODEX
}

export function isClaudeVm(vm = {}) {
  return normalizeVmKind(vm).kind === VM_KIND_CLAUDE
}

export function isAntigravityVm(vm = {}) {
  return normalizeVmKind(vm).kind === VM_KIND_ANTIGRAVITY
}

export function stampVmKind(vm, input = vm) {
  const kind = normalizeVmKind(input)
  if (kind.kind === VM_KIND_UNKNOWN) {
    throw Object.assign(new TypeError('Unsupported VM platform'), { code: 'platform_not_supported' })
  }
  vm.platform = kind.platform
  vm.family = kind.family
  if (kind.kind === VM_KIND_CODEX) {
    vm.codex_kernel = true
    if (!vm.codex || typeof vm.codex !== 'object') vm.codex = {}
    delete vm.claude
    delete vm.antigravity
  } else if (kind.kind === VM_KIND_ANTIGRAVITY) {
    if (!vm.antigravity || typeof vm.antigravity !== 'object') vm.antigravity = {}
    delete vm.claude
    delete vm.codex
    delete vm.codex_kernel
  } else {
    if (!vm.claude || typeof vm.claude !== 'object') vm.claude = {}
    delete vm.codex
    delete vm.codex_kernel
    delete vm.antigravity
  }
  return kind
}
