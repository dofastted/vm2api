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

/**
 * 「自定义」的哨兵值，与 `VM_REGION_AUTO` 同理：Radix `Select` 不接受空串选项。
 * 选中它时由调用方渲染输入框，提交的是输入框里的 IANA 名称。
 * 不能写成某个真实时区，否则自定义输入被清空时会静默提交这个时区。
 */
export const VM_TIMEZONE_CUSTOM = '__custom__'

/**
 * 环境时区预设。后端只校验 IANA 可解析（`validTimezone()`），不限美国区，
 * 所以这里是覆盖常见出口地区的快捷入口，真正的兜底是「自定义」。
 */
export const VM_TIMEZONES: [string, string][] = [
  ['America/Los_Angeles', '洛杉矶 PT'],
  ['America/Denver', '丹佛 MT'],
  ['America/Chicago', '芝加哥 CT'],
  ['America/New_York', '纽约 ET'],
  ['America/Sao_Paulo', '圣保罗 BRT'],
  ['Europe/London', '伦敦 GMT/BST'],
  ['Europe/Paris', '巴黎 CET'],
  ['Europe/Berlin', '柏林 CET'],
  ['Europe/Moscow', '莫斯科 MSK'],
  ['Asia/Dubai', '迪拜 GST'],
  ['Asia/Kolkata', '加尔各答 IST'],
  ['Asia/Bangkok', '曼谷 ICT'],
  ['Asia/Shanghai', '上海 CST'],
  ['Asia/Hong_Kong', '香港 HKT'],
  ['Asia/Taipei', '台北 CST'],
  ['Asia/Singapore', '新加坡 SGT'],
  ['Asia/Seoul', '首尔 KST'],
  ['Asia/Tokyo', '东京 JST'],
  ['Australia/Sydney', '悉尼 AEST'],
  ['UTC', 'UTC'],
  [VM_TIMEZONE_CUSTOM, '自定义…'],
]

/** 预设里是否已有这个时区（决定下拉该选预设项还是「自定义」）。 */
export function isPresetTimezone(value: string): boolean {
  return VM_TIMEZONES.some(([id]) => id === value && id !== VM_TIMEZONE_CUSTOM)
}

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
