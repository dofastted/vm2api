export const KERNELS = [
  {
    id: 'ubuntu-24.04',
    name: 'Ubuntu 24.04',
    base: 'kin-os/ubuntu:24.04',
    size: '标准机',
    feats: ['LTS', 'apt', 'kernel/cli-hop', 'host-net'],
  },
  {
    id: 'debian-12',
    name: 'Debian 12',
    base: 'kin-os/debian:12',
    size: '标准机',
    feats: ['glibc', 'apt', 'kernel/cli-hop', 'host-net'],
  },
  {
    id: 'archlinux',
    name: 'Arch Linux',
    base: 'kin-os/arch:latest',
    size: '标准机',
    feats: ['rolling', 'pacman', 'kernel/cli-hop', 'host-net'],
  },
  {
    id: 'fedora-41',
    name: 'Fedora 41',
    base: 'kin-os/fedora:41',
    size: '标准机',
    feats: ['dnf', 'glibc', 'kernel/cli-hop', 'host-net'],
  },
]

export type KernelProfile = {
  id: string
  name: string
  base: string
  size: string
  feats: string[]
}

export function kernelProfile(id?: string | null): KernelProfile | null {
  const k = String(id || '').trim()
  const known = KERNELS.find((x) => x.id === k)
  if (known) return known
  if (!k) return null
  return { id: k, name: k, base: '', size: '', feats: ['自定义内核'] }
}

/** 创建槽位的模板预设，与 index.html `VM_TEMPLATES` 一致。 */
export const VM_TEMPLATES = [
  {
    id: 'std-ubuntu',
    name: '标准 Ubuntu',
    kernel: 'ubuntu-24.04',
    after: 'start',
    region: 'us-west',
    tz: 'America/Los_Angeles',
    locale: 'en_US.UTF-8',
    conc: 2,
    weight: 1,
  },
  {
    id: 'std-debian',
    name: '标准 Debian',
    kernel: 'debian-12',
    after: 'start',
    region: 'us-east',
    tz: 'America/New_York',
    locale: 'en_US.UTF-8',
    conc: 2,
    weight: 1,
  },
  {
    id: 'std-arch',
    name: '标准 Arch',
    kernel: 'archlinux',
    after: 'start',
    region: 'us-central',
    tz: 'America/Chicago',
    locale: 'en_US.UTF-8',
    conc: 2,
    weight: 1,
  },
  {
    id: 'std-fedora',
    name: '标准 Fedora',
    kernel: 'fedora-41',
    after: 'start',
    region: 'us-west',
    tz: 'America/Denver',
    locale: 'en_US.UTF-8',
    conc: 2,
    weight: 1,
  },
] as const

/**
 * 「自动选区」的哨兵值。不能直接用空串：Radix `Select` 把 `value === ''` 当作
 * 「未选中」并渲染 placeholder，空串选项永远无法在 trigger 上显示出文案。
 * 提交时由调用方映射回 `undefined`。
 */
export const VM_REGION_AUTO = 'auto'

/**
 * 创建槽位「高级」区的区域选项。
 * `us-central` 是 `VM_TEMPLATES.std-arch` 的预设值，index.html 的下拉里漏了它
 * （原生 select 会静默退回首项显示「自动」却仍提交 us-central），这里补齐，
 * 否则选中 Arch 模板后区域框会显示空白。
 */
export const VM_REGIONS: [string, string][] = [
  [VM_REGION_AUTO, '自动'],
  ['us-west', '美西'],
  ['us-central', '美中'],
  ['us-east', '美东'],
  ['eu-west', '欧洲'],
  ['ap-east', '亚太东'],
  ['ap-southeast', '亚太东南'],
]

export const VM_TIMEZONES: [string, string][] = [
  ['America/Los_Angeles', '洛杉矶 PT'],
  ['America/Denver', '丹佛 MT'],
  ['America/Chicago', '芝加哥 CT'],
  ['America/New_York', '纽约 ET'],
  ['Asia/Tokyo', '东京 JST (UTC+9)'],
]

export const VM_LOCALES: [string, string][] = [
  ['en_US.UTF-8', 'English'],
  ['zh_CN.UTF-8', '中文'],
  ['ja_JP.UTF-8', '日本語'],
  ['C.UTF-8', 'C'],
]

export const VM_CONCURRENCY_OPTIONS = [1, 2, 4, 8, 16, 20, 32]
export const VM_WEIGHT_OPTIONS = [1, 2, 3, 5]

/** 创建槽位「之后」的 5 档，决定 start / auto_allocate_proxy / activate 三个布尔。 */
export const VM_CREATE_AFTER: [string, string][] = [
  ['idle', '仅创建'],
  ['start', '开机'],
  ['proxy', '开机 + 分配出口'],
  ['active', '开机 + 活跃'],
  ['full', '开机 + 分配出口 + 活跃'],
]
