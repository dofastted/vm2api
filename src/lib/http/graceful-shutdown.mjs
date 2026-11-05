/**
 * Graceful shutdown and connection draining coordinator (Issue #376).
 *
 * Sequence on SIGTERM / SIGINT:
 * 1. Mark status as shutting down (isShuttingDown() === true).
 * 2. Stop accepting new connections (server.close()).
 * 3. Health check endpoints (/health, /healthz) immediately degrade to 503 shutting_down.
 * 4. Stop incoming background pollers/schedulers (beforeDrain).
 * 5. Wait for active in-flight requests to complete up to drainTimeoutMs.
 * 6. If timeout is reached, force-close remaining connections.
 * 7. Run teardown: stop cluster relays, watchers, flush & close database (afterDrain).
 * 8. Exit process.
 */

export function createGracefulShutdown({
  server: initialServer = null,
  drainTimeoutMs = Number(process.env.KIN_SHUTDOWN_DRAIN_TIMEOUT_MS) || 25_000,
  logger = console,
  exit = (code) => process.exit(code),
  beforeDrain,
  afterDrain,
} = {}) {
  let server = initialServer
  let shuttingDown = false
  let shutdownPromise = null
  const activeRequests = new Set()
  let drainResolve = null

  function setServer(srv) {
    server = srv
  }

  function isShuttingDown() {
    return shuttingDown
  }

  function trackRequest(_req, res) {
    if (shuttingDown) {
      return false
    }
    activeRequests.add(res)
    const cleanup = () => {
      if (activeRequests.delete(res)) {
        if (shuttingDown && activeRequests.size === 0 && drainResolve) {
          drainResolve()
        }
      }
    }
    res.once('finish', cleanup)
    res.once('close', cleanup)
    return true
  }

  function getActiveCount() {
    return activeRequests.size
  }

  function shutdown(signal = 'SIGTERM') {
    if (shutdownPromise) return shutdownPromise

    shutdownPromise = (async () => {
      shuttingDown = true
      logger.log(`[shutdown] ${signal} — closing; active in-flight requests: ${activeRequests.size}`)

      // 1. Stop accepting new connections
      try {
        server?.close?.(() => {})
      } catch (err) {
        logger.warn('[shutdown] error closing server listener:', err?.message || err)
      }

      // 2. Stop incoming background pollers and schedulers
      if (typeof beforeDrain === 'function') {
        try {
          await beforeDrain(signal)
        } catch (err) {
          logger.warn('[shutdown] error in beforeDrain:', err?.message || err)
        }
      }

      // 3. Wait for in-flight requests to drain
      if (activeRequests.size > 0) {
        logger.log(`[shutdown] waiting up to ${drainTimeoutMs}ms for ${activeRequests.size} request(s) to drain...`)
        let timer
        const timeoutPromise = new Promise((resolve) => {
          timer = setTimeout(resolve, drainTimeoutMs)
          timer.unref?.()
        })
        const drainPromise = new Promise((resolve) => {
          drainResolve = resolve
          if (activeRequests.size === 0) resolve()
        })

        await Promise.race([drainPromise, timeoutPromise])
        clearTimeout(timer)

        if (activeRequests.size > 0) {
          logger.warn(`[shutdown] drain timeout reached; force-closing ${activeRequests.size} remaining request(s)`)
          try {
            server?.closeAllConnections?.()
          } catch {}
          for (const res of activeRequests) {
            try {
              res.destroy()
            } catch {}
          }
          activeRequests.clear()
        } else {
          logger.log('[shutdown] all in-flight requests drained successfully')
        }
      }

      // 4. Run teardown (cluster relays, database close, watchers)
      if (typeof afterDrain === 'function') {
        try {
          await afterDrain(signal)
        } catch (err) {
          logger.warn('[shutdown] error in afterDrain:', err?.message || err)
        }
      }

      logger.log(`[shutdown] ${signal} — graceful shutdown complete`)
      exit(0)
    })()

    return shutdownPromise
  }

  return {
    isShuttingDown,
    trackRequest,
    getActiveCount,
    setServer,
    shutdown,
  }
}
