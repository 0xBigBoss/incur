import { ScalarType } from '@bufbuild/protobuf'
import type { DescEnum, DescField, DescMessage, DescMethod, DescService } from '@bufbuild/protobuf'
import { Code, ConnectError, createClient } from '@connectrpc/connect'
import { createConnectTransport, createGrpcTransport } from '@connectrpc/connect-node'
import { z } from 'zod'

import * as Cli from '../Cli.js'
import type { Plugin } from '../Plugin.js'

/**
 * Transport configuration for generated Connect RPC commands.
 */
export type Transport = {
  /**
   * Base URL for the backend.
   */
  baseUrl: string
  /**
   * Per-call headers.
   */
  headers?: (() => HeadersInit | Promise<HeadersInit>) | undefined
  /**
   * Wire protocol used by the client.
   */
  protocol: 'connect' | 'grpc'
}

/**
 * Mutation metadata overrides for a generated method.
 */
export type Mutation = {
  /**
   * Whether the method mutates remote state.
   */
  mutates?: boolean | undefined
  /**
   * Whether the method is destructive.
   */
  destructive?: boolean | undefined
}

/**
 * Example override for a generated method.
 */
export type Example = {
  /**
   * Positional example arguments.
   */
  args?: Record<string, unknown> | undefined
  /**
   * Example description.
   */
  description?: string | undefined
  /**
   * Example named options.
   */
  options?: Record<string, unknown> | undefined
}

/**
 * Options for the first-party Connect RPC plugin.
 */
export type Options = {
  /**
   * Example overrides keyed by method local name.
   */
  examples?: Record<string, Example[] | undefined> | undefined
  /**
   * Mutation overrides keyed by method local name.
   */
  mutations?: Record<string, Mutation | undefined> | undefined
  /**
   * Positional field names keyed by method local name.
   */
  positionals?: Record<string, string[] | undefined> | undefined
  /**
   * CLI name overrides keyed by method local name.
   */
  rename?: Record<string, string | undefined> | undefined
  /**
   * Generated service descriptor.
   */
  service: DescService
  /**
   * Network transport configuration.
   */
  transport: Transport
}

const optionsSchema = z.object({
  examples: z.record(z.string(), z.custom<Example[]>()).optional(),
  mutations: z
    .record(
      z.string(),
      z.object({
        destructive: z.boolean().optional(),
        mutates: z.boolean().optional(),
      }),
    )
    .optional(),
  positionals: z.record(z.string(), z.array(z.string())).optional(),
  rename: z.record(z.string(), z.string()).optional(),
  service: z.custom<DescService>(
    (value) =>
      typeof value === 'object' &&
      value !== null &&
      'methods' in value &&
      Array.isArray((value as DescService).methods),
  ),
  transport: z.object({
    baseUrl: z.string().min(1),
    headers: z.custom<Transport['headers']>().optional(),
    protocol: z.enum(['connect', 'grpc']),
  }),
})

/**
 * Creates a generator-style plugin from generated Connect service artifacts.
 */
export function connectRpc(options: Options): Plugin<typeof optionsSchema> {
  return {
    name: 'connectRpc',
    description: 'Generate incur commands from Connect service descriptors',
    config: optionsSchema,
    options: options as z.input<typeof optionsSchema>,
    async resolve({ config, mount }) {
      const cli = Cli.create(mount, {
        description: `Generated RPC commands for ${config.service.typeName}`,
      })
      const transport =
        config.transport.protocol === 'grpc'
          ? createGrpcTransport({ baseUrl: config.transport.baseUrl })
          : createConnectTransport({ baseUrl: config.transport.baseUrl, httpVersion: '1.1' })
      const client = createClient(config.service, transport) as Record<string, Function>

      for (const method of config.service.methods) {
        if (!['server_streaming', 'unary'].includes(method.methodKind))
          throw new Error(`Method '${method.name}' uses unsupported kind '${method.methodKind}'`)

        const localName = method.localName
        const positionals = config.positionals?.[localName] ?? []
        const required = new Set(positionals)
        const commandName = config.rename?.[localName] ?? toKebab(localName)
        const input = createInputSchema(method.input, required)
        const optionsSchema = createOptionsSchema(method.input, new Set(positionals))
        const argsSchema = createArgsSchema(method.input, positionals)
        const output = createOutputSchema(method.output)
        const mutation = resolveMutation(method, config.mutations?.[localName])

        cli.command(commandName, {
          ...(argsSchema ? { args: argsSchema } : undefined),
          description: humanizeMethod(method.name),
          examples: resolveExamples(
            method,
            argsSchema,
            optionsSchema,
            config.examples?.[localName],
          ),
          extensions: {
            connectRpc: {
              method: method.name,
              methodKind: method.methodKind,
              protocol: config.transport.protocol,
              service: config.service.typeName,
            },
          },
          hint: buildHint(method),
          input,
          ...(mutation.destructive ? { destructive: true } : undefined),
          ...(mutation.mutates ? { mutates: true } : undefined),
          ...(optionsSchema ? { options: optionsSchema } : undefined),
          output,
          run: createRun({
            client,
            headers: config.transport.headers,
            input,
            method,
          }),
        })
      }

      return cli
    },
  }
}

