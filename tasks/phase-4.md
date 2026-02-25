# Phase 4: Errors — Structured Error Handling

## Design (inspired by Ox's BaseError)

Ox uses a `BaseError<cause>` with `shortMessage` + `details` extracted from cause chain, `override name = 'Module.ErrorName'` convention, `walk()` for cause traversal, and `ErrorType` declarations co-located with functions.

For clac, we adapt this pattern but keep it simpler — no `docsPath`/`version`/`metaMessages` (not needed for CLI errors). We add CLI-specific properties: `code`, `hint`, `retryable`, `fieldErrors`.

### Error hierarchy

```
Error (native)
  └── BaseError — shortMessage, details, walk()
        ├── ClacError — code, hint, retryable
        ├── ValidationError — fieldErrors[]
        └── ParseError — argument parsing failures
```

### Naming convention

`override name = 'Clac.ErrorName'`:

| Class | `name` |
|---|---|
| `BaseError` | `'Clac.BaseError'` |
| `ClacError` | `'Clac.ClacError'` |
| `ValidationError` | `'Clac.ValidationError'` |
| `ParseError` | `'Clac.ParseError'` |

### Target API

```ts
import { Errors } from 'clac'

// General structured error
throw new Errors.ClacError({
  code: 'NOT_AUTHENTICATED',
  message: 'GitHub token not found',
  hint: 'Pass --token or set GH_TOKEN environment variable',
  retryable: false,
})

// Validation error with field details
throw new Errors.ValidationError({
  message: 'Invalid arguments',
  fieldErrors: [
    { path: 'state', expected: 'open | closed', received: 'invalid', message: 'Invalid enum value' },
  ],
})

// Parse error
throw new Errors.ParseError({ message: 'Unknown flag: --foo' })

// Cause chain walking
error.walk() // returns deepest cause
error.walk((err) => err instanceof Errors.ClacError) // find first ClacError in chain
```

---

## TDD Cycles

### Cycle 1: `BaseError` — extends Error, sets name

**Red** (`Errors.test.ts`):
```ts
test('BaseError extends Error and sets name', () => {
  const error = new Errors.BaseError('something went wrong')
  expect(error).toBeInstanceOf(Error)
  expect(error.name).toBe('Clac.BaseError')
  expect(error.shortMessage).toBe('something went wrong')
  expect(error.message).toBe('something went wrong')
})
```

**Green**: Implement `BaseError` class with `override name`, `shortMessage`.

---

### Cycle 2: `BaseError` — extracts details from cause

**Red**:
```ts
test('extracts details from cause', () => {
  const cause = new Error('connection refused')
  const error = new Errors.BaseError('request failed', { cause })
  expect(error.details).toBe('connection refused')
  expect(error.message).toMatchInlineSnapshot(`
    "request failed

    Details: connection refused"
  `)
})
```

**Green**: Constructor logic that unwraps `cause.message` → `details`, assembles multi-line `message`.

---

### Cycle 3: `BaseError` — walk() traverses cause chain

**Red**:
```ts
test('walk() returns deepest cause', () => {
  const inner = new Error('root cause')
  const middle = new Errors.BaseError('mid', { cause: inner })
  const outer = new Errors.BaseError('top', { cause: middle })
  expect(outer.walk()).toBe(inner)
})

test('walk(fn) returns first matching cause', () => {
  const inner = new Errors.ClacError({ code: 'FOO', message: 'foo' })
  const outer = new Errors.BaseError('top', { cause: inner })
  expect(outer.walk((e) => e instanceof Errors.ClacError)).toBe(inner)
})
```

**Green**: Implement recursive `walk()`.

---

### Cycle 4: `ClacError` — code, hint, retryable

