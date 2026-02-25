# Phase 1: Tracer Bullet — Minimal CLI

**Goal:** Prove the full path: `Cli.create()` → `.command()` → `.serve()` → parse argv → run handler → output TOON envelope on stdout.

**Scope boundary:** Inline arg parsing only (positional args by schema key order, no `--flags`, no aliases). No error classes yet — just raw `Error` throws. No `--format` flag — TOON only. No subcommands. No `next`. These all come in later phases.

---

## API Surface (this phase only)

```ts
// Cli.create — factory, returns a cli instance
export function create(name: string, options: create.Options = {}): create.ReturnType

export declare namespace create {
  type Options = {
    version?: string | undefined
    description?: string | undefined
  }
  type ReturnType = Cli
}

// Cli instance (internal, returned by create)
type Cli = {
  readonly name: string
  command(name: string, definition: CommandDefinition): Cli  // chainable
  serve(argv?: string[]): Promise<void>
}

// CommandDefinition shape (minimal for phase 1)
type CommandDefinition = {
  description?: string | undefined
  args?: z.ZodObject<any> | undefined
  options?: z.ZodObject<any> | undefined
  output?: z.ZodObject<any> | undefined
  run: (context: { args: inferred; options: inferred }) => unknown | Promise<unknown>
}
```

## serve() contract

- `serve(argv?)` — if `argv` omitted, reads from `process.argv.slice(2)`
- First token is the command name
- Remaining tokens are positional args, assigned to schema keys in order
- On success: writes TOON envelope `{ ok: true, data, meta }` to stdout, exits 0
- On unknown command: writes TOON error envelope to stdout, exits 1
- On handler error: writes TOON error envelope to stdout, exits 1
- `meta` includes `{ command: string, duration: string }`

## Envelope shape

```ts
// Success
{ ok: true, data: <handler return value>, meta: { command: string, duration: string } }

// Error
{ ok: false, error: { code: string, message: string }, meta: { command: string, duration: string } }
```

## TOON serialization

Use `encode()` from `@toon-format/toon`. Import: `import { encode } from '@toon-format/toon'`.

---

## TDD Cycles

Each cycle: write test → watch it fail → implement → green → refactor.

### 1. `Cli.create('test')` returns a cli instance with `name`

```ts
test('returns cli instance with name', () => {
  const cli = Cli.create('test')
  expect(cli.name).toBe('test')
})
```

Implementation: `create()` function returning `{ name }` object.

---

### 2. `Cli.create('test', { version, description })` accepts options

```ts
test('accepts version and description options', () => {
  const cli = Cli.create('test', { version: '1.0.0', description: 'A test CLI' })
  expect(cli.name).toBe('test')
})
```

Implementation: accept second arg, store internally. No public accessor needed yet — just prove it doesn't throw.

---

### 3. `cli.command('hello', { ... })` registers a command

```ts
test('registers a command', () => {
  const cli = Cli.create('test')
  const result = cli.command('greet', {
    args: z.object({ name: z.string() }),
    run({ args }) { return { message: `hello ${args.name}` } },
  })
  expect(result).toBe(cli) // chainable
})
```

Implementation: internal `Map<string, CommandDefinition>`, `.command()` stores and returns `this`.

---

### 4. `cli.serve(['greet', 'world'])` routes to the correct handler

Need to capture stdout. Use a `write` option on `serve()` for testability (or spy on `process.stdout.write`).

**Decision:** `serve()` accepts an options bag `{ argv?, stdout?, exit? }` for DI in tests. Public signature:

```ts
serve(argv?: string[], options?: { stdout?: (str: string) => void; exit?: (code: number) => void }): Promise<void>
```

```ts
test('routes to correct command handler', async () => {
  const cli = Cli.create('test')
  cli.command('greet', {
    args: z.object({ name: z.string() }),
    run({ args }) { return { message: `hello ${args.name}` } },
  })

  let output = ''
  await cli.serve(['greet', 'world'], {
    stdout(s) { output += s },
    exit() {},
  })

  const result = decode(output)
  expect(result).toMatchObject({ ok: true, data: { message: 'hello world' } })
})
```

Implementation: look up command by first argv token, call `run()`, write output.

---

