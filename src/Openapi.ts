import { dereference } from '@readme/openapi-parser'
import { z } from 'zod'

import * as Fetch from './Fetch.js'

/** A minimal OpenAPI spec shape. Accepts OpenAPI 3.x and Swagger 2.0 specs. */
export type OpenAPISpec = { paths?: {} | undefined }

/** Internal operation shape after casting. */
type Operation = {
  description?: string | undefined
  operationId?: string | undefined
  parameters?: readonly Parameter[] | undefined
  requestBody?: RequestBody | undefined
  responses?: Record<string, unknown> | undefined
  summary?: string | undefined
}

type Parameter = {
  description?: string | undefined
  in: 'body' | 'cookie' | 'header' | 'path' | 'query'
  name: string
  required?: boolean | undefined
  schema?: Record<string, unknown> | undefined
}

type RequestBody = {
  content?: Record<string, { schema?: Record<string, unknown> | undefined }> | undefined
  required?: boolean | undefined
}

/** A fetch handler. */
type FetchHandler = (req: Request) => Response | Promise<Response>

/** A generated command entry compatible with incur's internal CommandEntry. */
type GeneratedCommand = {
  args?: z.ZodObject<any> | undefined
  body?: z.ZodObject<any> | undefined
  description?: string | undefined
  destructive?: boolean | undefined
  mutates?: boolean | undefined
  openapi?: Record<string, unknown> | undefined
  options?: z.ZodObject<any> | undefined
  output?: z.ZodType | undefined
  run: (context: any) => any
}

/** Generates incur command entries from an OpenAPI spec. Resolves all `$ref` pointers. */
export async function generateCommands(
  spec: OpenAPISpec,
  fetch: FetchHandler,
  options: { basePath?: string | undefined } = {},
): Promise<Map<string, GeneratedCommand>> {
  const resolved = (await dereference(structuredClone(spec) as any)) as unknown as OpenAPISpec
  const commands = new Map<string, GeneratedCommand>()
  const paths = (resolved.paths ?? {}) as Record<string, Record<string, unknown>>

  for (const [path, methods] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      if (method.startsWith('x-')) continue
      const op = operation as Operation
      const name = op.operationId ?? `${method}_${path.replace(/[/{}]/g, '_')}`
      const httpMethod = method.toUpperCase()

      const pathParams = (op.parameters ?? []).filter((p) => p.in === 'path')
      const queryParams = (op.parameters ?? []).filter((p) => p.in === 'query')
      const swagger2BodyParam = (op.parameters ?? []).find((p) => p.in === 'body')

      const bodySchema =
        op.requestBody?.content?.['application/json']?.schema ?? swagger2BodyParam?.schema
      const bodyProps = (bodySchema?.properties ?? {}) as Record<string, Record<string, unknown>>
      const bodyRequired = new Set((bodySchema?.required as string[]) ?? [])
      const responseSchema = getResponseSchema(op.responses)

      // Build args Zod schema from path params
      let argsSchema: z.ZodObject<any> | undefined
      if (pathParams.length > 0) {
        const shape: Record<string, z.ZodType> = {}
        for (const p of pathParams) {
          let zodType = p.schema ? toZod(p.schema) : z.string()
          if (p.description) zodType = zodType.describe(p.description)
          // Path params need coercion from string argv
          shape[p.name] = coerceIfNeeded(zodType)
        }
        argsSchema = z.object(shape)
      }

      // Build options Zod schema from query params + body properties
      const optShape: Record<string, z.ZodType> = {}
      for (const p of queryParams) {
        let zodType = p.schema ? toZod(p.schema) : z.string()
        if (!p.required) zodType = zodType.optional()
        if (p.description) zodType = zodType.describe(p.description)
        optShape[p.name] = coerceIfNeeded(zodType)
      }
      for (const [key, schema] of Object.entries(bodyProps)) {
        let zodType = toZod(schema)
        if (!bodyRequired.has(key)) zodType = zodType.optional()
        optShape[key] = zodType
      }
      const optionsSchema = Object.keys(optShape).length > 0 ? z.object(optShape) : undefined
      const bodyZod =
        bodySchema && typeof bodySchema === 'object'
          ? (toZod(bodySchema) as z.ZodObject<any>)
          : undefined
      const outputSchema =
        responseSchema && typeof responseSchema === 'object' ? toZod(responseSchema) : undefined

      commands.set(name, {
        description: op.summary ?? op.description,
        args: argsSchema,
        body: bodyZod,
        destructive: httpMethod === 'DELETE',
        mutates: !['GET', 'HEAD'].includes(httpMethod),
        openapi: {
          description: op.description ?? op.summary,
          httpMethod,
          operationId: op.operationId,
          parameters: {
            ...(pathParams.length > 0
              ? {
                  path: Object.fromEntries(
                    pathParams.map((param) => [param.name, param.schema ?? { type: 'string' }]),
                  ),
                }
              : undefined),
            ...(queryParams.length > 0
              ? {
                  query: Object.fromEntries(
                    queryParams.map((param) => [param.name, param.schema ?? { type: 'string' }]),
                  ),
                }
              : undefined),
          },
          path,
          ...(bodySchema ? { requestBody: bodySchema } : undefined),
          ...(responseSchema ? { response: responseSchema } : undefined),
        },
        options: optionsSchema,
        output: outputSchema,
        run: createHandler({
          basePath: options.basePath,
          fetch,
          httpMethod,
          path,
          pathParams,
          queryParams,
          bodyProps,
        }),
      })
    }
  }

  return commands
}

