import { Cli, z } from 'clac'
import { expectTypeOf, test } from 'vitest'

test('args in run() infers from args schema', () => {
  const cli = Cli.create('test')
  cli.command('greet', {
    args: z.object({ name: z.string() }),
    run({ args }) {
      expectTypeOf(args).toEqualTypeOf<{ name: string }>()
      return {}
    },
  })
})

test('options in run() infers from options schema', () => {
  const cli = Cli.create('test')
  cli.command('list', {
    options: z.object({
      state: z.enum(['open', 'closed']).default('open'),
      limit: z.number().default(30),
    }),
    run({ options }) {
      expectTypeOf(options).toEqualTypeOf<{ state: 'open' | 'closed'; limit: number }>()
      return {}
    },
  })
})

test('without schemas, run receives empty objects', () => {
  const cli = Cli.create('test')
  cli.command('ping', {
    run({ args, options }) {
      expectTypeOf(args).toEqualTypeOf<{}>()
      expectTypeOf(options).toEqualTypeOf<{}>()
      return { pong: true }
    },
  })
})

test('output constrains run return type', () => {
  const cli = Cli.create('test')
  cli.command('greet', {
    output: z.object({ message: z.string() }),
    run() {
      return { message: 'hello' }
    },
  })

  cli.command('greet', {
    output: z.object({ message: z.string() }),
    // @ts-expect-error — return doesn't match output schema
    run() {
      return { wrong: 123 }
    },
  })
})

test('alias keys are constrained to option keys', () => {
  const cli = Cli.create('test')
  cli.command('list', {
    options: z.object({ state: z.string(), limit: z.number() }),
    alias: { state: 's', limit: 'l' },
    run: () => ({}),
  })

  cli.command('list', {
    options: z.object({ state: z.string() }),
    // @ts-expect-error — 'foo' is not an option key
    alias: { foo: 'f' },
    run: () => ({}),
  })
})

test('cta callback receives typed result from output', () => {
  const cli = Cli.create('test')
  cli.command('list', {
    output: z.object({ items: z.array(z.string()) }),
    run: () => ({ items: ['a', 'b'] }),
    cta(result) {
      expectTypeOf(result).toEqualTypeOf<{ items: string[] }>()
      return []
    },
  })
})

test('Cta falls back to plain strings when commands map is empty', () => {
  type Cta = Cli.Cta<{}>
  expectTypeOf<Cta['command']>().toEqualTypeOf<string>()
  expectTypeOf<Cta['args']>().toEqualTypeOf<Record<string, unknown> | undefined>()
  expectTypeOf<Cta['options']>().toEqualTypeOf<Record<string, unknown> | undefined>()
})

test('Cta narrows command to registered keys', () => {
  type Commands = {
    get: { args: { id: number }; options: {} }
    list: { args: {}; options: { limit: number } }
  }
  type Cta = Cli.Cta<Commands>

  expectTypeOf<Cta>().toMatchTypeOf<{ command: 'get' } | { command: 'list' }>()

  // args are narrowed per command
  const getCta: Extract<Cta, { command: 'get' }> = { command: 'get', args: { id: 42 } }
  expectTypeOf(getCta.args).toEqualTypeOf<{ id?: number | true } | undefined>()

  // options are narrowed per command
  const listCta: Extract<Cta, { command: 'list' }> = { command: 'list', options: { limit: 10 } }
  expectTypeOf(listCta.options).toEqualTypeOf<{ limit?: number | true } | undefined>()
})

test('command() accumulates command types through chaining', () => {
  const cli = Cli.create('test')
    .command('get', {
      args: z.object({ id: z.number() }),
      options: z.object({ verbose: z.boolean().default(false) }),
      run: ({ args }) => ({ id: args.id }),
    })
    .command('list', {
      options: z.object({ limit: z.number().default(30) }),
      run: () => ({ items: [] }),
    })

  type Commands = typeof cli extends Cli.Cli<infer C> ? C : never
  expectTypeOf<Commands['get']>().toEqualTypeOf<{
    args: { id: number }
    options: { verbose: boolean }
  }>()
  expectTypeOf<Commands['list']>().toEqualTypeOf<{ args: {}; options: { limit: number } }>()
})
