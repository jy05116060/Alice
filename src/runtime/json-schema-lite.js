// 迷你 JSON Schema 校验器（阶段 1 / 阶段 2 共用）。
//
// 两件事，都对齐 DSH `dsh-tools/json-schema` 的「强制子集」：
//   1. checkSchemaSubset() / assertObjectSchema()：校验 **schema 自己** 是否落在
//      受支持的子集内。不支持或放错位置的关键字一律拒绝，而不是「看不懂就不管」——
//      否则模型以为约束生效了，实际没有。
//   2. validateJsonSchema()：用子集内的关键字校验**值**。
//
// 受支持的关键字：type / oneOf / properties / required / additionalProperties /
// items / enum / const，外加注解 description / title / default / examples。
// 刻意不引第三方依赖。

/** schema 本身不合规。携 violations 列表，而不是只报第一个错。 */
export class JsonSchemaSubsetError extends Error {
  constructor(violations) {
    super(`unsupported JSON schema: ${violations.join('; ')}`)
    this.name = 'JsonSchemaSubsetError'
    this.code = 'UNSUPPORTED_SCHEMA'
    this.violations = violations
  }
}

const CONSTRAINT_KEYWORDS = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
])
const ANNOTATION_KEYWORDS = new Set(['description', 'title', 'default', 'examples'])
const SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']
// 这些关键字不能和 oneOf 并列（DSH 同样拒绝）。
const ONE_OF_SIBLING_KEYWORDS = ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const']
// 每个关键字只能出现在哪种 type 上。
const KEYWORD_ALLOWED_TYPES = {
  properties: ['object'],
  required: ['object'],
  additionalProperties: ['object'],
  items: ['array'],
  enum: ['string', 'number', 'integer', 'boolean', 'null'],
  const: ['string', 'number', 'integer', 'boolean', 'null'],
}

// ── 值校验 ─────────────────────────────────────────────────────────────────

function typeOf(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (Number.isInteger(value)) return 'integer'
  return typeof value
}

// 有限数值，且排除 -0（JSON 往返会丢符号）。
function isJsonNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)
}

function matchesType(value, type) {
  switch (type) {
    case 'string': return typeof value === 'string'
    case 'number': return isJsonNumber(value)
    case 'integer': return isJsonNumber(value) && Number.isInteger(value)
    case 'boolean': return typeof value === 'boolean'
    case 'null': return value === null
    case 'array': return Array.isArray(value)
    case 'object': return typeOf(value) === 'object'
    default: return false
  }
}

export function validateJsonSchema(value, schema, pathLabel = '$') {
  const errors = []
  walkValue(value, schema, pathLabel, errors)
  return { valid: errors.length === 0, errors }
}

function walkValue(value, schema, pathLabel, errors) {
  if (!schema || typeof schema !== 'object') return

  if (schema.const !== undefined && !Object.is(value, schema.const)) {
    errors.push(`${pathLabel}: expected the constant ${JSON.stringify(schema.const)}`)
    return
  }

  if (Array.isArray(schema.enum) && !schema.enum.some(item => Object.is(item, value))) {
    errors.push(`${pathLabel}: value is not one of the allowed enum values`)
    return
  }

  // oneOf 要求「恰好命中一个分支」（DSH 的 exact-one 语义）。
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    const matched = schema.oneOf.filter((candidate) => {
      const branchErrors = []
      walkValue(value, candidate, pathLabel, branchErrors)
      return branchErrors.length === 0
    })
    if (matched.length !== 1) {
      errors.push(matched.length === 0
        ? `${pathLabel}: value does not match any allowed schema variant`
        : `${pathLabel}: value matches ${matched.length} schema variants (exactly one is required)`)
      return
    }
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!types.some(type => matchesType(value, type))) {
      errors.push(`${pathLabel}: expected type ${types.join(' | ')}, got ${typeOf(value)}`)
      return
    }
  }

  if (typeOf(value) === 'object') {
    const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {}
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push(`${pathLabel}: missing required property "${key}"`)
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        walkValue(child, properties[key], `${pathLabel}.${key}`, errors)
      } else if (schema.additionalProperties === false) {
        errors.push(`${pathLabel}: unexpected property "${key}"`)
      }
    }
  }

  if (typeOf(value) === 'array' && schema.items) {
    value.forEach((item, index) => walkValue(item, schema.items, `${pathLabel}[${index}]`, errors))
  }
}

// ── schema 自身的子集校验 ───────────────────────────────────────────────────

function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === null || Object.getPrototypeOf(proto) === null
}

function isDenseStringArray(value) {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string')
}

function isLosslessJson(value) {
  try {
    return JSON.stringify(value) !== undefined || value === undefined
  } catch {
    return false
  }
}

/** @returns {string[]} 全部违规路径；空数组表示合规。 */
export function checkSchemaSubset(schema, rootPath = 'schema') {
  const violations = []
  const seen = new Set()
  checkNode(schema, rootPath, violations, seen)
  return violations
}

