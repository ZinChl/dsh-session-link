/**
 * Minimal validator for the exact schema dialect this plugin declares for tool
 * output (`type` / `properties` / `required` per property / `items` / `enum` /
 * `additionalProperties`).
 *
 * It exists so the offline test suite can prove that every `execute()` return
 * value satisfies the schema the host will enforce — without installing the
 * host packages. The real host validator additionally rejects values that are
 * not lossless JSON, which {@link assertLosslessJson} covers here.
 *
 * @module tests/helpers/schema
 */

/**
 * Validate one value against one schema node.
 *
 * @param {unknown} value - candidate value.
 * @param {object} schema - schema node.
 * @param {string} [path] - diagnostic path.
 * @returns {string[]} violations (empty means valid).
 */
export function validate(value, schema, path = '$') {
  const problems = [];
  if (schema === null || typeof schema !== 'object') return problems;

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    problems.push(`${path}: ${JSON.stringify(value)} not in enum`);
    return problems;
  }

  switch (schema.type) {
    case undefined:
    case 'json':
      break;
    case 'string':
      if (typeof value !== 'string') problems.push(`${path}: expected string, got ${typeof value}`);
      break;
    case 'number':
      if (typeof value !== 'number' || Number.isFinite(value) !== true) problems.push(`${path}: expected finite number`);
      break;
    case 'integer':
      if (Number.isInteger(value) !== true) problems.push(`${path}: expected integer`);
      break;
    case 'boolean':
      if (typeof value !== 'boolean') problems.push(`${path}: expected boolean, got ${typeof value}`);
      break;
    case 'null':
      if (value !== null) problems.push(`${path}: expected null`);
      break;
    case 'array':
      if (!Array.isArray(value)) {
        problems.push(`${path}: expected array, got ${typeof value}`);
        break;
      }
      if (schema.items !== undefined) {
        value.forEach((item, index) => problems.push(...validate(item, schema.items, `${path}[${index}]`)));
      }
      break;
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        problems.push(`${path}: expected object, got ${Array.isArray(value) ? 'array' : typeof value}`);
        break;
      }
      const properties = schema.properties ?? {};
      for (const [key, child] of Object.entries(properties)) {
        const member = value[key];
        if (member === undefined) {
          if (child.required === true) problems.push(`${path}.${key}: required but missing`);
          continue;
        }
        problems.push(...validate(member, child, `${path}.${key}`));
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(value)) {
          if (key in properties) continue;
          problems.push(`${path}.${key}: unexpected property (additionalProperties=false)`);
        }
      }
      break;
    }
    default:
      problems.push(`${path}: unsupported schema type ${String(schema.type)}`);
  }
  return problems;
}

/**
 * Assert a value is lossless JSON (no undefined members, no functions, no NaN).
 *
 * @param {unknown} value - candidate value.
 * @param {string} [path] - diagnostic path.
 * @returns {string[]} violations.
 */
export function assertLosslessJson(value, path = '$') {
  const problems = [];
  if (value === undefined) {
    problems.push(`${path}: undefined is not lossless JSON`);
    return problems;
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return problems;
  if (typeof value === 'number') {
    if (Number.isFinite(value) !== true) problems.push(`${path}: non-finite number`);
    return problems;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => problems.push(...assertLosslessJson(item, `${path}[${index}]`)));
    return problems;
  }
  if (typeof value === 'object') {
    for (const [key, member] of Object.entries(value)) {
      if (member === undefined) problems.push(`${path}.${key}: undefined member`);
      else problems.push(...assertLosslessJson(member, `${path}.${key}`));
    }
    return problems;
  }
  problems.push(`${path}: unsupported JSON value (${typeof value})`);
  return problems;
}
