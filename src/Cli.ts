import { z } from 'zod'
import type { FieldError } from './Errors.js'
import { ClacError, ValidationError } from './Errors.js'
import * as Formatter from './Formatter.js'
import type { OneOf } from './internal/types.js'
import * as Parser from './Parser.js'
import * as Schema from './Schema.js'

/** A CLI application instance. */
export type Cli = {
  /** The name of the CLI application. */
  name: string
  /** Registers a command or mounts a command group. Returns the CLI instance for chaining. */
  command: {
    <
      const args extends z.ZodObject<any> | undefined = undefined,
      const options extends z.ZodObject<any> | undefined = undefined,
      const output extends z.ZodObject<any> | undefined = undefined,
    >(
      name: string,
      definition: CommandDefinition<args, options, output>,
    ): Cli
    /** Mounts a command group. */
    (group: CommandGroup): Cli
  }
  /** Parses argv, runs the matched command, and writes the output envelope to stdout. */
  serve(argv?: string[], options?: serve.Options): Promise<void>
}

/** A command group that contains sub-commands. */
export type CommandGroup = {
  /** The command group name. */
  name: string
  /** A short description of the command group. */
  description?: string | undefined
  /** Registers a sub-command or mounts a nested command group. Returns the group for chaining. */
  command: {
    <
      const args extends z.ZodObject<any> | undefined = undefined,
      const options extends z.ZodObject<any> | undefined = undefined,
      const output extends z.ZodObject<any> | undefined = undefined,
    >(
      name: string,
      definition: CommandDefinition<args, options, output>,
    ): CommandGroup
    /** Mounts a nested command group. */
    (group: CommandGroup): CommandGroup
  }
}

/** Inferred output type of a Zod schema, or `{}` when the schema is not provided. */
type InferOutput<schema extends z.ZodObject<any> | undefined> =
  schema extends z.ZodObject<any> ? z.output<schema> : {}

/** Inferred return type for a command handler. */
type InferReturn<output extends z.ZodObject<any> | undefined> =
  output extends z.ZodObject<any> ? z.output<output> : unknown

/** A suggested next command returned from the `next` callback. */
type NextCommand = {
  /** The command string to run. */
  command: string
  /** A short description of what the command does. */
  description?: string | undefined
  /** Pre-filled arguments for the command. */
  args?: Record<string, unknown> | undefined
}

/** The output envelope written to stdout. */
type Output = OneOf<
  | {
      /** Whether the command succeeded. */
      ok: true
      /** The command's return data. */
      data: unknown
      /** Request metadata. */
      meta: Output.Meta
    }
  | {
      /** Whether the command succeeded. */
      ok: false
      /** Error details. */
      error: {
        /** Machine-readable error code. */
        code: string
        /** Human-readable error message. */
        message: string
        /** Actionable hint for the user. */
        hint?: string | undefined
        /** Whether the operation can be retried. */
        retryable?: boolean | undefined
        /** Per-field validation errors. */
        fieldErrors?: FieldError[] | undefined
      }
      /** Request metadata. */
      meta: Output.Meta
    }
>

declare namespace Output {
  /** Shared metadata included in every envelope. */
  type Meta = {
    /** The command that was invoked. */
    command: string
    /** Wall-clock duration of the command. */
    duration: string
  }
}

/** MCP-style tool annotations describing a command's behavior. */
export type Annotations = {
  /** Human-readable title for the command. */
  title?: string | undefined
  /** Whether the command only reads data (no side effects). */
  readOnlyHint?: boolean | undefined
  /** Whether the command may perform destructive operations. */
  destructiveHint?: boolean | undefined
  /** Whether the command can be called multiple times safely. */
  idempotentHint?: boolean | undefined
  /** Whether the command interacts with external systems. */
  openWorldHint?: boolean | undefined
}

/** Defines a command's schema, handler, and metadata. */
type CommandDefinition<
  args extends z.ZodObject<any> | undefined = undefined,
  options extends z.ZodObject<any> | undefined = undefined,
  output extends z.ZodObject<any> | undefined = undefined,
