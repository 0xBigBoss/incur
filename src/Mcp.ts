import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { Readable, Writable } from 'node:stream'

import { getEffectiveOptionsSchema, resolveCommandOptions } from './CommandOptions.js'
import { IncurError } from './Errors.js'
import * as Sanitize from './Sanitize.js'
import * as Schema from './Schema.js'

/** Starts a stdio MCP server that exposes commands as tools. */
export async function serve(
  name: string,
  version: string,
  commands: Map<string, any>,
  options: serve.Options = {},
): Promise<void> {
  const server = new McpServer({ name, version })

  for (const tool of collectTools(commands, [])) {
    const optionsSchema = getEffectiveOptionsSchema(tool.command)
    const mergedShape: Record<string, any> = {
      ...tool.command.args?.shape,
      ...optionsSchema?.shape,
    }
    const hasInput = Object.keys(mergedShape).length > 0

    server.registerTool(
      tool.name,
      {
        ...(tool.description ? { description: tool.description } : undefined),
        ...(hasInput ? { inputSchema: mergedShape } : undefined),
      },
      async (...callArgs: any[]) => {
        // registerTool passes (args, extra) when inputSchema is set, (extra) when not
        const params = hasInput ? (callArgs[0] as Record<string, unknown>) : {}
        const extra = hasInput ? callArgs[1] : callArgs[0]
        return callTool(tool, params, extra, options.sanitize)
      },
    )
  }

  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const transport = new StdioServerTransport(input as any, output as any)
  await server.connect(transport)
}

export declare namespace serve {
  /** Options for the MCP server. */
  type Options = {
    /** Override input stream. Defaults to `process.stdin`. */
    input?: Readable | undefined
    /** Override output stream. Defaults to `process.stdout`. */
    output?: Writable | undefined
    /** Sanitizes tool output before it is returned to the agent. */
    sanitize?:
      | ((
          output: unknown,
          context: { command: string; agent: boolean },
        ) => Promise<{
          output: unknown
          blocked: boolean
          warnings?: string[] | undefined
        }>)
      | undefined
  }
}

/** @internal Executes a tool call and returns a CallToolResult. */
export async function callTool(
  tool: ToolEntry,
  params: Record<string, unknown>,
  extra?: {
    _meta?: { progressToken?: string | number }
    sendNotification?: (n: any) => Promise<void>
  },
  sanitize?:
    | ((
        output: unknown,
        context: { command: string; agent: boolean },
      ) => Promise<{
        output: unknown
        blocked: boolean
        warnings?: string[] | undefined
      }>)
    | undefined,
): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
  try {
    const { args, options } = splitParams(params, tool.command)
    const parsedArgs = tool.command.args ? tool.command.args.parse(args) : {}
    const optionsSchema = getEffectiveOptionsSchema(tool.command)
    const parsedOptions = optionsSchema ? optionsSchema.parse(options) : {}
    const { control, options: resolvedOptions } = resolveCommandOptions(
      tool.command,
      parsedOptions as Record<string, unknown>,
    )
    const parsedEnv = tool.command.env ? tool.command.env.parse(process.env) : {}

    const sentinel = Symbol.for('incur.sentinel')
    const okFn = (data: unknown): never => ({ [sentinel]: 'ok', data }) as never
    const errorFn = (opts: { code: string; message: string }): never =>
      ({ [sentinel]: 'error', ...opts }) as never

    const raw = tool.command.run({
      agent: true,
      args: parsedArgs,
      dryRun: control.dryRun,
      env: parsedEnv,
      name: tool.name,
      options: resolvedOptions,
      ok: okFn,
      error: errorFn,
    })

    // Streaming: send progress notifications per chunk, then return buffered result
    if (isAsyncGenerator(raw)) {
      const chunks: unknown[] = []
      const progressToken = extra?._meta?.progressToken
      let i = 0
      for await (const chunk of raw) {
        if (typeof chunk === 'object' && chunk !== null && sentinel in chunk) {
          const tagged = chunk as any
          if (tagged[sentinel] === 'error')
            return {
              content: [{ type: 'text', text: tagged.message ?? 'Command failed' }],
              isError: true,
            }
        }
        chunks.push(chunk)
        if (progressToken !== undefined && extra?.sendNotification)
          await extra.sendNotification({
            method: 'notifications/progress' as const,
            params: { progressToken, progress: ++i, message: JSON.stringify(chunk) },
          })
      }
      return renderToolResult(chunks, tool.name, sanitize)
    }

    const awaited = await raw

    if (typeof awaited === 'object' && awaited !== null && sentinel in awaited) {
      const tagged = awaited as any
      if (tagged[sentinel] === 'error')
        return {
          content: [{ type: 'text', text: tagged.message ?? 'Command failed' }],
          isError: true,
        }
      return renderToolResult(tagged.data ?? null, tool.name, sanitize)
    }

    return renderToolResult(awaited ?? null, tool.name, sanitize)
  } catch (err) {
    return {
      content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
      isError: true,
    }
  }
}

