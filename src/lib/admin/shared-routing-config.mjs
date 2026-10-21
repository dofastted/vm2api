import fs from 'node:fs'
import { getDb } from '../db/database.mjs'
import { RoutingConfigRepo } from '../db/repos/routing-config-repo.mjs'
import { manageRoutingDocument, clearRoutingDocument, publishRoutingDocument } from '../core/routing-document.mjs'

const states = new WeakMap()
export function getSharedRoutingState(db = getDb()) {
  return states.get(db) || null
}

export class SharedRoutingConfig {
  constructor({ db = getDb(), file, normalize, merge, apply }) {
    this.db = db
    this.repo = new RoutingConfigRepo(db)
    this.file = file
    this.normalize = normalize
    this.merge = merge
    this.apply = apply
    this.currentRevision = 0
    this.config = null
    this.application = null
    this.applying = Promise.resolve()
    manageRoutingDocument(file)
  }

  async init() {
    const value = await this.repo.seed(() => this.normalize(JSON.parse(fs.readFileSync(this.file, 'utf8'))))
    await this.accept(value)
    states.set(this.db, this)
    return structuredClone(this.config)
  }

  accept(snapshot) {
    const operation = this.applying.then(async () => {
      if (!snapshot || snapshot.revision <= this.currentRevision) return this.application
      const application = await this.apply(structuredClone(snapshot.config), snapshot.revision)
      this.config = structuredClone(snapshot.config)
      this.currentRevision = snapshot.revision
      this.application = application
      publishRoutingDocument(this.file, snapshot)
      return application
    })
    this.applying = operation.catch(() => {})
    return operation
  }

  async refresh() {
    const value = await this.repo.get()
    if (!value)
      throw Object.assign(new Error('shared routing configuration missing'), { code: 'routing_config_unavailable' })
    await this.accept(value)
    return { revision: this.currentRevision, config: structuredClone(this.config), application: this.application }
  }

  async patch(body, options) {
    const value = await this.repo.patch((current) => this.merge(current, body), options)
    await this.accept(value)
    return { revision: value.revision, application: this.application }
  }

  assertRevision(revision) {
    return this.repo.assertRevision(revision)
  }

  start() {
    if (this.timer) return
    this.timer = setInterval(() => {
      if (this.refreshing) return
      this.refreshing = this.refresh()
        .catch((error) => {
          this.lastError = error.code || error.message
        })
        .finally(() => {
          this.refreshing = null
        })
    }, 1000)
    this.timer.unref?.()
  }

  async stop() {
    clearInterval(this.timer)
    this.timer = null
    await this.refreshing
    await this.applying
  }

  async rebind(db) {
    await this.applying
    states.delete(this.db)
    this.db = db
    this.repo = new RoutingConfigRepo(db)
    this.currentRevision = 0
    clearRoutingDocument(this.file)
    return this.init()
  }
}
