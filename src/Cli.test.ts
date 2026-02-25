import { Cli, Errors, z } from 'clac'

async function serve(cli: ReturnType<typeof Cli.create>, argv: string[]) {
  let output = ''
  let exitCode: number | undefined
  await cli.serve(argv, {
    stdout(s) {
      output += s
    },
    exit(code) {
      exitCode = code
    },
  })
  return {
    output: output.replace(/duration: \d+ms/, 'duration: <stripped>'),
    exitCode,
  }
}

describe('create', () => {
  test('returns cli instance with name', () => {
    const cli = Cli.create('test')
    expect(cli.name).toBe('test')
  })

  test('accepts version and description options', () => {
    const cli = Cli.create('test', { version: '1.0.0', description: 'A test CLI' })
    expect(cli.name).toBe('test')
  })
})

describe('command', () => {
  test('registers a command and is chainable', () => {
    const cli = Cli.create('test')
    const result = cli.command('greet', {
      args: z.object({ name: z.string() }),
      run({ args }) {
        return { message: `hello ${args.name}` }
      },
    })
    expect(result).toBe(cli)
  })
})

describe('serve', () => {
  test('outputs data only by default', async () => {
    const cli = Cli.create('test')
    cli.command('greet', {
      args: z.object({ name: z.string() }),
      run({ args }) {
        return { message: `hello ${args.name}` }
      },
    })

    const { output } = await serve(cli, ['greet', 'world'])
    expect(output).toMatchInlineSnapshot(`"message: hello world"`)
  })

  test('--verbose outputs full envelope', async () => {
    const cli = Cli.create('test')
    cli.command('greet', {
      args: z.object({ name: z.string() }),
      run({ args }) {
        return { message: `hello ${args.name}` }
      },
    })

    const { output } = await serve(cli, ['greet', 'world', '--verbose'])
    expect(output).toMatchInlineSnapshot(`
      "ok: true
      data:
        message: hello world
      meta:
        command: greet
        duration: <stripped>"
    `)
  })

  test('parses positional args by schema key order', async () => {
    const cli = Cli.create('test')
    let receivedArgs: any
    cli.command('add', {
      args: z.object({ a: z.string(), b: z.string() }),
      run({ args }) {
        receivedArgs = args
        return {}
      },
    })

    await serve(cli, ['add', 'foo', 'bar'])
    expect(receivedArgs).toEqual({ a: 'foo', b: 'bar' })
  })

  test('serializes output as TOON', async () => {
    const cli = Cli.create('test')
    cli.command('ping', {
      run() {
        return { pong: true }
      },
    })

    const { output } = await serve(cli, ['ping'])
    expect(() => JSON.parse(output)).toThrow()
    expect(output).toMatchInlineSnapshot(`"pong: true"`)
  })

  test('outputs error details for unknown command', async () => {
    const cli = Cli.create('test')

    const { output, exitCode } = await serve(cli, ['nonexistent'])
    expect(exitCode).toBe(1)
    expect(output).toMatchInlineSnapshot(`
      "code: COMMAND_NOT_FOUND
      message: "Unknown command: nonexistent""
    `)
  })

  test('--verbose outputs full error envelope for unknown command', async () => {
    const cli = Cli.create('test')

    const { output, exitCode } = await serve(cli, ['nonexistent', '--verbose'])
    expect(exitCode).toBe(1)
    expect(output).toMatchInlineSnapshot(`
      "ok: false
      error:
        code: COMMAND_NOT_FOUND
        message: "Unknown command: nonexistent"
      meta:
        command: nonexistent
        duration: <stripped>"
    `)
  })

  test('wraps handler errors in error output', async () => {
    const cli = Cli.create('test')
    cli.command('fail', {
      run() {
        throw new Error('boom')
      },
    })

    const { output, exitCode } = await serve(cli, ['fail'])
    expect(exitCode).toBe(1)
    expect(output).toMatchInlineSnapshot(`
      "code: UNKNOWN
      message: boom"
    `)
  })

  test('ClacError in run() populates code/hint/retryable', async () => {
    const cli = Cli.create('test')
    cli.command('fail', {
      run() {
        throw new Errors.ClacError({
          code: 'NOT_AUTHENTICATED',
          message: 'Token not found',
          hint: 'Set GH_TOKEN env var',
          retryable: false,
        })
      },
    })

    const { output, exitCode } = await serve(cli, ['fail'])
    expect(exitCode).toBe(1)
    expect(output).toMatchInlineSnapshot(`
      "code: NOT_AUTHENTICATED
      message: Token not found
      hint: Set GH_TOKEN env var
      retryable: false"
    `)
  })

  test('ValidationError includes fieldErrors', async () => {
    const cli = Cli.create('test')
    cli.command('greet', {
      args: z.object({ name: z.string() }),
      run({ args }) {
        return { message: `hello ${args.name}` }
      },
    })

    const { output, exitCode } = await serve(cli, ['greet'])
    expect(exitCode).toBe(1)
    expect(output).toContain('fieldErrors')
  })

  test('supports async handlers', async () => {
    const cli = Cli.create('test')
    cli.command('async', {
      async run() {
        await new Promise((r) => setTimeout(r, 10))
        return { done: true }
      },
    })

    const { output } = await serve(cli, ['async'])
    expect(output).toMatchInlineSnapshot(`"done: true"`)
  })

  test('--format json outputs JSON data', async () => {
    const cli = Cli.create('test')
    cli.command('ping', { run: () => ({ pong: true }) })
    const { output } = await serve(cli, ['ping', '--format', 'json'])
    expect(JSON.parse(output)).toEqual({ pong: true })
  })

  test('--json is shorthand for --format json', async () => {
    const cli = Cli.create('test')
    cli.command('ping', { run: () => ({ pong: true }) })
    const { output } = await serve(cli, ['ping', '--json'])
    expect(JSON.parse(output)).toEqual({ pong: true })
  })

  test('--verbose --format json outputs full envelope as JSON', async () => {
    const cli = Cli.create('test')
    cli.command('ping', { run: () => ({ pong: true }) })
    const { output } = await serve(cli, ['ping', '--verbose', '--format', 'json'])
    const parsed = JSON.parse(output)
    expect(parsed.ok).toBe(true)
    expect(parsed.data).toEqual({ pong: true })
    expect(parsed.meta.command).toBe('ping')
  })

  test('error output respects --format json', async () => {
    const cli = Cli.create('test')
    cli.command('fail', {
      run() {
        throw new Error('boom')
      },
    })
    const { output, exitCode } = await serve(cli, ['fail', '--format', 'json'])
    expect(exitCode).toBe(1)
    const parsed = JSON.parse(output)
    expect(parsed.code).toBe('UNKNOWN')
    expect(parsed.message).toBe('boom')
  })
})

