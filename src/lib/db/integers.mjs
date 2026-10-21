/** Exact arithmetic for PostgreSQL bigint counters exposed as numbers or decimal strings. */
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)

function integer(value) {
  if (value == null || value === '') return 0n
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new RangeError('counter must be a safe integer number or an exact decimal string')
  }
  return BigInt(value)
}

export function addInteger(left, right) {
  const result = integer(left) + integer(right)
  return result >= -MAX_SAFE && result <= MAX_SAFE ? Number(result) : result.toString()
}

export function integerValue(value) {
  return addInteger(value, 0)
}
