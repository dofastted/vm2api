import type { BackupItem } from '@/types/panel-routing'

export function parseBackupFilename(
  contentDisposition: string | null | undefined,
  id: string
): string {
  const fallback = `backup-${id}.tar.gz`
  if (!contentDisposition) return fallback
  const star = /filename\*\s*=\s*(?:UTF-8''|utf-8'')([^;\r\n]+)/i.exec(
    contentDisposition
  )
  if (star?.[1]) {
    try {
      const decoded = decodeURIComponent(
        star[1].trim().replace(/^["']|["']$/g, '')
      )
      const clean = decoded.replace(/[\\/]/g, '').trim()
      if (clean) return clean
    } catch {
      // Fallback to plain filename= parsing below.
    }
  }
  const quoted = /filename\s*=\s*"([^"\r\n]+)"/i.exec(contentDisposition)
  const bare = !quoted
    ? /filename\s*=\s*([^;\r\n]+)/i.exec(contentDisposition)
    : null
  const raw = (quoted?.[1] ?? bare?.[1] ?? '')
    .trim()
    .replace(/^["']|["']$/g, '')
  const clean = raw.replace(/[\\/]/g, '').trim()
  return clean || fallback
}

export function backupActionDisabled(item: BackupItem): boolean {
  return item.status !== 'ok' || item.file_exists !== true
}
