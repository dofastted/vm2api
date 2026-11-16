export const RELEASE_CHECK_INTERVAL_MS = 3 * 60 * 60 * 1000
export const LS_DISMISSED_RELEASE = 'vm2api:dismissed-release'

export interface LatestRelease {
  version: string
  url: string
}

/** 取主版本号段比较；预发布/构建后缀不参与，避免把 1.4.9-rc 误判为新版。 */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) =>
    v
      .replace(/^v/i, '')
      .split(/[-+]/)[0]
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0)
  const pa = parts(a)
  const pb = parts(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

export function hasNewerRelease(
  current: string | undefined,
  latest: LatestRelease | undefined,
  dismissed: string | null
): boolean {
  if (!current || !latest?.version) return false
  if (dismissed && compareVersions(dismissed, latest.version) >= 0) return false
  return compareVersions(latest.version, current) > 0
}

export async function fetchLatestRelease(
  repoUrl: string
): Promise<LatestRelease> {
  const repo = repoUrl.replace(/^https:\/\/github\.com\//, '')
  const res = await fetch(
    `https://api.github.com/repos/${repo}/releases/latest`,
    { headers: { Accept: 'application/vnd.github+json' } }
  )
  if (!res.ok) throw new Error(`GitHub releases ${res.status}`)
  const body = (await res.json()) as { tag_name?: string; html_url?: string }
  return {
    version: String(body.tag_name || '').replace(/^v/i, ''),
    url: String(body.html_url || `${repoUrl}/releases/latest`),
  }
}

export function readDismissedRelease(): string | null {
  try {
    return localStorage.getItem(LS_DISMISSED_RELEASE)
  } catch {
    return null
  }
}

export function writeDismissedRelease(version: string): void {
  try {
    localStorage.setItem(LS_DISMISSED_RELEASE, version)
  } catch {
    /* localStorage 不可用时只在本次会话内隐藏 */
  }
}
