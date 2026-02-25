import { Cli, Codegen, z } from 'clac'

describe('fromCli', () => {
  test('simple commands with args and options', () => {
    const cli = Cli.create('test')
      .command('get', {
        args: z.object({ id: z.number() }),
        run: () => ({}),
      })
      .command('list', {
        options: z.object({ limit: z.number() }),
        run: () => ({}),
      })

    expect(Codegen.fromCli(cli)).toMatchInlineSnapshot(`
      "declare module 'clac' {
        interface Register {
          commands: {
            'get': { args: { id: number }; options: {} }
            'list': { args: {}; options: { limit: number } }
          }
        }
      }
      "
    `)
  })

  test('command with no args or options', () => {
    const cli = Cli.create('test').command('ping', { run: () => ({}) })

    expect(Codegen.fromCli(cli)).toMatchInlineSnapshot(`
      "declare module 'clac' {
        interface Register {
          commands: {
            'ping': { args: {}; options: {} }
          }
        }
      }
      "
    `)
  })

  test('sub-commands use full path', () => {
    const cli = Cli.create('test')
    const pr = Cli.create('pr')
      .command('list', {
        options: z.object({ state: z.string() }),
        run: () => ({}),
      })
      .command('create', {
        args: z.object({ title: z.string() }),
        run: () => ({}),
      })
    cli.command(pr)

    expect(Codegen.fromCli(cli)).toMatchInlineSnapshot(`
      "declare module 'clac' {
        interface Register {
          commands: {
            'pr create': { args: { title: string }; options: {} }
            'pr list': { args: {}; options: { state: string } }
          }
        }
      }
      "
    `)
  })

  test('deeply nested sub-commands', () => {
    const cli = Cli.create('test')
    const review = Cli.create('review').command('approve', {
      args: z.object({ id: z.number() }),
      run: () => ({}),
    })
    const pr = Cli.create('pr')
    pr.command(review)
    cli.command(pr)

    expect(Codegen.fromCli(cli)).toMatchInlineSnapshot(`
      "declare module 'clac' {
        interface Register {
          commands: {
            'pr review approve': { args: { id: number }; options: {} }
          }
        }
      }
      "
    `)
  })

  test('enum types fromCli union of literals', () => {
    const cli = Cli.create('test').command('list', {
      options: z.object({ state: z.enum(['open', 'closed', 'merged']) }),
      run: () => ({}),
    })

    const output = Codegen.fromCli(cli)
    expect(output).toContain('"open" | "closed" | "merged"')
  })

  test('boolean types', () => {
    const cli = Cli.create('test').command('list', {
      options: z.object({ verbose: z.boolean() }),
      run: () => ({}),
    })

    const output = Codegen.fromCli(cli)
    expect(output).toContain('verbose: boolean')
  })

  test('array types', () => {
    const cli = Cli.create('test').command('list', {
      options: z.object({ tags: z.array(z.string()) }),
      run: () => ({}),
    })

    const output = Codegen.fromCli(cli)
    expect(output).toContain('tags: string[]')
  })

  test('commands are sorted alphabetically', () => {
    const cli = Cli.create('test')
      .command('zebra', { run: () => ({}) })
      .command('alpha', { run: () => ({}) })
      .command('middle', { run: () => ({}) })

    const output = Codegen.fromCli(cli)
    const commandOrder = [...output.matchAll(/^ {6}'(\w+)':/gm)].map((m) => m[1])
    expect(commandOrder).toEqual(['alpha', 'middle', 'zebra'])
  })

  test('mixed top-level and grouped commands', () => {
    const cli = Cli.create('test')
    cli.command('ping', { run: () => ({}) })
    const pr = Cli.create('pr').command('list', { run: () => ({}) })
    cli.command(pr)

    expect(Codegen.fromCli(cli)).toMatchInlineSnapshot(`
      "declare module 'clac' {
        interface Register {
          commands: {
            'ping': { args: {}; options: {} }
            'pr list': { args: {}; options: {} }
          }
        }
      }
      "
    `)
  })
})