**Red**:
```ts
test('ClacError has code, hint, retryable', () => {
  const error = new Errors.ClacError({
    code: 'NOT_AUTHENTICATED',
    message: 'Token not found',
    hint: 'Set GH_TOKEN env var',
    retryable: false,
  })
  expect(error.name).toBe('Clac.ClacError')
  expect(error.code).toBe('NOT_AUTHENTICATED')
  expect(error.hint).toBe('Set GH_TOKEN env var')
  expect(error.retryable).toBe(false)
  expect(error).toBeInstanceOf(Errors.BaseError)
})

test('ClacError defaults retryable to false', () => {
  const error = new Errors.ClacError({ code: 'FAIL', message: 'fail' })
  expect(error.retryable).toBe(false)
})
```

---

### Cycle 5: `ValidationError` — fieldErrors

**Red**:
```ts
test('ValidationError has fieldErrors', () => {
  const error = new Errors.ValidationError({
    message: 'Invalid arguments',
    fieldErrors: [
      { path: 'state', expected: 'open | closed', received: 'invalid', message: 'Invalid enum value' },
    ],
  })
  expect(error.name).toBe('Clac.ValidationError')
  expect(error.fieldErrors).toEqual([
    { path: 'state', expected: 'open | closed', received: 'invalid', message: 'Invalid enum value' },
  ])
  expect(error).toBeInstanceOf(Errors.BaseError)
})
```

---

### Cycle 6: `ParseError`

**Red**:
```ts
test('ParseError sets name', () => {
  const error = new Errors.ParseError({ message: 'Unknown flag: --foo' })
  expect(error.name).toBe('Clac.ParseError')
  expect(error.shortMessage).toBe('Unknown flag: --foo')
  expect(error).toBeInstanceOf(Errors.BaseError)
})
```

---

### Cycle 7: Wire Parser.ts — throw ParseError/ValidationError

**Red** (`Parser.test.ts` — update existing throw tests):
```ts
test('throws ParseError on unknown flags', () => {
  expect(() =>
    Parser.parse(['--unknown', 'val'], {
      options: z.object({ state: z.string() }),
    }),
  ).toThrow(expect.objectContaining({ name: 'Clac.ParseError' }))
})

test('throws ValidationError on missing required args', () => {
  expect(() =>
    Parser.parse([], {
      args: z.object({ name: z.string() }),
    }),
  ).toThrow(expect.objectContaining({ name: 'Clac.ValidationError' }))
})
```

**Green**: Update `Parser.ts` to throw `ParseError` for unknown flags / missing values, and catch Zod errors → wrap as `ValidationError` with `fieldErrors`.

---

### Cycle 8: Wire Cli.ts — ClacError in run → error envelope

**Red** (`Cli.test.ts`):
```ts
test('ClacError in run() populates code/hint/retryable in envelope', async () => {
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
  // snapshot includes code, hint, retryable in error block
})
```

**Green**: Update `Cli.ts` catch block to detect `ClacError` → propagate `code`, `hint`, `retryable` to envelope.

---

### Cycle 9: Wire Cli.ts — ValidationError → fieldErrors in envelope

**Red** (`Cli.test.ts`):
```ts
test('Zod validation failure includes fieldErrors in envelope', async () => {
  const cli = Cli.create('test')
  cli.command('greet', {
    args: z.object({ name: z.string() }),
    run({ args }) {
      return { message: `hello ${args.name}` }
    },
  })
  const { output, exitCode } = await serve(cli, ['greet'])
  expect(exitCode).toBe(1)
  // snapshot includes fieldErrors array
})
```

**Green**: `Cli.ts` catch detects `ValidationError` → includes `fieldErrors` in error envelope.

---

### Cycle 10: Verify all tests pass

- `pnpm test` — all pass
- `pnpm check:types` — no errors
- `pnpm check` — lint passes

---

## Files Changed

| File | Change |
|---|---|
| `Errors.ts` | Implement `BaseError`, `ClacError`, `ValidationError`, `ParseError` |
| `Errors.test.ts` | **New** — tests for all error classes |
| `Parser.ts` | Throw `ParseError` / `ValidationError` instead of plain `Error` |
| `Parser.test.ts` | Update throw assertions to check error names |
| `Cli.ts` | Detect error types in catch → populate envelope with code/hint/retryable/fieldErrors |
| `Cli.test.ts` | Add tests for structured error envelopes |
