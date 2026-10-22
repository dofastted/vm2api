/** Response-finish writes are tracked so maintenance and shutdown can drain them. */
const pending = new Set()
let failure = null

export function trackPendingWrite(operation) {
  const tracked = Promise.resolve(operation)
  pending.add(tracked)
  tracked
    .catch((error) => {
      failure ||= error
      console.warn(`[db] response persistence failed: ${error.code || error.name}`)
    })
    .finally(() => pending.delete(tracked))
  return tracked
}

export async function flushPendingWrites() {
  while (pending.size) await Promise.allSettled([...pending])
  if (failure) throw failure
}
