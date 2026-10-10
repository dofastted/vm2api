import type { NodePreflight, PreflightCheck } from '@/types/panel-cluster'
import type { VmRoutingConfig } from '@/types/panel-routing'
import type { KvmProbe, RuntimeType, Vm } from '@/types/panel-vm'

export const VM_MEMORY_OPTIONS = [
  '256m',
  '512m',
  '1g',
  '2g',
  '4g',
  '8g',
  '16g',
] as const

export type VmMemoryOption = (typeof VM_MEMORY_OPTIONS)[number]

export const VM_MEMORY_LABELS: Record<VmMemoryOption, string> = {
  '256m': '256 MB',
  '512m': '512 MB',
  '1g': '1 GB',
  '2g': '2 GB',
  '4g': '4 GB',
  '8g': '8 GB',
  '16g': '16 GB',
}

export const VM_CPU_MODELS = [
  'host',
  'qemu64',
  'Skylake-Client-v4',
  'Cascadelake-Server-v5',
  'EPYC-v4',
  'Haswell-noTSX-IBRS',
] as const

export type VmCpuModel = (typeof VM_CPU_MODELS)[number]

export const VM_CPU_MODEL_LABELS: Record<VmCpuModel, string> = {
  host: 'host（宿主）',
  qemu64: 'qemu64（通用）',
  'Skylake-Client-v4': 'Skylake-Client-v4',
  'Cascadelake-Server-v5': 'Cascadelake-Server-v5',
  'EPYC-v4': 'EPYC-v4',
  'Haswell-noTSX-IBRS': 'Haswell-noTSX-IBRS',
}

export const VM_VCPU_MIN = 1
export const VM_VCPU_MAX = 16
export const VM_DISK_GB_MIN = 10
export const VM_DISK_GB_MAX = 200
export const VM_VCPU_OPTIONS = Array.from(
  { length: VM_VCPU_MAX - VM_VCPU_MIN + 1 },
  (_, i) => VM_VCPU_MIN + i
)

export const MAC_OUI_RE = /^[0-9a-fA-F]{2}(:[0-9a-fA-F]{2}){2}$/

export const TCG_WARNING = '当前为 TCG 软件模拟，速度很慢，仅供测试。'

export const VM_CONFIG_DEFAULTS: VmRoutingConfig = {
  default_runtime: 'docker',
  memory: '512m',
  vcpus: 2,
  disk_gb: 20,
  cpu_model: 'host',
  smbios: {
    manufacturer: 'Dell Inc.',
    product: 'OptiPlex 7090',
    version: '1.0',
    family: 'OptiPlex',
  },
  mac_oui: '52:54:00',
  allow_tcg: false,
}

export function isRuntimeType(value: unknown): value is RuntimeType {
  return value === 'docker' || value === 'kvm'
}

export function isMemoryOption(value: unknown): value is VmMemoryOption {
  return (
    typeof value === 'string' &&
    (VM_MEMORY_OPTIONS as readonly string[]).includes(value)
  )
}

export function isCpuModel(value: unknown): value is VmCpuModel {
  return (
    typeof value === 'string' &&
    (VM_CPU_MODELS as readonly string[]).includes(value)
  )
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function intInRange(
  value: unknown,
  min: number,
  max: number,
  fallback: number
): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(n) || n < min || n > max) return fallback
  return n
}

