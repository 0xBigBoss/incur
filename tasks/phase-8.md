# Phase 8: CTAs — Next Commands

## Design

The `cta` callback already exists on `CommandDefinition` and is fully typed (Phase 3). This phase wires it into `serve()` so the output envelope includes `meta.cta`.

### Behavior

After `run()` succeeds, if the command has a `cta` callback, call it with the return value. The resulting `Cta[]` is placed at `meta.cta` in the output envelope.

- **With `cta`** → `meta.cta` populated from callback return.
- **Without `cta`** → `meta.cta` is `[]`.
- **`cta` returns `[]`** → `meta.cta` is `[]`.
- **Error path** → `meta.cta` is not included (errors don't suggest next steps).

### Visibility

`cta` lives in `meta`, so it only appears in `--verbose` mode (full envelope) or when the consumer parses the structured output directly. In data-only mode (default), the user just sees their data.

### Output.Meta change

```ts
type Meta = {
  command: string
  duration: string
  cta: Cta[]
}
```

`cta` is always present on success envelopes (empty array when no suggestions). This keeps the shape consistent — consumers don't need to check for `undefined`.

### No new files

All changes are in `Cli.ts` and `Cli.test.ts`. The `Cta` type and `cta` callback on `CommandDefinition` already exist.

---

## TDD Cycles

### Cycle 1: `cta` populates `meta.cta` in verbose output

**Red** (`Cli.test.ts`):
```ts
test('cta populates meta.cta in verbose output', async () => {
  const cli = Cli.create('test')
  cli.command('list', {
    run: () => ({ items: ['a', 'b'] }),
    cta: () => [{ command: 'get a', description: 'Get item a' }],
  })

  const { output } = await serve(cli, ['list', '--verbose'])
  expect(output).toMatchInlineSnapshot(`
    "ok: true
    data:
      items:
        - a
        - b
    meta:
      command: list
      duration: <stripped>
      cta:
        - command: get a
          description: Get item a"
  `)
})
```

**Green**: After `command.run()` returns `data`, check if `command.cta` exists. If so, call `command.cta(data)` and attach the result to `meta.cta`. Otherwise, set `meta.cta` to `[]`.

---

### Cycle 2: `cta` receives the run return value

**Red**:
```ts
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
```

**Green**: Already works from cycle 1 — `command.cta(data)` passes the return value.

---

### Cycle 3: `cta` entries can include `args`

**Red**:
```ts
test('cta entries can include args', async () => {
  const cli = Cli.create('test')
  cli.command('create', {
    args: z.object({ name: z.string() }),
    run: ({ args }) => ({ id: 1, name: args.name }),
    cta: (result) => [
      { command: 'get', description: 'View the item', args: { id: result.id } },
    ],
  })

  const { output } = await serve(cli, ['create', 'foo', '--verbose', '--format', 'json'])
  const parsed = JSON.parse(output)
  expect(parsed.meta.cta).toEqual([
    { command: 'get', description: 'View the item', args: { id: 1 } },
  ])
})
```

**Green**: Already works — `Cta` type already has `args?: Record<string, unknown>`, and we pass through whatever the callback returns.

---

### Cycle 4: Command without `cta` has empty `meta.cta`

**Red**:
```ts
test('command without cta has empty meta.cta', async () => {
  const cli = Cli.create('test')
  cli.command('ping', { run: () => ({ pong: true }) })

  const { output } = await serve(cli, ['ping', '--verbose', '--format', 'json'])
  const parsed = JSON.parse(output)
  expect(parsed.meta.cta).toEqual([])
})
```

**Green**: Already works — fallback to `[]` when `command.cta` is undefined.

---

### Cycle 5: `cta` returning empty array

**Red**:
```ts
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
```

---

### Cycle 6: Error envelope does not include `cta`

**Red**:
```ts
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
```

**Green**: Only add `cta` to meta in the success path, not the error catch block.

---

### Cycle 7: `cta` works with sub-commands

**Red**:
```ts
test('cta works with sub-commands', async () => {
  const cli = Cli.create('test')
  const pr = Cli.command('pr', { description: 'PR management' })
  pr.command('create', {
    args: z.object({ title: z.string() }),
    run: ({ args }) => ({ id: 42, title: args.title }),
    cta: (result) => [
      { command: `pr get ${result.id}`, description: 'View the PR' },
    ],
  })
  cli.command(pr)

  const { output } = await serve(cli, ['pr', 'create', 'my-pr', '--verbose', '--format', 'json'])
  const parsed = JSON.parse(output)
  expect(parsed.meta.cta).toEqual([
    { command: 'pr get 42', description: 'View the PR' },
  ])
})
```

**Green**: Already works — routing resolves to the leaf, `cta` is called on the leaf's definition.

---

### Cycle 8: Verify all tests pass

- `pnpm test` — all pass
- `pnpm check:types` — no errors
- `pnpm check` — lint passes

---

## Files Changed

| File | Change |
|---|---|
| `Cli.ts` | Add `cta: Cta[]` to `Output.Meta`, call `command.cta(data)` in success path of `serve()`, default to `[]` |
| `Cli.test.ts` | Add `describe('cta')` with tests for population, passthrough, empty cases, error exclusion, sub-commands |
