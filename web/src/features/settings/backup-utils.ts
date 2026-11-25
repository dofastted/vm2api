import type { BackupDbEngine, BackupItem } from '@/types/panel-routing'

export function parseBackupFilename(
  contentDisposition: string | null | undefined,
  id: string,
  fallbackName?: string | null
): string {
  const cleanFallback = fallbackName
    ? fallbackName.replace(/[\\/]/g, '').trim()
    : ''
  const fallback = cleanFallback || `backup-${id}.tar.gz`
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

export function backupActionDisabledReason(
  item: BackupItem
): string | undefined {
  if (item.status !== 'ok') return '该备份已失败，无法下载或恢复'
  if (item.file_exists !== true) return '备份文件不存在，无法下载或恢复'
  return undefined
}

export function backupEngineOf(item: BackupItem): BackupDbEngine | null {
  if (
    item.includes?.engine === 'postgres' ||
    item.includes?.engine === 'sqlite'
  ) {
    return item.includes.engine
  }
  const name = (item.file_name || '').toLowerCase()
  if (name.endsWith('.pgdump') || name.endsWith('.pg.ndjson.gz')) {
    return 'postgres'
  }
  if (name.endsWith('.db.gz') || name.endsWith('.tar.gz')) {
    return 'sqlite'
  }
  return null
}

export function backupEngineLabel(engine: BackupDbEngine): string {
  return engine === 'postgres' ? 'PostgreSQL' : 'SQLite'
}

export function backupFormatBadge(item: BackupItem): string | null {
  const engine = backupEngineOf(item)
  if (!engine) return null
  const name = (item.file_name || '').toLowerCase()
  if (engine === 'postgres') {
    if (
      item.includes?.format === 'pg_dump_custom' ||
      name.endsWith('.pgdump')
    ) {
      return 'PostgreSQL · pg_dump'
    }
    if (
      item.includes?.format === 'pg_logical_ndjson_gz' ||
      name.endsWith('.pg.ndjson.gz')
    ) {
      return 'PostgreSQL · NDJSON'
    }
    return 'PostgreSQL'
  }
  if (name.endsWith('.db.gz')) {
    return 'SQLite · db.gz'
  }
  return 'SQLite'
}

export function backupRestoreDisabled(
  item: BackupItem,
  currentEngine?: BackupDbEngine | null
): { disabled: boolean; reason?: string } {
  if (backupActionDisabled(item)) {
    return { disabled: true, reason: backupActionDisabledReason(item) }
  }
  const itemEngine = backupEngineOf(item)
  if (currentEngine && itemEngine && itemEngine !== currentEngine) {
    return {
      disabled: true,
      reason: `备份引擎（${backupEngineLabel(itemEngine)}）与当前数据库（${backupEngineLabel(currentEngine)}）不一致，无法直接恢复`,
    }
  }
  return { disabled: false }
}