> = {
  /** A short description of what the command does. */
  description?: string | undefined
  /** Zod schema for positional arguments. */
  args?: args
  /** Zod schema for named options/flags. */
  options?: options
  /** Zod schema for the command's return value. */
  output?: output
  /** Map of option names to single-char aliases. */
  alias?: options extends z.ZodObject<any>
    ? Partial<Record<keyof z.output<options>, string>>
    : Record<string, string> | undefined
  /** MCP-style annotations describing the command's behavior. */
  annotations?: Annotations | undefined
  /** The command handler. */
  run(context: {
    args: InferOutput<args>
    options: InferOutput<options>
  }): InferReturn<output> | Promise<InferReturn<output>>
  /** Returns suggested next commands based on the result. */
  next?: ((result: InferReturn<output>) => NextCommand[]) | undefined
}

/** Creates a new CLI application. */
export function create(name: string, _options: create.Options = {}): Cli {
  const commands = new Map<string, CommandEntry>()

  return {
    name,

    command(nameOrGroup: any, def?: any) {
      if (typeof nameOrGroup === 'string') commands.set(nameOrGroup, def)
      else commands.set(nameOrGroup.name, commandToGroup.get(nameOrGroup)!)
      return this
    },

    async serve(argv = process.argv.slice(2), options: serve.Options = {}) {
      const stdout = options.stdout ?? ((s: string) => process.stdout.write(s))
      const exit = options.exit ?? ((code: number) => process.exit(code))

      // Extract built-in flags before command parsing
      const { verbose, format, llms, rest: filtered } = extractBuiltinFlags(argv)

      if (llms) {
        stdout(Formatter.format(buildManifest(commands), format))
        return
      }

      const start = performance.now()

      function write(output: Output) {
        if (verbose) return stdout(Formatter.format(output, format))
        if (output.ok) stdout(Formatter.format(output.data, format))
        else stdout(Formatter.format(output.error, format))
      }

      function writeError(message: string, commandPath: string) {
        write({
          ok: false,
          error: { code: 'COMMAND_NOT_FOUND', message },
          meta: {
            command: commandPath,
            duration: `${Math.round(performance.now() - start)}ms`,
          },
        })
        exit(1)
      }

      // Resolve command by walking the tree
      const resolved = resolveCommand(commands, filtered)
      if ('error' in resolved) {
        writeError(resolved.error, resolved.path)
        return
      }

      const { command, path, rest } = resolved

      try {
        const { args, options: parsedOptions } = Parser.parse(rest, {
          args: command.args,
          options: command.options,
        })

        const data = await command.run({ args, options: parsedOptions })

        write({
          ok: true,
          data,
          meta: {
            command: path,
            duration: `${Math.round(performance.now() - start)}ms`,
          },
        })
      } catch (error) {
        write({
          ok: false,
          error: {
            code: error instanceof ClacError ? error.code : 'UNKNOWN',
            message: error instanceof Error ? error.message : String(error),
            ...(error instanceof ClacError && error.hint ? { hint: error.hint } : undefined),
            ...(error instanceof ClacError ? { retryable: error.retryable } : undefined),
            ...(error instanceof ValidationError ? { fieldErrors: error.fieldErrors } : undefined),
          },
          meta: {
            command: path,
            duration: `${Math.round(performance.now() - start)}ms`,
          },
        })
        exit(1)
      }
    },
  }
}

export declare namespace create {
  /** Options for creating a CLI application. */
  type Options = {
    /** The CLI version string. */
    version?: string | undefined
    /** A short description of the CLI. */
    description?: string | undefined
  }
}

export declare namespace serve {
  /** Options for `serve()`, primarily used for testing. */
  type Options = {
    /** Override stdout writer. Defaults to `process.stdout.write`. */
    stdout?: ((s: string) => void) | undefined
    /** Override exit handler. Defaults to `process.exit`. */
    exit?: ((code: number) => void) | undefined
  }
}

/** Creates a command group that accepts sub-commands. */
export function command(name: string, options: command.Options = {}): CommandGroup {
  const commands = new Map<string, CommandEntry>()
  const group: InternalGroup = { _group: true, description: options.description, commands }

  const cmd: CommandGroup = {
    name,
    description: options.description,
    command(nameOrGroup: any, def?: any) {
      if (typeof nameOrGroup === 'string') commands.set(nameOrGroup, def)
      else commands.set(nameOrGroup.name, commandToGroup.get(nameOrGroup)!)
      return cmd
    },
  }

  commandToGroup.set(cmd, group)
  return cmd
}