/** @internal Type guard for async generators. */
function isAsyncGenerator(value: unknown): value is AsyncGenerator<unknown, unknown, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof (value as any).next === 'function'
  )
}

/** @internal A resolved tool entry from the command tree. */
export type ToolEntry = {
  name: string
  description?: string | undefined
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] }
  command: any
}

/** @internal Recursively collects leaf commands as tool entries. */
export function collectTools(commands: Map<string, any>, prefix: string[]): ToolEntry[] {
  const seen = new Map<string, string>()
  const result: ToolEntry[] = []
  collect(commands, prefix, seen, result)
  return result.sort((a, b) => a.name.localeCompare(b.name))
}

function collect(
  commands: Map<string, any>,
  prefix: string[],
  seen: Map<string, string>,
  result: ToolEntry[],
) {
  for (const [name, entry] of commands) {
    const path = [...prefix, name]
    if ('_group' in entry && entry._group) {
      collect(entry.commands, path, seen, result)
      continue
    }

    const toolName = path.map((segment) => segment.replaceAll('-', '_')).join('_')
    const commandPath = path.join(' ')
    const existing = seen.get(toolName)
    if (existing && existing !== commandPath)
      throw new IncurError({
        code: 'MCP_TOOL_NAME_COLLISION',
        message: `MCP tool name collision for '${toolName}': '${existing}' and '${commandPath}'`,
      })

    seen.set(toolName, commandPath)
    result.push({
      name: toolName,
      description: formatDescription(entry),
      inputSchema: buildToolSchema(entry.args, getEffectiveOptionsSchema(entry)),
      command: entry,
    })
  }
}

/** @internal Builds a merged JSON Schema from args and options Zod schemas. */
function buildToolSchema(
  args: any | undefined,
  options: any | undefined,
): { type: 'object'; properties: Record<string, unknown>; required?: string[] } {
  const properties: Record<string, unknown> = {}
  const required: string[] = []

  for (const schema of [args, options]) {
    if (!schema) continue
    const json = Schema.toJsonSchema(schema)
    Object.assign(properties, (json.properties as Record<string, unknown>) ?? {})
    required.push(...((json.required as string[]) ?? []))
  }

  if (required.length > 0) return { type: 'object', properties, required }
  return { type: 'object', properties }
}

/** @internal Splits flat params into args vs options using schema shapes. */
function splitParams(
  params: Record<string, unknown>,
  command: any,
): { args: Record<string, unknown>; options: Record<string, unknown> } {
  const argKeys = new Set(command.args ? Object.keys(command.args.shape) : [])
  const a: Record<string, unknown> = {}
  const o: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(params)) {
    if (argKeys.has(key)) a[key] = value
    else o[key] = value
  }
  return { args: a, options: o }
}

function formatDescription(command: any): string | undefined {
  if (!command.description)
    return command.destructive ? 'confirm with user before executing' : undefined
  if (command.destructive) return `${command.description}. confirm with user before executing`
  return command.description
}

async function renderToolResult(
  value: unknown,
  command: string,
  sanitize:
    | ((
        output: unknown,
        context: { command: string; agent: boolean },
      ) => Promise<{
        output: unknown
        blocked: boolean
        warnings?: string[] | undefined
      }>)
    | undefined,
) {
  const result = await Sanitize.sanitize(value, { command, agent: true }, sanitize)
  if (result.blocked) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            code: 'SANITIZED_OUTPUT_BLOCKED',
            message: 'Command output was blocked by sanitization',
            ...(result.warnings ? { warnings: result.warnings } : undefined),
          }),
        },
      ],
      isError: true,
    }
  }

  const payload =
    result.warnings && result.warnings.length > 0 && value && typeof result.output === 'object'
      ? { ...(result.output as Record<string, unknown>), _warnings: result.warnings }
      : result.output
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] }
}