function createRun(options: {
  client: Record<string, Function>
  headers?: Transport['headers']
  input: z.ZodObject<any>
  method: DescMethod
}) {
  if (options.method.methodKind === 'server_streaming')
    return (context: any) => {
      const request = toProtoInput(
        options.method.input,
        options.input.parse({ ...context.options, ...context.args }),
      )
      return (async function* () {
        try {
          const headers = options.headers ? await options.headers() : undefined
          const fn = options.client[options.method.localName]
          if (!fn) throw new Error(`Missing generated client method '${options.method.localName}'`)
          for await (const message of fn(request, { headers }))
            yield toPlainMessage(options.method.output, message)
        } catch (error) {
          return context.error(mapRpcError(error))
        }
      })()
    }

  return async (context: any) => {
    try {
      const request = toProtoInput(
        options.method.input,
        options.input.parse({ ...context.options, ...context.args }),
      )
      const headers = options.headers ? await options.headers() : undefined
      const fn = options.client[options.method.localName]
      if (!fn) throw new Error(`Missing generated client method '${options.method.localName}'`)
      const response = await fn(request, { headers })
      return toPlainMessage(options.method.output, response)
    } catch (error) {
      return context.error(mapRpcError(error))
    }
  }
}

function buildHint(method: DescMethod) {
  const hints = ['Use `--json` for nested request fields or full agent payloads.']
  if (method.methodKind === 'server_streaming')
    hints.unshift('Use `--format jsonl` to stream newline-delimited JSON chunks.')
  return hints.join(' ')
}

function createArgsSchema(message: DescMessage, positionals: string[]) {
  if (positionals.length === 0) return undefined
  const shape: Record<string, z.ZodType> = {}
  for (const name of positionals) {
    const field = message.field[name]
    if (!field) throw new Error(`Unknown positional field '${name}' on '${message.typeName}'`)
    if (!isFlaggableField(field))
      throw new Error(`Field '${name}' on '${message.typeName}' cannot be positional`)
    shape[name] = createFieldSchema(field, 'input', true)
  }
  return z.object(shape)
}

function createOptionsSchema(message: DescMessage, excluded: Set<string>) {
  const shape: Record<string, z.ZodType> = {}
  for (const field of message.fields) {
    if (excluded.has(field.localName) || !isFlaggableField(field)) continue
    shape[field.localName] = createFieldSchema(field, 'input', false)
  }
  return Object.keys(shape).length > 0 ? z.object(shape) : undefined
}

function createInputSchema(message: DescMessage, required: Set<string>) {
  return createMessageSchema(message, 'input', required)
}

function createOutputSchema(message: DescMessage) {
  return createMessageSchema(message, 'output', new Set())
}

