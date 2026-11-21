export function strictCompatible(value: unknown, requireAll = false): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const schema = Object.fromEntries(Object.entries(value));
  if (schema.type === undefined && schema.anyOf === undefined && schema.allOf === undefined && schema.enum === undefined && schema.const === undefined) return false;
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) return false;
  if ((schema.type === 'object' || Array.isArray(schema.type) && schema.type.includes('object') || schema.properties !== undefined) && schema.additionalProperties !== false) return false;
  for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'minProperties', 'maxProperties', 'maxItems', 'uniqueItems', 'pattern', '$ref', '$defs', 'definitions', 'patternProperties', 'oneOf', 'not', 'if', 'then', 'else']) {
    if (Object.hasOwn(schema, key)) return false;
  }
  if (schema.minItems !== undefined && schema.minItems !== 0 && schema.minItems !== 1) return false;
  if (Array.isArray(schema.enum) && schema.enum.some(item => typeof item === 'object' && item !== null)) return false;
  if (schema.format !== undefined && !['date-time', 'time', 'date', 'duration', 'email', 'hostname', 'uri', 'ipv4', 'ipv6', 'uuid'].includes(String(schema.format))) return false;
  if (schema.properties !== undefined) {
    if (typeof schema.properties !== 'object' || schema.properties === null || Array.isArray(schema.properties)) return false;
    const keys = Object.keys(schema.properties);
    if (requireAll && (!Array.isArray(schema.required) || schema.required.length !== keys.length || !keys.every(key => schema.required.includes(key)))) return false;
    if (!Object.values(schema.properties).every(child => strictCompatible(child, requireAll))) return false;
  }
  if (schema.items !== undefined && !strictCompatible(schema.items, requireAll)) return false;
  for (const key of ['anyOf', 'allOf']) {
    if (schema[key] !== undefined && (!Array.isArray(schema[key]) || !schema[key].every(child => strictCompatible(child, requireAll)))) return false;
  }
  return true;
}
