export async function withTimeout(operation, timeoutMs, code = 'shutdown_timeout') {
  let timer
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error(code), { code })), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export class ControlPlaneLifecycle {
  constructor({
    probe = async () => {},
    lockHealthy = () => true,
    isMaintaining = () => false,
    probeTimeoutMs = 1500,
  } = {}) {
    this.probe = probe
    this.lockHealthy = lockHealthy
    this.isMaintaining = isMaintaining
    this.probeTimeoutMs = probeTimeoutMs
    this.initialized = false
    this.draining = false
    this.requests = new Set()
    this.waiters = new Set()
    this.probing = null
  }

  markReady() {
    this.initialized = true
  }

  beginDrain() {
    this.draining = true
  }

  async isReady() {
    const allowed = () => this.initialized && !this.draining && this.lockHealthy() && !this.isMaintaining()
    if (!allowed()) return false
    try {
      this.probing ||= Promise.resolve()
        .then(() => this.probe())
        .finally(() => {
          this.probing = null
        })
      await withTimeout(this.probing, this.probeTimeoutMs, 'readiness_timeout')
      return allowed()
    } catch {
      return false
    }
  }

  trackHttp(req, res) {
    const entry = { req, res, handlerDone: false, responseDone: false }
    this.requests.add(entry)
    const settle = () => {
      if (!entry.handlerDone || !entry.responseDone) return
      this.requests.delete(entry)
      res.off('finish', finished)
      res.off('close', finished)
      if (!this.requests.size) for (const resolve of this.waiters) resolve()
    }
    const finished = () => {
      entry.responseDone = true
      settle()
    }
    res.once('finish', finished)
    res.once('close', finished)
    return () => {
      entry.handlerDone = true
      settle()
    }
  }

  waitForIdle() {
    if (!this.requests.size) return Promise.resolve()
    return new Promise((resolve) => this.waiters.add(resolve)).finally(() => {
      if (!this.requests.size) this.waiters.clear()
    })
  }

  forceClose() {
    for (const { req, res } of this.requests) {
      req.destroy?.(Object.assign(new Error('Control plane shutdown deadline exceeded'), { code: 'shutdown_timeout' }))
      res.destroy?.()
    }
  }
}