function createMessageSchema(
  message: DescMessage,
  mode: 'input' | 'output',
  required: Set<string>,
  cache = new Map<string, z.ZodObject<any>>(),
): z.ZodObject<any> {
  const key = `${mode}:${message.typeName}:${[...required].sort().join(',')}`
  const cached = cache.get(key)
  if (cached) return cached
  const shape: Record<string, z.ZodType> = {}
  const schema = z.object(shape).superRefine((value, ctx) => {
    for (const oneof of message.oneofs) {
      const present = oneof.fields.filter((field) => value[field.localName] !== undefined)
      if (present.length < 2) continue
      for (const field of present)
        ctx.addIssue({
          code: 'custom',
          message: `Only one of ${oneof.fields.map((item) => item.localName).join(', ')} may be set`,
          path: [field.localName],
        })
    }
  })
  cache.set(key, schema)
  for (const field of message.fields) {
    let fieldSchema = createFieldSchema(field, mode, required.has(field.localName), cache)
    if (mode === 'output' || !required.has(field.localName)) fieldSchema = fieldSchema.optional()
    shape[field.localName] = fieldSchema
  }
  return schema
}

function createFieldSchema(
  field: DescField,
  mode: 'input' | 'output',
  required: boolean,
  cache = new Map<string, z.ZodObject<any>>(),
): z.ZodType {
  const schema = (() => {
    switch (field.fieldKind) {
      case 'enum':
        return createEnumSchema(field.enum, mode)
      case 'list':
        return z.array(createListSchema(field, mode, cache))
      case 'map':
        return z.record(z.string(), createMapSchema(field, mode, cache))
      case 'message':
        return createMessageSchema(field.message, mode, new Set(), cache)
      case 'scalar':
        return scalarToZod(field.scalar)
    }
  })()

  if (required) return schema
  return schema.optional()
}

function createListSchema(
  field: Extract<DescField, { fieldKind: 'list' }>,
  mode: 'input' | 'output',
  cache: Map<string, z.ZodObject<any>>,
) {
  switch (field.listKind) {
    case 'enum':
      return createEnumSchema(field.enum, mode)
    case 'message':
      return createMessageSchema(field.message, mode, new Set(), cache)
    case 'scalar':
      return scalarToZod(field.scalar)
  }
}

function createMapSchema(
  field: Extract<DescField, { fieldKind: 'map' }>,
  mode: 'input' | 'output',
  cache: Map<string, z.ZodObject<any>>,
) {
  switch (field.mapKind) {
    case 'enum':
      return createEnumSchema(field.enum, mode)
    case 'message':
      return createMessageSchema(field.message, mode, new Set(), cache)
    case 'scalar':
      return scalarToZod(field.scalar)
  }
}

function createEnumSchema(desc: DescEnum, mode: 'input' | 'output') {
  const values = desc.values
    .filter((value) => mode === 'output' || !value.name.endsWith('UNSPECIFIED'))
    .map((value) => enumLiteral(desc, value.name))
  return z.enum(values.length > 0 ? (values as [string, ...string[]]) : ['unspecified'])
}

function scalarToZod(type: ScalarType) {
  switch (type) {
    case ScalarType.BOOL:
      return z.boolean()
    case ScalarType.STRING:
      return z.string()
    case ScalarType.BYTES:
      return z
        .string()
        .regex(/^[A-Za-z0-9+/]*={0,2}$/, 'Invalid base64')
        .refine(
          (v) => v.length % 4 === 0 && Buffer.from(v, 'base64').toString('base64') === v,
          'Invalid base64 encoding',
        )
    case ScalarType.INT64:
    case ScalarType.SFIXED64:
    case ScalarType.SINT64:
      return z
        .string()
        .regex(/^-?\d+$/)
        .refine((v) => {
          const n = BigInt(v)
          return n >= -9223372036854775808n && n <= 9223372036854775807n
        }, 'Out of int64 range')
    case ScalarType.UINT64:
    case ScalarType.FIXED64:
      return z
        .string()
        .regex(/^\d+$/)
        .refine((v) => BigInt(v) <= 18446744073709551615n, 'Out of uint64 range')
    case ScalarType.DOUBLE:
    case ScalarType.FLOAT:
      return z.number()
    case ScalarType.INT32:
    case ScalarType.SFIXED32:
    case ScalarType.SINT32:
      return z.number().int().min(-2147483648).max(2147483647)
    case ScalarType.UINT32:
    case ScalarType.FIXED32:
      return z.number().int().min(0).max(4294967295)
  }
}

