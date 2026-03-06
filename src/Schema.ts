import { z } from 'zod'

/** Converts a Zod schema to a JSON Schema object. Strips the `$schema` meta-property. */
export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return stripMeta(z.toJSONSchema(schema)) as Record<string, unknown>
}

function stripMeta(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripMeta)
  if (!value || typeof value !== 'object') return value

  const result: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value))
    if (k !== '$schema' && !k.startsWith('~')) result[k] = stripMeta(v)

  return result
}
