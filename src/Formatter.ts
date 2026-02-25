import { encode } from '@toon-format/toon'

/** Serializes a value to TOON format. */
export function format(value: Record<string, unknown>) {
  return encode(value)
}
