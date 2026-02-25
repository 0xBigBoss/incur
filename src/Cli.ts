import type { z } from 'zod'
import * as Formatter from './Formatter.js'

/** A CLI application instance. */
export type Cli = {
  /** The name of the CLI application. */
  name: string
  /** Registers a command and returns the CLI instance for chaining. */
  command(name: string, definition: CommandDefinition): Cli
  /** Parses argv, runs the matched command, and writes the output envelope to stdout. */
  serve(argv?: string[], options?: serve.Options): Promise<void>
}

/** Defines a command's schema, handler, and metadata. */
type CommandDefinition = {
  /** A short description of what the command does. */
  description?: string | undefined
  /** Zod schema for positional arguments. */
  args?: z.ZodObject<any> | undefined
  /** Zod schema for named options/flags. */
  options?: z.ZodObject<any> | undefined
  /** Zod schema for the command's return value. */
  output?: z.ZodObject<any> | undefined
  /** The command handler. */
  run(context: { args: any; options: any }): unknown | Promise<unknown>
}

/** Creates a new CLI application. */
export function create(name: string, _options: create.Options = {}): Cli {
  const commands = new Map<string, CommandDefinition>()

  return {
    name,

    command(name, def) {
      commands.set(name, def)
      return this
    },

    async serve(argv = process.argv.slice(2), options: serve.Options = {}) {
      const stdout = options.stdout ?? ((s: string) => process.stdout.write(s))
      const exit = options.exit ?? ((code: number) => process.exit(code))

      const [commandName, ...rest] = argv
      const start = performance.now()

      function write(envelope: Record<string, unknown>) {
        stdout(Formatter.format(envelope))
      }

      if (!commandName || !commands.has(commandName)) {
        write({
          ok: false,
          error: {
            code: 'COMMAND_NOT_FOUND',
            message: `Unknown command: ${commandName ?? '(none)'}`,
          },
          meta: {
            command: commandName ?? '',
            duration: `${Math.round(performance.now() - start)}ms`,
          },
        })
        exit(1)
        return
      }

      const command = commands.get(commandName)!

      try {
        // Parse positional args by schema key order
        const args: Record<string, string> = {}
        if (command.args) {
          const keys = Object.keys(command.args.shape)
          for (let i = 0; i < keys.length; i++) {
            const key = keys[i]!
            if (rest[i] !== undefined) args[key] = rest[i]!
          }
        }

        const data = await command.run({ args, options: {} })

        write({
          ok: true,
          data,
          meta: {
            command: commandName,
            duration: `${Math.round(performance.now() - start)}ms`,
          },
        })
      } catch (error) {
        write({
          ok: false,
          error: {
            code: 'UNKNOWN',
            message: error instanceof Error ? error.message : String(error),
          },
          meta: {
            command: commandName,
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