function textOf(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

/** 缺省填默认，非法值回默认。对齐后端 `normalizeVmConfig`。 */
export function normalizeVmConfig(raw: unknown): VmRoutingConfig {
  const src = asRecord(raw) || {}
  const smbios = asRecord(src.smbios) || {}
  return {
    default_runtime: isRuntimeType(src.default_runtime)
      ? src.default_runtime
      : VM_CONFIG_DEFAULTS.default_runtime,
    memory: isMemoryOption(src.memory) ? src.memory : VM_CONFIG_DEFAULTS.memory,
    vcpus: intInRange(
      src.vcpus,
      VM_VCPU_MIN,
      VM_VCPU_MAX,
      VM_CONFIG_DEFAULTS.vcpus
    ),
    disk_gb: intInRange(
      src.disk_gb,
      VM_DISK_GB_MIN,
      VM_DISK_GB_MAX,
      VM_CONFIG_DEFAULTS.disk_gb
    ),
    cpu_model: isCpuModel(src.cpu_model)
      ? src.cpu_model
      : VM_CONFIG_DEFAULTS.cpu_model,
    smbios: {
      manufacturer: textOf(
        smbios.manufacturer,
        VM_CONFIG_DEFAULTS.smbios.manufacturer
      ),
      product: textOf(smbios.product, VM_CONFIG_DEFAULTS.smbios.product),
      version: textOf(smbios.version, VM_CONFIG_DEFAULTS.smbios.version),
      family: textOf(smbios.family, VM_CONFIG_DEFAULTS.smbios.family),
    },
    mac_oui: textOf(src.mac_oui, VM_CONFIG_DEFAULTS.mac_oui),
    allow_tcg: src.allow_tcg === true,
  }
}

export type VmConfigField =
  'default_runtime' | 'memory' | 'vcpus' | 'disk_gb' | 'cpu_model' | 'mac_oui'

export type VmConfigFieldErrors = Partial<Record<VmConfigField, string>>

/** 轻量校验，对齐后端 `validateVmConfigPatch`：非法即应被拒绝。 */
export function vmConfigFieldErrors(raw: unknown): VmConfigFieldErrors {
  const src = asRecord(raw) || {}
  const errors: VmConfigFieldErrors = {}
  if (src.default_runtime != null && !isRuntimeType(src.default_runtime)) {
    errors.default_runtime = '默认形态须为容器或虚拟机'
  }
  if (src.memory != null && !isMemoryOption(src.memory)) {
    errors.memory = `内存须为 ${VM_MEMORY_OPTIONS.join(' / ')}`
  }
  if (src.vcpus != null) {
    const n = typeof src.vcpus === 'number' ? src.vcpus : Number(src.vcpus)
    if (!Number.isInteger(n) || n < VM_VCPU_MIN || n > VM_VCPU_MAX) {
      errors.vcpus = `vCPU须为 ${VM_VCPU_MIN}–${VM_VCPU_MAX} 的整数`
    }
  }
  if (src.disk_gb != null) {
    const n =
      typeof src.disk_gb === 'number' ? src.disk_gb : Number(src.disk_gb)
    if (!Number.isInteger(n) || n < VM_DISK_GB_MIN || n > VM_DISK_GB_MAX) {
      errors.disk_gb = `磁盘须为 ${VM_DISK_GB_MIN}–${VM_DISK_GB_MAX} 的整数`
    }
  }
  if (src.cpu_model != null && !isCpuModel(src.cpu_model)) {
    errors.cpu_model = 'CPU 型号不在允许列表'
  }
  if (src.mac_oui != null) {
    const oui = String(src.mac_oui).trim()
    if (!MAC_OUI_RE.test(oui)) {
      errors.mac_oui = 'MAC 前缀须为 xx:xx:xx（三位十六进制）'
    }
  }
  return errors
}

export function validateVmConfigPatch(
  patch: unknown
): { ok: true } | { ok: false; error: string; field?: VmConfigField } {
  const errors = vmConfigFieldErrors(patch)
  const field = (Object.keys(errors) as VmConfigField[])[0]
  if (!field) return { ok: true }
  return { ok: false, error: errors[field] || '配置不合法', field }
}

export type CreateMachinePayload = {
  runtime_type: RuntimeType
  machine: { memory: string; vcpus?: number; disk_gb?: number }
}

/** 创建槽位提交体：内存始终发送；vCPU / 磁盘只在 KVM 时发送。 */
export function createMachinePayload(input: {
  runtimeType: RuntimeType
  memory: string
  vcpus: number
  diskGb: number
}): CreateMachinePayload {
  const memory = isMemoryOption(input.memory)
    ? input.memory
    : VM_CONFIG_DEFAULTS.memory
  const machine: CreateMachinePayload['machine'] = { memory }
  if (input.runtimeType === 'kvm') {
    machine.vcpus = intInRange(
      input.vcpus,
      VM_VCPU_MIN,
      VM_VCPU_MAX,
      VM_CONFIG_DEFAULTS.vcpus
    )
    machine.disk_gb = intInRange(
      input.diskGb,
      VM_DISK_GB_MIN,
      VM_DISK_GB_MAX,
      VM_CONFIG_DEFAULTS.disk_gb
    )
  }
  return { runtime_type: input.runtimeType, machine }
}

export function runtimeTypeOf(
  vm: Pick<Vm, 'runtime_type'> | null | undefined
): RuntimeType {
  return vm?.runtime_type === 'kvm' ? 'kvm' : 'docker'
}

export function runtimeTypeLabel(type: RuntimeType): '容器' | 'KVM' {
  return type === 'kvm' ? 'KVM' : '容器'
}

export type KvmAvailability =
  | { status: 'loading' }
  | { status: 'ok'; accel: 'kvm' | 'tcg' | null }
  | { status: 'disabled'; reason: string }
  | { status: 'unknown'; reason: string }

export function kvmAvailabilityFromLocal(input: {
  fetching: boolean
  error: unknown
  kvm?: KvmProbe
}): KvmAvailability {
  if (input.error) {
    const msg =
      input.error instanceof Error ? input.error.message : '无法探测宿主 KVM'
    return { status: 'unknown', reason: msg || '无法探测宿主 KVM' }
  }
  if (input.fetching && input.kvm == null) return { status: 'loading' }
  if (!input.kvm) {
    return { status: 'unknown', reason: '宿主未返回 KVM 探测结果' }
  }
  if (input.kvm.ok) return { status: 'ok', accel: input.kvm.accel }
  return {
    status: 'disabled',
    reason: input.kvm.error || '宿主无 /dev/kvm',
  }
}

export function kvmAvailabilityFromPreflight(input: {
  fetching: boolean
  error: unknown
  data?: NodePreflight
}): KvmAvailability {
  if (input.fetching && !input.data) return { status: 'loading' }
  if (input.error) {
    const msg =
      input.error instanceof Error ? input.error.message : '节点预检失败'
    return { status: 'unknown', reason: msg || '节点预检失败' }
  }
  const check = input.data?.checks.find((c) => c.id === 'kvm')
  return kvmAvailabilityFromCheck(check)
}

/** 节点 docker 预检可能没有 kvm 项：选项保持可选，真正选 KVM 后再跑带 runtime_type 的预检。 */
export function kvmAvailabilityFromCheck(
  check: PreflightCheck | undefined
): KvmAvailability {
  if (!check) return { status: 'ok', accel: null }
  if (check.ok) return { status: 'ok', accel: 'kvm' }
  if (check.level === 'warn') return { status: 'ok', accel: 'tcg' }
  return { status: 'disabled', reason: check.message || '宿主无 /dev/kvm' }
}