function isFlaggableField(field: DescField) {
  if (field.oneof) return true
  return field.fieldKind === 'enum' || field.fieldKind === 'list' || field.fieldKind === 'scalar'
}

function toProtoInput(
  message: DescMessage,
  value: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const field of message.fields) {
    const current = value[field.localName]
    if (current === undefined) continue
    result[field.localName] = toProtoField(field, current)
  }
  return result
}

function toProtoField(field: DescField, value: unknown): unknown {
  switch (field.fieldKind) {
    case 'enum':
      return enumNumber(field.enum, value)
    case 'list':
      return Array.isArray(value) ? value.map((item) => toProtoListValue(field, item)) : []
    case 'map':
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, item]) => [
          key,
          toProtoMapValue(field, item),
        ]),
      )
    case 'message':
      return toProtoInput(field.message, value as Record<string, unknown>)
    case 'scalar':
      return toProtoScalar(field.scalar, value)
  }
}

function toProtoListValue(
  field: Extract<DescField, { fieldKind: 'list' }>,
  value: unknown,
): unknown {
  switch (field.listKind) {
    case 'enum':
      return enumNumber(field.enum, value)
    case 'message':
      return toProtoInput(field.message, value as Record<string, unknown>)
    case 'scalar':
      return toProtoScalar(field.scalar, value)
  }
}

function toProtoMapValue(field: Extract<DescField, { fieldKind: 'map' }>, value: unknown): unknown {
  switch (field.mapKind) {
    case 'enum':
      return enumNumber(field.enum, value)
    case 'message':
      return toProtoInput(field.message, value as Record<string, unknown>)
    case 'scalar':
      return toProtoScalar(field.scalar, value)
  }
}

function toProtoScalar(type: ScalarType, value: unknown): unknown {
  switch (type) {
    case ScalarType.BYTES:
      if (value instanceof Uint8Array) return value
      return Uint8Array.from(Buffer.from(String(value), 'base64'))
    case ScalarType.INT64:
    case ScalarType.UINT64:
    case ScalarType.FIXED64:
    case ScalarType.SFIXED64:
    case ScalarType.SINT64:
      if (typeof value === 'bigint') return value
      return BigInt(String(value))
    default:
      return value
  }
}

function toPlainMessage(message: DescMessage, value: Record<string, unknown>) {
  const result: Record<string, unknown> = {}
  for (const field of message.fields) {
    const current = value[field.localName]
    if (current === undefined) continue
    result[field.localName] = toPlainField(field, current)
  }
  return result
}

function toPlainField(field: DescField, value: unknown): unknown {
  switch (field.fieldKind) {
    case 'enum':
      return enumName(field.enum, value as number)
    case 'list':
      return Array.isArray(value) ? value.map((item) => toPlainListValue(field, item)) : []
    case 'map':
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, item]) => [
          key,
          toPlainMapValue(field, item),
        ]),
      )
    case 'message':
      return toPlainMessage(field.message, value as Record<string, unknown>)
    case 'scalar':
      return toPlainScalar(field.scalar, value)
  }
}

function toPlainListValue(
  field: Extract<DescField, { fieldKind: 'list' }>,
  value: unknown,
): unknown {
  switch (field.listKind) {
    case 'enum':
      return enumName(field.enum, value as number)
    case 'message':
      return toPlainMessage(field.message, value as Record<string, unknown>)
    case 'scalar':
      return toPlainScalar(field.scalar, value)
  }
}

function toPlainMapValue(field: Extract<DescField, { fieldKind: 'map' }>, value: unknown): unknown {
  switch (field.mapKind) {
    case 'enum':
      return enumName(field.enum, value as number)
    case 'message':
      return toPlainMessage(field.message, value as Record<string, unknown>)
    case 'scalar':
      return toPlainScalar(field.scalar, value)
  }
}

function toPlainScalar(type: ScalarType, value: unknown): unknown {
  switch (type) {
    case ScalarType.BYTES:
      if (value instanceof Uint8Array) return Buffer.from(value).toString('base64')
      return Buffer.from(String(value)).toString('base64')
    case ScalarType.INT64:
    case ScalarType.UINT64:
    case ScalarType.FIXED64:
    case ScalarType.SFIXED64:
    case ScalarType.SINT64:
      return String(value)
    default:
      return value
  }
}