describe('--llms', () => {
  test('outputs manifest with version and commands', async () => {
    const cli = Cli.create('test')
    cli.command('ping', { description: 'Health check', run: () => ({ pong: true }) })

    const { output } = await serve(cli, ['--llms', '--format', 'json'])
    const manifest = JSON.parse(output)
    expect(manifest.version).toBe('clac.v1')
    expect(manifest.commands).toHaveLength(1)
    expect(manifest.commands[0].name).toBe('ping')
    expect(manifest.commands[0].description).toBe('Health check')
  })

  test('manifest includes schema.input from args and options', async () => {
    const cli = Cli.create('test')
    cli.command('greet', {
      args: z.object({ name: z.string() }),
      options: z.object({ loud: z.boolean().default(false) }),
      run: ({ args }) => ({ message: `hello ${args.name}` }),
    })

    const { output } = await serve(cli, ['--llms', '--format', 'json'])
    const manifest = JSON.parse(output)
    expect(manifest.commands[0].schema.input).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string' },
        loud: { type: 'boolean', default: false },
      },
      required: ['name', 'loud'],
      additionalProperties: false,
    })
  })

  test('manifest includes schema.output when defined', async () => {
    const cli = Cli.create('test')
    cli.command('greet', {
      args: z.object({ name: z.string() }),
      output: z.object({ message: z.string() }),
      run: ({ args }) => ({ message: `hello ${args.name}` }),
    })

    const { output } = await serve(cli, ['--llms', '--format', 'json'])
    const manifest = JSON.parse(output)
    expect(manifest.commands[0].schema.output).toEqual({
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
      additionalProperties: false,
    })
  })

  test('manifest omits schema when no schemas defined', async () => {
    const cli = Cli.create('test')
    cli.command('ping', { run: () => ({ pong: true }) })

    const { output } = await serve(cli, ['--llms', '--format', 'json'])
    const manifest = JSON.parse(output)
    expect(manifest.commands[0].schema).toBeUndefined()
  })

  test('manifest includes annotations when defined', async () => {
    const cli = Cli.create('test')
    cli.command('list', {
      description: 'List items',
      readOnly: true,
      openWorld: true,
      run: () => ({ items: [] }),
    })

    const { output } = await serve(cli, ['--llms', '--format', 'json'])
    const manifest = JSON.parse(output)
    expect(manifest.commands[0].annotations).toEqual({ readOnlyHint: true, openWorldHint: true })
  })

  test('manifest omits annotations when not defined', async () => {
    const cli = Cli.create('test')
    cli.command('ping', { run: () => ({ pong: true }) })

    const { output } = await serve(cli, ['--llms', '--format', 'json'])
    const manifest = JSON.parse(output)
    expect(manifest.commands[0].annotations).toBeUndefined()
  })

  test('nested commands appear with full path in manifest', async () => {
    const cli = Cli.create('test')
    const pr = Cli.command('pr', { description: 'PR management' })
    pr.command('list', {
      description: 'List PRs',
      options: z.object({ state: z.enum(['open', 'closed']).default('open') }),
      run: () => ({ items: [] }),
    })
    pr.command('create', {
      description: 'Create PR',
      args: z.object({ title: z.string() }),
      run: ({ args }) => ({ title: args.title }),
    })
    cli.command(pr)

    const { output } = await serve(cli, ['--llms', '--format', 'json'])
    const manifest = JSON.parse(output)
    expect(manifest.commands).toHaveLength(2)
    expect(manifest.commands[0].name).toBe('pr create')
    expect(manifest.commands[1].name).toBe('pr list')
  })

  test('deeply nested commands in manifest', async () => {
    const cli = Cli.create('test')
    const pr = Cli.command('pr', { description: 'PR management' })
    const review = Cli.command('review', { description: 'Reviews' })
    review.command('approve', {
      description: 'Approve a review',
      run: () => ({ approved: true }),
    })
    pr.command(review)
    cli.command(pr)

    const { output } = await serve(cli, ['--llms', '--format', 'json'])
    const manifest = JSON.parse(output)
    expect(manifest.commands[0].name).toBe('pr review approve')
    expect(manifest.commands[0].description).toBe('Approve a review')
  })

  test('defaults to TOON format', async () => {
    const cli = Cli.create('test')
    cli.command('ping', { description: 'Health check', run: () => ({ pong: true }) })

    const { output } = await serve(cli, ['--llms'])
    expect(output).toContain('version: clac.v1')
    expect(output).toContain('ping')
  })

  test('respects --format yaml', async () => {
    const cli = Cli.create('test')
    cli.command('ping', { description: 'Health check', run: () => ({ pong: true }) })

    const { output } = await serve(cli, ['--llms', '--format', 'yaml'])
    expect(output).toContain('version: clac.v1')
    expect(output).toContain('name: ping')
  })

  test('full manifest snapshot', async () => {
    const cli = Cli.create('test')
    cli.command('greet', {
      description: 'Greet someone',
      args: z.object({ name: z.string().describe('Name to greet') }),
      options: z.object({ loud: z.boolean().default(false).describe('Shout it') }),
      output: z.object({ message: z.string() }),
      readOnly: true,
      run: ({ args }) => ({ message: `hello ${args.name}` }),
    })

    const { output } = await serve(cli, ['--llms', '--format', 'json'])
    expect(JSON.parse(output)).toMatchInlineSnapshot(`
      {
        "commands": [
          {
            "annotations": {
              "readOnlyHint": true,
            },
            "description": "Greet someone",
            "name": "greet",
            "schema": {
              "input": {
                "additionalProperties": false,
                "properties": {
                  "loud": {
                    "default": false,
                    "description": "Shout it",
                    "type": "boolean",
                  },
                  "name": {
                    "description": "Name to greet",
                    "type": "string",
                  },
                },
                "required": [
                  "name",
                  "loud",
                ],
                "type": "object",
              },
              "output": {
                "additionalProperties": false,
                "properties": {
                  "message": {
                    "type": "string",
                  },
                },
                "required": [
                  "message",
                ],
                "type": "object",
              },
            },
          },
        ],
        "version": "clac.v1",
      }
    `)
  })
})

