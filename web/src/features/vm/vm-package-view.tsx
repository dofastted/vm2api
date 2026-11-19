import { cn } from '@/lib/utils'
import { localProxyText } from '@/lib/vm-status'

export type PackageFacts = {
  ok: true
  id: string
  name: string
  platform: string
  kernel: string
  timezone: string
  proxy: string
  credential: string
}

export type PackageRead =
  { ok: false; error: string } | ({ ok: true } & PackageFacts)

function textOf(value: unknown, max = 80) {
  return String(value ?? '')
    .trim()
    .slice(0, max)
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

export function readPackageFacts(text: string): PackageRead | null {
  const raw = text.trim()
  if (!raw) return null
  let doc: unknown
  try {
    doc = JSON.parse(raw)
  } catch {
    return { ok: false, error: 'JSON 还不是一份完整的包' }
  }
  const root = record(doc)
  if (!root || root.type !== 'vm2api-vm-package') {
    return { ok: false, error: '这不是 vm2api 单槽包' }
  }
  const vm = record(root.vm)
  if (!vm) return { ok: false, error: '包里没有 vm' }
  const proxy = record(root.proxy)
  const credential = record(root.credential)
  const kind = textOf(proxy?.kind || proxy?.scheme).toLowerCase()
  let proxyText = '未带代理'
  if (proxy) {
    proxyText =
      kind === 'local' || proxy.host === 'local'
        ? `${localProxyText()}（本地代理）`
        : [textOf(proxy.host), proxy.port].filter(Boolean).join(':') || 'SOCKS5'
  }
  let credentialText = '无凭证'
  if (credential) {
    const platform = textOf(credential.platform).toLowerCase()
    credentialText =
      platform === 'openai'
        ? 'Codex 凭证'
        : platform === 'antigravity'
          ? 'Antigravity 官方客户端凭证'
          : platform === 'anthropic' || !platform
            ? 'Claude 凭证'
            : '未知平台凭证'
  }
  const platform = textOf(vm.platform || vm.family) || '—'
  return {
    ok: true,
    id: textOf(vm.id) || '—',
    name: textOf(vm.name) || '—',
    platform,
    kernel: textOf(vm.kernel) || '—',
    timezone: textOf(vm.timezone) || '—',
    proxy: proxyText,
    credential: credentialText,
  }
}

const FACTS = [
  ['id', '槽位'],
  ['name', '名称'],
  ['platform', '平台'],
  ['kernel', '系统'],
  ['timezone', '时区'],
  ['proxy', '出口'],
  ['credential', '凭证'],
] as const

export function PackageFacts({
  text,
  className,
}: {
  text: string
  className?: string
}) {
  const facts = readPackageFacts(text)
  if (!facts) return null
  if (!facts.ok) {
    return <p className='text-xs text-destructive'>{facts.error}</p>
  }
  return (
    <dl
      className={cn(
        'grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4',
        className
      )}
    >
      {FACTS.map(([key, label]) => (
        <div key={key} className='min-w-0'>
          <dt className='text-[11px] text-muted-foreground'>{label}</dt>
          <dd className='truncate font-mono text-xs text-foreground'>
            {facts[key]}
          </dd>
        </div>
      ))}
    </dl>
  )
}