function resolveMutation(method: DescMethod, override: Mutation | undefined) {
  const mutates =
    override?.mutates ?? /^(create|delete|destroy|remove|set|update|write)/i.test(method.localName)
  const destructive = override?.destructive ?? false
  return { destructive, mutates }
}

function resolveExamples(
  method: DescMethod,
  args: z.ZodObject<any> | undefined,
  options: z.ZodObject<any> | undefined,
  examples: Example[] | undefined,
) {
  if (examples && examples.length > 0) return examples
  const example: Example = {}
  if (args) {
    const values: Record<string, unknown> = {}
    for (const key of Object.keys(args.shape)) {
      const field = method.input.field[key]
      if (!field) continue
      values[key] = sampleValue(field)
    }
    example.args = values
  } else if (options)
    for (const [key, value] of Object.entries(options.shape)) {
      if (value instanceof z.ZodArray) continue
      const field = method.input.field[key]
      if (!field) continue
      example.options = { [key]: sampleValue(field) }
      break
    }
  if (!example.args && !example.options) return undefined
  example.description = `Example ${humanizeMethod(method.name).toLowerCase()} request`
  return [example]
}

function sampleValue(field: DescField) {
  switch (field.fieldKind) {
    case 'enum':
      return enumName(field.enum, field.enum.values[1]?.number ?? 0)
    case 'list':
      return undefined
    case 'map':
      return {}
    case 'message':
      return {}
    case 'scalar':
      if (field.scalar === ScalarType.BOOL) return true
      if (
        field.scalar === ScalarType.STRING ||
        field.scalar === ScalarType.BYTES ||
        isInt64Scalar(field.scalar)
      )
        return field.localName === 'userId' ? 'u-123' : 'value'
      return 1
  }
}

function isInt64Scalar(type: ScalarType) {
  return [
    ScalarType.INT64,
    ScalarType.UINT64,
    ScalarType.FIXED64,
    ScalarType.SFIXED64,
    ScalarType.SINT64,
  ].includes(type)
}

function mapRpcError(error: unknown) {
  const connectError = ConnectError.from(error)
  const codeName = Code[connectError.code] ?? 'Unknown'
  return {
    code: `RPC_${toSnake(codeName)}`,
    message: connectError.rawMessage,
    retryable: [
      Code.Aborted,
      Code.DeadlineExceeded,
      Code.ResourceExhausted,
      Code.Unavailable,
    ].includes(connectError.code),
  }
}

function enumLiteral(desc: DescEnum, name: string) {
  const prefix = enumPrefix(desc)
  const normalizedName = name.toUpperCase()
  const normalizedPrefix = prefix.toUpperCase()
  const trimmed = normalizedName.startsWith(normalizedPrefix)
    ? normalizedName.slice(normalizedPrefix.length)
    : normalizedName
  return trimmed.toLowerCase().replaceAll('_', '-')
}

function enumName(desc: DescEnum, value: number) {
  const resolved = desc.value[value]
  return enumLiteral(desc, resolved?.name ?? desc.values[0]?.name ?? 'UNSPECIFIED')
}

function enumNumber(desc: DescEnum, value: unknown) {
  if (typeof value === 'number') return value
  const match = desc.values.find((item) => enumLiteral(desc, item.name) === value)
  return match?.number ?? 0
}

function enumPrefix(desc: DescEnum) {
  if (desc.sharedPrefix) return desc.sharedPrefix
  const names = desc.values.map((value) => value.name)
  if (names.length === 0) return ''
  let prefix = names[0] ?? ''
  for (const name of names.slice(1)) {
    while (!name.startsWith(prefix) && prefix.length > 0) prefix = prefix.slice(0, -1)
  }
  const underscore = prefix.lastIndexOf('_')
  return underscore === -1 ? '' : prefix.slice(0, underscore + 1)
}

function humanizeMethod(name: string) {
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function toKebab(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replaceAll('_', '-')
    .toLowerCase()
}

function toSnake(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replaceAll('-', '_')
    .toUpperCase()
}