function checkNode(node, path, violations, seen) {
  if (!isPlainObject(node)) {
    violations.push(`${path} must be a schema object`)
    return
  }
  if (seen.has(node)) {
    violations.push(`${path} is circular`)
    return
  }
  seen.add(node)
  try {
    for (const key of Object.keys(node)) {
      if (CONSTRAINT_KEYWORDS.has(key)) continue
      if (ANNOTATION_KEYWORDS.has(key)) {
        if (!isLosslessJson(node[key])) violations.push(`${path}.${key} annotation must be lossless JSON data`)
        continue
      }
      violations.push(`${path}.${key} is not a supported keyword (subset: ${[...CONSTRAINT_KEYWORDS].join('/')} + annotations)`)
    }
    if (Object.hasOwn(node, 'description') && typeof node.description !== 'string') {
      violations.push(`${path}.description must be a string`)
    }
    if (Object.hasOwn(node, 'title') && typeof node.title !== 'string') {
      violations.push(`${path}.title must be a string`)
    }

    const hasType = Object.hasOwn(node, 'type')
    const hasOneOf = Object.hasOwn(node, 'oneOf')
    if (hasType && hasOneOf) {
      violations.push(`${path} cannot declare both type and oneOf`)
      return
    }
    if (!hasType && !hasOneOf) {
      for (const key of ONE_OF_SIBLING_KEYWORDS) {
        if (Object.hasOwn(node, key)) violations.push(`${path}.${key} requires type or oneOf`)
      }
      return
    }

    if (hasOneOf) {
      for (const key of ONE_OF_SIBLING_KEYWORDS) {
        if (Object.hasOwn(node, key)) violations.push(`${path}.${key} is not supported beside oneOf`)
      }
      if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) {
        violations.push(`${path}.oneOf must be an array of at least two schemas`)
      } else {
        node.oneOf.forEach((branch, index) => checkNode(branch, `${path}.oneOf[${index}]`, violations, seen))
      }
      return
    }

    const type = node.type
    if (typeof type !== 'string' || !SCHEMA_TYPES.includes(type)) {
      violations.push(Array.isArray(type)
        ? `${path}.type must be a single type string (type arrays are not supported)`
        : `${path}.type must be one of ${SCHEMA_TYPES.join('/')}`)
      return
    }
    for (const [key, allowed] of Object.entries(KEYWORD_ALLOWED_TYPES)) {
      if (Object.hasOwn(node, key) && !allowed.includes(type)) {
        violations.push(`${path}.${key} is not supported on type "${type}"`)
      }
    }

    if (type === 'object') {
      const properties = Object.hasOwn(node, 'properties') ? node.properties : undefined
      if (Object.hasOwn(node, 'properties')) {
        if (!isPlainObject(properties)) {
          violations.push(`${path}.properties must be an object of schemas`)
        } else {
          for (const [key, child] of Object.entries(properties)) {
            checkNode(child, `${path}.properties.${key}`, violations, seen)
          }
        }
      }
      if (Object.hasOwn(node, 'required')) {
        if (!isDenseStringArray(node.required)) {
          violations.push(`${path}.required must be an array of strings`)
        } else {
          const declared = isPlainObject(properties) ? properties : {}
          for (const key of node.required) {
            if (!Object.hasOwn(declared, key)) {
              violations.push(`${path}.required names "${key}" which is not in properties`)
            }
          }
        }
      }
      if (Object.hasOwn(node, 'additionalProperties') && typeof node.additionalProperties !== 'boolean') {
        violations.push(`${path}.additionalProperties must be a boolean`)
      }
      return
    }

    if (type === 'array') {
      if (Object.hasOwn(node, 'items')) checkNode(node.items, `${path}.items`, violations, seen)
      return
    }

    // 标量：enum / const 必须与 type 同型，且同时声明时 const 必须落在 enum 内。
    const hasEnum = Object.hasOwn(node, 'enum')
    const enumValid = hasEnum
      && Array.isArray(node.enum)
      && node.enum.length > 0
      && node.enum.every(entry => matchesType(entry, type))
    if (hasEnum && !enumValid) violations.push(`${path}.enum must be a non-empty array of ${type} values`)
    if (Object.hasOwn(node, 'const')) {
      if (!matchesType(node.const, type)) {
        violations.push(`${path}.const must be a ${type} value`)
      } else if (enumValid && !node.enum.some(entry => Object.is(entry, node.const))) {
        violations.push(`${path}.const must be one of ${path}.enum when both are declared`)
      }
    }
  } finally {
    seen.delete(node)
  }
}

/**
 * 结构化输出（子代理 result_schema / 工作流 agent({schema})）要求 schema 合规
 * **且**以 object 为根。
 * @throws {JsonSchemaSubsetError}
 */
export function assertObjectSchema(schema) {
  const violations = checkSchemaSubset(schema)
  if (violations.length === 0 && (!isPlainObject(schema) || !Object.hasOwn(schema, 'type') || schema.type !== 'object')) {
    violations.push('schema.type must be "object" (structured output is object-rooted)')
  }
  if (violations.length > 0) throw new JsonSchemaSubsetError(violations)
  return schema
}

// 把校验错误压成一句可回给模型的话，让它自己改。
export function describeSchemaErrors(errors, maxItems = 5) {
  const shown = errors.slice(0, maxItems)
  const suffix = errors.length > shown.length ? ` (+${errors.length - shown.length} more)` : ''
  return `${shown.join('; ')}${suffix}`
}