### 5. Handler receives parsed `args` from Zod schema

```ts
test('parses positional args by schema key order', async () => {
  const cli = Cli.create('test')
  let receivedArgs: any
  cli.command('add', {
    args: z.object({ a: z.string(), b: z.string() }),
    run({ args }) { receivedArgs = args; return {} },
  })

  await cli.serve(['add', 'foo', 'bar'], { stdout() {}, exit() {} })
  expect(receivedArgs).toEqual({ a: 'foo', b: 'bar' })
})
```

Implementation: zip argv tokens with `Object.keys(argsSchema.shape)`.

---

### 6. Output is wrapped in envelope with `ok`, `data`, `meta`

```ts
test('wraps output in success envelope', async () => {
  const cli = Cli.create('test')
  cli.command('greet', {
    args: z.object({ name: z.string() }),
    run({ args }) { return { message: `hello ${args.name}` } },
  })

  let output = ''
  await cli.serve(['greet', 'world'], {
    stdout(s) { output += s },
    exit() {},
  })

  const result = decode(output)
  expect(result).toMatchObject({
    ok: true,
    data: { message: 'hello world' },
    meta: { command: 'greet' },
  })
  expect(result.meta.duration).toMatch(/\d+ms/)
})
```

Implementation: wrap handler return in `{ ok: true, data, meta: { command, duration } }`.

---

### 7. Output is serialized as TOON to stdout

```ts
test('serializes output as TOON', async () => {
  const cli = Cli.create('test')
  cli.command('ping', {
    run() { return { pong: true } },
  })

  let output = ''
  await cli.serve(['ping'], {
    stdout(s) { output += s },
    exit() {},
  })

  // TOON is not JSON — should not parse as JSON
  expect(() => JSON.parse(output)).toThrow()
  // But should decode via TOON
  expect(decode(output)).toMatchObject({ ok: true, data: { pong: true } })
})
```

Implementation: `encode()` from `@toon-format/toon`.

---

### 8. Error envelope when command not found

```ts
test('outputs error envelope for unknown command', async () => {
  const cli = Cli.create('test')

  let output = ''
  let exitCode: number | undefined
  await cli.serve(['nonexistent'], {
    stdout(s) { output += s },
    exit(code) { exitCode = code },
  })

  const result = decode(output)
  expect(result).toMatchObject({
    ok: false,
    error: { code: 'COMMAND_NOT_FOUND', message: expect.stringContaining('nonexistent') },
  })
  expect(exitCode).toBe(1)
})
```

---

### 9. Error envelope when handler throws

```ts
test('wraps handler errors in error envelope', async () => {
  const cli = Cli.create('test')
  cli.command('fail', {
    run() { throw new Error('boom') },
  })

  let output = ''
  let exitCode: number | undefined
  await cli.serve(['fail'], {
    stdout(s) { output += s },
    exit(code) { exitCode = code },
  })

  const result = decode(output)
  expect(result).toMatchObject({
    ok: false,
    error: { code: 'UNKNOWN', message: 'boom' },
  })
  expect(exitCode).toBe(1)
})
```

---

### 10. Async handlers work

```ts
test('supports async handlers', async () => {
  const cli = Cli.create('test')
  cli.command('async', {
    async run() {
      await new Promise((r) => setTimeout(r, 10))
      return { done: true }
    },
  })

  let output = ''
  await cli.serve(['async'], {
    stdout(s) { output += s },
    exit() {},
  })

  expect(decode(output)).toMatchObject({ ok: true, data: { done: true } })
})
```

---

## Files Modified

- `src/Cli.ts` — implement `create()`, command registration, `serve()`
- `src/Cli.test.ts` — all tests above

## Not In Scope

- `--format` flag (Phase 4)
- `--flags` / aliases / boolean flags (Phase 2 — Parser)
- Error classes (Phase 3 — Errors)
- Subcommands / groups (Phase 5)
- `next` / CTAs (Phase 7)
- `--llms` manifest (Phase 6)
- Type tests (Phase 9)

## Done When

- All 10 tests pass
- `pnpm check:types` clean
- `pnpm check` clean
- `Cli.create()` → `.command()` → `.serve()` → TOON on stdout works end-to-end