export declare namespace command {
  /** Options for creating a command group. */
  type Options = {
    /** A short description of the command group. */
    description?: string | undefined
  }
}

/** Resolves a command from the tree by walking tokens until a leaf is found. */
function resolveCommand(
  commands: Map<string, CommandEntry>,
  tokens: string[],
):
  | { command: CommandDefinition<any, any, any>; path: string; rest: string[] }
  | { error: string; path: string } {
  const [first, ...rest] = tokens

  if (!first || !commands.has(first))
    return { error: `Unknown command: ${first ?? '(none)'}`, path: first ?? '' }

  let entry = commands.get(first)!
  const path = [first]
  let remaining = rest

  while (isGroup(entry)) {
    const next = remaining[0]
    const available = [...entry.commands.keys()].sort().join(', ')
    if (!next)
      return {
        error: `No subcommand provided for ${path.join(' ')}. Available: ${available}`,
        path: path.join(' '),
      }

    const child = entry.commands.get(next)
    if (!child)
      return { error: `Unknown subcommand: ${next}. Available: ${available}`, path: path.join(' ') }

    path.push(next)
    remaining = remaining.slice(1)
    entry = child
  }

  return { command: entry, path: path.join(' '), rest: remaining }
}

/** Extracts built-in flags (--verbose, --format, --json, --llms) from argv. */
function extractBuiltinFlags(argv: string[]) {
  let verbose = false
  let llms = false
  let format: Formatter.Format = 'toon'
  const rest: string[] = []

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (token === '--verbose') verbose = true
    else if (token === '--llms') llms = true
    else if (token === '--json') format = 'json'
    else if (token === '--format' && argv[i + 1]) {
      format = argv[i + 1] as Formatter.Format
      i++
    } else rest.push(token)
  }

  return { verbose, format, llms, rest }
}

/** @internal Entry stored in a command map — either a leaf definition or a group. */
type CommandEntry = CommandDefinition<any, any, any> | InternalGroup

/** @internal A command group's internal storage. */
type InternalGroup = {
  _group: true
  description?: string | undefined
  commands: Map<string, CommandEntry>
}

/** @internal Type guard for command groups. */
function isGroup(entry: CommandEntry): entry is InternalGroup {
  return '_group' in entry
}

/** @internal Maps public CommandGroup objects to their internal group data. */
const commandToGroup = new WeakMap<CommandGroup, InternalGroup>()

/** Builds the `--llms` manifest from the command tree. */
function buildManifest(commands: Map<string, CommandEntry>) {
  return {
    version: 'clac.v1',
    commands: collectCommands(commands, []).sort((a, b) => a.name.localeCompare(b.name)),
  }
}

/** Recursively collects leaf commands with their full paths. */
function collectCommands(
  commands: Map<string, CommandEntry>,
  prefix: string[],
): {
  name: string
  description?: string
  schema?: Record<string, unknown>
  annotations?: Annotations
}[] {
  const result: ReturnType<typeof collectCommands> = []
  for (const [name, entry] of commands) {
    const path = [...prefix, name]
    if (isGroup(entry)) {
      result.push(...collectCommands(entry.commands, path))
    } else {
      const cmd: (typeof result)[number] = { name: path.join(' ') }
      if (entry.description) cmd.description = entry.description

      const inputSchema = buildInputSchema(entry.args, entry.options)
      const outputSchema = entry.output ? Schema.toJsonSchema(entry.output) : undefined
      if (inputSchema || outputSchema) {
        cmd.schema = {}
        if (inputSchema) cmd.schema.input = inputSchema
        if (outputSchema) cmd.schema.output = outputSchema
      }

      if (entry.annotations) cmd.annotations = entry.annotations
      result.push(cmd)
    }
  }
  return result
}

/** Merges args + options schemas into a single input JSON Schema. */
function buildInputSchema(
  args: z.ZodObject<any> | undefined,
  options: z.ZodObject<any> | undefined,
): Record<string, unknown> | undefined {
  if (!args && !options) return undefined
  const merged = z.object({
    ...(args?.shape ?? {}),
    ...(options?.shape ?? {}),
  })
  return Schema.toJsonSchema(merged)
}