describe('subcommands', () => {
  test('creates a command group with name and description', () => {
    const pr = Cli.command('pr', { description: 'PR management' })
    expect(pr.name).toBe('pr')
    expect(pr.description).toBe('PR management')
  })

  test('group registers sub-commands and is chainable', () => {
    const pr = Cli.command('pr', { description: 'PR management' })
    const result = pr.command('list', { run: () => ({ count: 0 }) })
    expect(result).toBe(pr)
  })

  test('routes to sub-command', async () => {
    const cli = Cli.create('test')
    const pr = Cli.command('pr', { description: 'PR management' })
    pr.command('list', { run: () => ({ count: 0 }) })
    cli.command(pr)

    const { output } = await serve(cli, ['pr', 'list'])
    expect(output).toMatchInlineSnapshot(`"count: 0"`)
  })

  test('sub-command receives parsed args and options', async () => {
    const cli = Cli.create('test')
    const pr = Cli.command('pr', { description: 'PR management' })
    pr.command('get', {
      args: z.object({ id: z.string() }),
      options: z.object({ draft: z.boolean().default(false) }),
      run: ({ args, options }) => ({ id: args.id, draft: options.draft }),
    })
    cli.command(pr)

    const { output } = await serve(cli, ['pr', 'get', '42', '--draft'])
    expect(output).toMatchInlineSnapshot(`
      "id: "42"
      draft: true"
    `)
  })

  test('--verbose shows full command path in meta', async () => {
    const cli = Cli.create('test')
    const pr = Cli.command('pr', { description: 'PR management' })
    pr.command('list', { run: () => ({ count: 0 }) })
    cli.command(pr)

    const { output } = await serve(cli, ['pr', 'list', '--verbose'])
    expect(output).toMatchInlineSnapshot(`
      "ok: true
      data:
        count: 0
      meta:
        command: pr list
        duration: <stripped>"
    `)
  })

  test('routes to deeply nested sub-commands', async () => {
    const cli = Cli.create('test')
    const pr = Cli.command('pr', { description: 'PR management' })
    const review = Cli.command('review', { description: 'Reviews' })
    review.command('approve', { run: () => ({ approved: true }) })
    pr.command(review)
    cli.command(pr)

    const { output } = await serve(cli, ['pr', 'review', 'approve'])
    expect(output).toMatchInlineSnapshot(`"approved: true"`)
  })

  test('nested group shows full path in verbose meta', async () => {
    const cli = Cli.create('test')
    const pr = Cli.command('pr', { description: 'PR management' })
    const review = Cli.command('review', { description: 'Reviews' })
    review.command('approve', { run: () => ({ approved: true }) })
    pr.command(review)
    cli.command(pr)

    const { output } = await serve(cli, ['pr', 'review', 'approve', '--verbose'])
    expect(output).toMatchInlineSnapshot(`
      "ok: true
      data:
        approved: true
      meta:
        command: pr review approve
        duration: <stripped>"
    `)
  })

  test('unknown subcommand lists available commands', async () => {
    const cli = Cli.create('test')
    const pr = Cli.command('pr', { description: 'PR management' })
    pr.command('list', { run: () => ({}) })
    pr.command('create', { run: () => ({}) })
    cli.command(pr)

    const { output, exitCode } = await serve(cli, ['pr', 'unknown'])
    expect(exitCode).toBe(1)
    expect(output).toMatchInlineSnapshot(`
      "code: COMMAND_NOT_FOUND
      message: "Unknown subcommand: unknown. Available: create, list""
    `)
  })

  test('group without subcommand lists available commands', async () => {
    const cli = Cli.create('test')
    const pr = Cli.command('pr', { description: 'PR management' })
    pr.command('list', { run: () => ({}) })
    pr.command('create', { run: () => ({}) })
    cli.command(pr)

    const { output, exitCode } = await serve(cli, ['pr'])
    expect(exitCode).toBe(1)
    expect(output).toMatchInlineSnapshot(`
      "code: COMMAND_NOT_FOUND
      message: "No subcommand provided for pr. Available: create, list""
    `)
  })

  test('sub-commands from separate module can be mounted', async () => {
    function createPrCommands() {
      const pr = Cli.command('pr', { description: 'PR management' })
      pr.command('list', { run: () => ({ count: 0 }) })
      return pr
    }

    const cli = Cli.create('test')
    cli.command(createPrCommands())

    const { output } = await serve(cli, ['pr', 'list'])
    expect(output).toMatchInlineSnapshot(`"count: 0"`)
  })

  test('error in sub-command wraps in error envelope', async () => {
    const cli = Cli.create('test')
    const pr = Cli.command('pr', { description: 'PR management' })
    pr.command('fail', {
      run() {
        throw new Error('sub-boom')
      },
    })
    cli.command(pr)

    const { output, exitCode } = await serve(cli, ['pr', 'fail'])
    expect(exitCode).toBe(1)
    expect(output).toMatchInlineSnapshot(`
      "code: UNKNOWN
      message: sub-boom"
    `)
  })

  test('group error respects --format json', async () => {
    const cli = Cli.create('test')
    const pr = Cli.command('pr', { description: 'PR management' })
    pr.command('list', { run: () => ({}) })
    cli.command(pr)

    const { output, exitCode } = await serve(cli, ['pr', 'unknown', '--format', 'json'])
    expect(exitCode).toBe(1)
    const parsed = JSON.parse(output)
    expect(parsed.code).toBe('COMMAND_NOT_FOUND')
    expect(parsed.message).toContain('unknown')
  })
})

