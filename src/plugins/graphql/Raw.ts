import { parse } from 'graphql'
import { readFile } from 'node:fs/promises'

import { IncurError } from '../../Errors.js'

/**
 * Resolves a raw GraphQL document from flags or stdin.
 */
export async function resolveDocument(options: {
  file?: string | undefined
  query?: string | undefined
}) {
  if (options.query && options.file)
    throw new IncurError({
      code: 'GRAPHQL_DOCUMENT_CONFLICT',
      message: 'Pass either --query or --file, not both',
    })
  if (options.query) return options.query
  if (options.file) return readFile(options.file, 'utf8')

  let value = ''
  for await (const chunk of process.stdin) value += chunk.toString()
  if (value.trim().length > 0) return value

  throw new IncurError({
    code: 'GRAPHQL_DOCUMENT_REQUIRED',
    message: 'Provide a GraphQL document with --query, --file, or stdin',
  })
}

/**
 * Parses `--variables` JSON into a GraphQL variables object.
 */
export function parseVariables(value: string | undefined) {
  if (!value) return undefined
  try {
    return JSON.parse(value) as Record<string, unknown>
  } catch (error) {
    throw new IncurError({
      code: 'GRAPHQL_INVALID_VARIABLES',
      cause: error instanceof Error ? error : undefined,
      message: `Invalid GraphQL variables JSON: ${error instanceof Error ? error.message : String(error)}`,
    })
  }
}

/**
 * Detects whether the selected raw operation is a mutation.
 */
export function isMutation(document: string, operationName: string | undefined) {
  const parsed = parse(document)
  const operations = parsed.definitions.filter(
    (definition) => definition.kind === 'OperationDefinition',
  )
  if (operations.length === 0) return false
  const selected =
    operationName === undefined
      ? operations[0]
      : operations.find((definition) => definition.name?.value === operationName)
  return selected?.operation === 'mutation'
}
