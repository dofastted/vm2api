import fs from 'node:fs'
import path from 'node:path'

const managed = new Set()
const snapshots = new Map()

export function manageRoutingDocument(file) {
  managed.add(path.resolve(file))
}

export function clearRoutingDocument(file) {
  snapshots.delete(path.resolve(file))
}

export function routingDocumentRevision(file) {
  const key = path.resolve(file)
  return managed.has(key) ? snapshots.get(key)?.revision || 0 : null
}

export function publishRoutingDocument(file, snapshot) {
  const key = path.resolve(file)
  if ((snapshots.get(key)?.revision || 0) > snapshot.revision) return
  snapshots.set(key, structuredClone(snapshot))
}

/** Standalone keeps file semantics; shared files are read-only bootstrap inputs. */
export function readRoutingDocument(file) {
  const key = path.resolve(file)
  if (managed.has(key)) {
    const snapshot = snapshots.get(key)
    if (!snapshot)
      throw Object.assign(new Error('shared routing configuration is not initialized'), {
        code: 'routing_config_unavailable',
      })
    return structuredClone(snapshot.config)
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}