describe('cta', () => {
  test('cta populates meta.cta in verbose output', async () => {
    const cli = Cli.create('test')
    cli.command('list', {
      run: () => ({ items: ['a', 'b'] }),
      cta: () => [{ command: 'get', description: 'Get item a', args: { item: 'a' } }],
    })

    const { output } = await serve(cli, ['list', '--verbose'])
    expect(output).toMatchInlineSnapshot(`
      "ok: true
      data:
        items[2]: a,b
      meta:
        command: list
        duration: <stripped>
        cta[1]{command,description}:
          test get a,Get item a"
    `)
  })

  test('cta receives the run return value', async () => {
    const cli = Cli.create('test')
    let received: unknown
    cli.command('list', {
      run: () => ({ items: ['x', 'y'] }),
      cta(result) {
        received = result
        return []
      },
    })

    await serve(cli, ['list'])
    expect(received).toEqual({ items: ['x', 'y'] })
  })

  test('cta args are formatted as positional values', async () => {
    const cli = Cli.create('test')
    cli.command('create', {
      args: z.object({ name: z.string() }),
      output: z.object({ id: z.number(), name: z.string() }),
      run: ({ args }) => ({ id: 1, name: args.name }),
      cta: (result) => [
        { command: 'get', description: 'View the item', args: { id: result.id } },
      ],
    })

    const { output } = await serve(cli, ['create', 'foo', '--verbose', '--format', 'json'])
    const parsed = JSON.parse(output)
    expect(parsed.meta.cta).toEqual([
      { command: 'test get 1', description: 'View the item' },
    ])
  })

  test('cta options are formatted as --key value flags', async () => {
    const cli = Cli.create('test')
    cli.command('create', {
      args: z.object({ name: z.string() }),
      output: z.object({ id: z.number(), name: z.string() }),
      run: ({ args }) => ({ id: 1, name: args.name }),
      cta: (result) => [
        { command: `get ${result.id}`, description: 'View the item', options: { verbose: true } },
      ],
    })

    const { output } = await serve(cli, ['create', 'foo', '--verbose', '--format', 'json'])
    const parsed = JSON.parse(output)
    expect(parsed.meta.cta).toEqual([
      { command: 'test get 1 --verbose true', description: 'View the item' },
    ])
  })

  test('command without cta omits meta.cta', async () => {
    const cli = Cli.create('test')
    cli.command('ping', { run: () => ({ pong: true }) })

    const { output } = await serve(cli, ['ping', '--verbose', '--format', 'json'])
    const parsed = JSON.parse(output)
    expect(parsed.meta.cta).toBeUndefined()
  })

  test('cta returning empty array results in empty meta.cta', async () => {
    const cli = Cli.create('test')
    cli.command('noop', {
      run: () => ({ done: true }),
      cta: () => [],
    })

    const { output } = await serve(cli, ['noop', '--verbose', '--format', 'json'])
    const parsed = JSON.parse(output)
    expect(parsed.meta.cta).toEqual([])
  })

  test('error envelope does not include cta', async () => {
    const cli = Cli.create('test')
    cli.command('fail', {
      run() { throw new Error('boom') },
      cta: () => [{ command: 'retry' }],
    })

    const { output } = await serve(cli, ['fail', '--verbose', '--format', 'json'])
    const parsed = JSON.parse(output)
    expect(parsed.ok).toBe(false)
    expect(parsed.meta.cta).toBeUndefined()
  })

  test('cta works with sub-commands', async () => {
    const cli = Cli.create('test')
    const pr = Cli.command('pr', { description: 'PR management' })
    pr.command('create', {
      args: z.object({ title: z.string() }),
      output: z.object({ id: z.number(), title: z.string() }),
      run: ({ args }) => ({ id: 42, title: args.title }),
      cta: (result) => [
        { command: `pr get ${result.id}`, description: 'View the PR' },
      ],
    })
    cli.command(pr)

    const { output } = await serve(cli, ['pr', 'create', 'my-pr', '--verbose', '--format', 'json'])
    const parsed = JSON.parse(output)
    expect(parsed.meta.cta).toEqual([
      { command: 'test pr get 42', description: 'View the PR' },
    ])
  })
})
