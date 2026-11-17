const ROOT_COMBINATIONS = ['allOf', 'anyOf', 'oneOf']
const OUTER_KEYS = new Set(['type', 'title', 'description', '$comment'])
const REFERENCE_KEYS = new Set(['$ref', '$dynamicRef', '$recursiveRef', '$id', '$anchor', '$dynamicAnchor'])

function isObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function hasReferences(schema) {
  const pending = [schema]
  while (pending.length) {
    const node = pending.pop()
    for (const [key, value] of Object.entries(node)) {
      if (REFERENCE_KEYS.has(key)) return true
      if (value && typeof value === 'object') pending.push(value)
    }
  }
  return false
}

export function normalizeToolInputSchema(schema) {
  if (!isObject(schema) || (schema.type !== undefined && schema.type !== 'object')) return null
  const combinations = ROOT_COMBINATIONS.filter((key) => Object.hasOwn(schema, key))
  if (!combinations.length) return schema.type === 'object' ? schema : { ...schema, type: 'object' }
  const [key] = combinations
  const { [key]: branches, ...outer } = schema
  if (
    combinations.length !== 1 ||
    Object.keys(outer).some((name) => !OUTER_KEYS.has(name)) ||
    !Array.isArray(branches) ||
    branches.length !== 1 ||
    !isObject(branches[0]) ||
    branches[0].type !== 'object' ||
    ROOT_COMBINATIONS.some((name) => Object.hasOwn(branches[0], name)) ||
    hasReferences(branches[0])
  )
    return null
  return { ...outer, ...branches[0] }
}

function invalidToolSchema(param, reason) {
  const message = `${param}: ${reason}`
  const code = 'invalid_tool_schema'
  throw Object.assign(new Error(message), {
    status: 400,
    code,
    body: { type: 'error', error: { type: 'invalid_request_error', code, param, message } },
  })
}

export function normalizeToolInputSchemas(tools, invalid = invalidToolSchema) {
  if (!Array.isArray(tools)) return tools
  let out = tools
  for (const [index, tool] of tools.entries()) {
    if (!tool || (tool.type != null && tool.type !== 'custom')) continue
    const schema = tool.input_schema
    if (!isObject(schema) || !ROOT_COMBINATIONS.some((key) => Object.hasOwn(schema, key))) continue
    const normalized = normalizeToolInputSchema(schema)
    if (!normalized) invalid(`tools[${index}].input_schema`, 'unsupported root combinations in object schema')
    if (out === tools) out = tools.slice()
    out[index] = { ...tool, input_schema: normalized }
  }
  return out
}