function createHandler(config: {
  basePath?: string | undefined
  bodyProps: Record<string, Record<string, unknown>>
  fetch: FetchHandler
  httpMethod: string
  path: string
  pathParams: Parameter[]
  queryParams: Parameter[]
}) {
  return async (context: any) => {
    const { args = {}, options = {} } = context

    // Build URL path with interpolated path params
    let urlPath = (config.basePath ?? '') + config.path
    for (const p of config.pathParams) {
      const value = args[p.name]
      if (value !== undefined) urlPath = urlPath.replace(`{${p.name}}`, String(value))
    }

    // Build query string from query params
    const query = new URLSearchParams()
    for (const p of config.queryParams) {
      const value = options[p.name]
      if (value !== undefined) query.set(p.name, String(value))
    }

    // Build body from body properties
    let body: string | undefined
    const bodyKeys = Object.keys(config.bodyProps)
    if (bodyKeys.length > 0) {
      const bodyObj: Record<string, unknown> = {}
      for (const key of bodyKeys) if (options[key] !== undefined) bodyObj[key] = options[key]
      if (Object.keys(bodyObj).length > 0) body = JSON.stringify(bodyObj)
    }

    const input: Fetch.FetchInput = {
      path: urlPath,
      method: config.httpMethod,
      headers: new Headers(),
      body,
      query,
    }

    if (body) input.headers.set('content-type', 'application/json')

    const request = Fetch.buildRequest(input)
    const response = await config.fetch(request)
    const output = await Fetch.parseResponse(response)

    if (!output.ok)
      return context.error({
        code: `HTTP_${output.status}`,
        message:
          typeof output.data === 'object' && output.data !== null && 'message' in output.data
            ? String((output.data as any).message)
            : typeof output.data === 'string'
              ? output.data
              : `HTTP ${output.status}`,
      })

    return output.data
  }
}

function getResponseSchema(
  responses: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!responses) return undefined
  const preferred =
    Object.entries(responses).find(([status]) => /^2\d\d$/.test(status)) ??
    Object.entries(responses).find(([status]) => status === 'default')
  const response = preferred?.[1] as
    | {
        content?: Record<string, { schema?: Record<string, unknown> | undefined }> | undefined
        schema?: Record<string, unknown> | undefined
      }
    | undefined
  return response?.content?.['application/json']?.schema ?? response?.schema
}

/** Converts a JSON Schema object to a Zod schema. */
function toZod(schema: Record<string, unknown>): z.ZodType {
  return z.fromJSONSchema(schema)
}

/** Wraps a Zod schema with coercion if the base type is number or boolean (argv is always strings). */
function coerceIfNeeded(schema: z.ZodType): z.ZodType {
  const isOptional = schema instanceof z.ZodOptional
  const inner = isOptional ? schema.unwrap() : schema

  // Direct number/boolean
  if (inner instanceof z.ZodNumber)
    return isOptional ? z.coerce.number().optional() : z.coerce.number()
  if (inner instanceof z.ZodBoolean)
    return isOptional ? z.coerce.boolean().optional() : z.coerce.boolean()

  // Union containing number (e.g. type: ["number", "null"] from OpenAPI 3.1)
  if (inner instanceof z.ZodUnion) {
    const options = (inner as any)._zod?.def?.options as z.ZodType[] | undefined
    if (options?.some((o: z.ZodType) => o instanceof z.ZodNumber))
      return isOptional ? z.coerce.number().optional() : z.coerce.number()
    if (options?.some((o: z.ZodType) => o instanceof z.ZodBoolean))
      return isOptional ? z.coerce.boolean().optional() : z.coerce.boolean()
  }

  return schema
}
