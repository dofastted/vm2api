/** Ordered persistence for synchronous scheduling state. Flush surfaces any failed write. */
export class WriteQueue {
  constructor(db = null) {
    if (db) {
      db.pendingWriteQueues ||= new Set()
      db.pendingWriteQueues.add(this)
    }
    this.pending = Promise.resolve()
    this.failure = null
  }

  enqueue(write) {
    const operation = this.pending.then(() => {
      if (this.failure) throw this.failure
      return write()
    })
    this.pending = operation.catch((error) => {
      this.failure ||= error
    })
    return this.pending
  }

  async flush() {
    let pending
    do {
      pending = this.pending
      await pending
    } while (pending !== this.pending)
    if (this.failure) throw this.failure
  }
}
