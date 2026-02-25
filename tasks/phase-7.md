# Phase 7: Schema — JSON Schema Generation & `--llms` Manifest

## Design

### Schema module

Thin wrapper around Zod v4's built-in `z.toJSONSchema()`. Strips the `$schema` meta-property (noisy — we embed schemas inside a manifest, not as standalone JSON Schema documents). Keeps everything else (`additionalProperties`, `default`, `description`, etc.) intact.

```ts
import { Schema, z } from 'clac'

Schema.toJsonSchema(z.string())
// → { type: 'string' }

Schema.toJsonSchema(z.object({
  name: z.string().describe('User name'),
  age: z.number().optional(),
}))
// → { type: 'object', properties: { name: { type: 'string', description: 'User name' }, age: { type: 'number' } }, required: ['name'], additionalProperties: false }
```

**No `zod-to-json-schema` dependency needed** — Zod v4 includes `z.toJSONSchema()` natively.

### `--llms` manifest

New built-in flag extracted in `extractBuiltinFlags()` alongside `--verbose`, `--format`, `--json`. When set, `serve()` short-circuits before command resolution and outputs the manifest to stdout.

Manifest shape:

```yaml
version: clac.v1
commands:
  - name: greet
    description: Greet someone
    schema:
      input:
        type: object
        properties:
          name:
            type: string
        required:
          - name
        additionalProperties: false
      output:
        type: object
        properties:
          message:
            type: string
        required:
          - message
        additionalProperties: false
    annotations:
      readOnlyHint: true
```

### Manifest rules

- **Input schema** — merged `args` + `options` schemas into a single `z.object({ ...args.shape, ...options.shape })`. Omit `schema.input` if neither is defined. If only one exists, use it.
- **Output schema** — from `output` property. Omit `schema.output` if not defined.
- **`schema` key** — omitted entirely if neither `input` nor `output` schemas are defined.
- **Annotations** — added as an optional property on `CommandDefinition`. Omitted from manifest entry if not provided.
- **Nested commands** — appear with full space-delimited path (e.g. `pr list`). Groups themselves don't appear — only leaf commands with `run` handlers.
- **Command order** — sorted alphabetically by full path for deterministic output.
- **Format** — respects `--format` flag. Default is TOON.
- **No envelope wrapping** — `--llms` outputs the raw manifest object. `--verbose` is ignored.

### Annotations type

MCP-style tool annotations on `CommandDefinition`:

```ts
type Annotations = {
  title?: string | undefined
  readOnlyHint?: boolean | undefined
  destructiveHint?: boolean | undefined
  idempotentHint?: boolean | undefined
  openWorldHint?: boolean | undefined
}
```

### Deferred

- **Skill files (Markdown generation from `--llms --format md`)** — deferred to Phase 9.

---

## TDD Cycles

### Cycle 1: `toJsonSchema` converts `z.string()`

**Red** (`Schema.test.ts`):
```ts
test('converts z.string()', () => {
  expect(Schema.toJsonSchema(z.string())).toEqual({ type: 'string' })
})
```

**Green**: Implement `toJsonSchema()` wrapping `z.toJSONSchema()`, stripping `$schema`.

---

### Cycle 2: `toJsonSchema` converts `z.number()` and `z.boolean()`

**Red**:
```ts
test('converts z.number()', () => {
  expect(Schema.toJsonSchema(z.number())).toEqual({ type: 'number' })
})

test('converts z.boolean()', () => {
  expect(Schema.toJsonSchema(z.boolean())).toEqual({ type: 'boolean' })
})
```

**Green**: Already works from cycle 1 implementation.

---

### Cycle 3: `toJsonSchema` converts `z.enum()`

**Red**:
```ts
test('converts z.enum()', () => {
  expect(Schema.toJsonSchema(z.enum(['open', 'closed']))).toEqual({
    type: 'string',
    enum: ['open', 'closed'],
  })
})
```

---

### Cycle 4: `toJsonSchema` converts `z.array()`

**Red**:
```ts
test('converts z.array()', () => {
  expect(Schema.toJsonSchema(z.array(z.string()))).toEqual({
    type: 'array',
    items: { type: 'string' },
  })
})
```

---

### Cycle 5: `toJsonSchema` converts `z.object()` with required fields

**Red**:
```ts
test('converts z.object() with required fields', () => {
  expect(Schema.toJsonSchema(z.object({ name: z.string(), count: z.number() }))).toEqual({
    type: 'object',
    properties: {
      name: { type: 'string' },
      count: { type: 'number' },
    },
    required: ['name', 'count'],
    additionalProperties: false,
  })
})
```

---

### Cycle 6: `.optional()` removes from required

**Red**:
```ts
test('.optional() removes from required', () => {
  expect(Schema.toJsonSchema(z.object({
    name: z.string(),
    age: z.number().optional(),
  }))).toEqual({
    type: 'object',
    properties: {
      name: { type: 'string' },
      age: { type: 'number' },
    },
    required: ['name'],
    additionalProperties: false,
  })
})
```

---

### Cycle 7: `.default()` adds default value

**Red**:
```ts
test('.default() adds default to schema', () => {
  const result = Schema.toJsonSchema(z.object({
    state: z.enum(['open', 'closed']).default('open'),
  }))
  expect(result).toMatchObject({
    properties: {
      state: { type: 'string', enum: ['open', 'closed'], default: 'open' },
    },
  })
})
```

---

### Cycle 8: `.describe()` adds description

**Red**:
```ts
test('.describe() adds description', () => {
  const result = Schema.toJsonSchema(z.object({
    name: z.string().describe('The user name'),
  }))
  expect(result).toMatchObject({
    properties: {
      name: { type: 'string', description: 'The user name' },
    },
  })
})
```

---

### Cycle 9: Full object with optional, default, and describe

**Red**:
```ts
test('full object with optional, default, and describe', () => {
  const result = Schema.toJsonSchema(
    z.object({
      name: z.string().describe('User name'),
      state: z.enum(['open', 'closed']).default('open').describe('Filter state'),
      limit: z.number().optional().describe('Max items'),
    }),
  )
  expect(result).toMatchInlineSnapshot(`
    {
      "additionalProperties": false,
      "properties": {
        "limit": {
          "description": "Max items",
          "type": "number",
        },
        "name": {
          "description": "User name",
          "type": "string",
        },
        "state": {
          "default": "open",
          "description": "Filter state",
          "enum": [
            "open",
            "closed",
          ],
          "type": "string",
        },
      },
      "required": [
        "name",
        "state",
      ],
      "type": "object",
    }
  `)
})
```

---

### Cycle 10: `--llms` outputs manifest with version and commands

**Red** (`Cli.test.ts`):
```ts
test('--llms outputs manifest with version and commands', async () => {
  const cli = Cli.create('test')
  cli.command('ping', { description: 'Health check', run: () => ({ pong: true }) })

  const { output } = await serve(cli, ['--llms', '--format', 'json'])
  const manifest = JSON.parse(output)
  expect(manifest.version).toBe('clac.v1')
  expect(manifest.commands).toHaveLength(1)
  expect(manifest.commands[0].name).toBe('ping')
  expect(manifest.commands[0].description).toBe('Health check')
})
```

**Green**:
- Extract `--llms` in `extractBuiltinFlags()`.
- In `serve()`, short-circuit when `llms` is true.
- Walk command tree, collect leaf entries with full paths.
- Build manifest: `{ version: 'clac.v1', commands: [...] }`.
- Format and write to stdout.

---

### Cycle 11: Manifest includes `schema.input` from merged args + options

**Red**:
```ts
test('manifest includes schema.input from args and options', async () => {
  const cli = Cli.create('test')
  cli.command('greet', {
    args: z.object({ name: z.string() }),
    options: z.object({ loud: z.boolean().default(false) }),
    run: ({ args }) => ({ message: `hello ${args.name}` }),
  })

  const { output } = await serve(cli, ['--llms', '--format', 'json'])
  const manifest = JSON.parse(output)
  const cmd = manifest.commands[0]
  expect(cmd.schema.input).toEqual({
    type: 'object',
    properties: {
      name: { type: 'string' },
      loud: { type: 'boolean', default: false },
    },
    required: ['name'],
    additionalProperties: false,
  })
})
```

**Green**: Merge `args.shape` + `options.shape` into a single `z.object()`, convert via `Schema.toJsonSchema()`.

---

### Cycle 12: Manifest includes `schema.output`

**Red**:
```ts
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
```

---

### Cycle 13: Manifest omits schema when no schemas defined

**Red**:
```ts
test('manifest omits schema when no schemas defined', async () => {
  const cli = Cli.create('test')
  cli.command('ping', { run: () => ({ pong: true }) })

  const { output } = await serve(cli, ['--llms', '--format', 'json'])
  const manifest = JSON.parse(output)
  expect(manifest.commands[0].schema).toBeUndefined()
})
```

---

### Cycle 14: Manifest includes annotations

**Red**:
```ts
test('manifest includes annotations when defined', async () => {
  const cli = Cli.create('test')
  cli.command('list', {
    description: 'List items',
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: () => ({ items: [] }),
  })

  const { output } = await serve(cli, ['--llms', '--format', 'json'])
  const manifest = JSON.parse(output)
  expect(manifest.commands[0].annotations).toEqual({ readOnlyHint: true, openWorldHint: true })
})
```

**Green**: Add `annotations` property to `CommandDefinition` type. Add `Annotations` type. Pass through to manifest entry.

---

### Cycle 15: Manifest omits annotations when not defined

**Red**:
```ts
test('manifest omits annotations when not defined', async () => {
  const cli = Cli.create('test')
  cli.command('ping', { run: () => ({ pong: true }) })

  const { output } = await serve(cli, ['--llms', '--format', 'json'])
  const manifest = JSON.parse(output)
  expect(manifest.commands[0].annotations).toBeUndefined()
})
```

---

### Cycle 16: Nested group commands appear with full path

**Red**:
```ts
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
```

**Green**: Walk command tree recursively via `collectCommands()`, building full path for each leaf. Sort alphabetically.

---

### Cycle 17: Deeply nested commands in manifest

**Red**:
```ts
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
```

---

### Cycle 18: `--llms` defaults to TOON format

**Red**:
```ts
test('--llms defaults to TOON format', async () => {
  const cli = Cli.create('test')
  cli.command('ping', { description: 'Health check', run: () => ({ pong: true }) })

  const { output } = await serve(cli, ['--llms'])
  expect(output).toContain('version: clac.v1')
  expect(output).toContain('name: ping')
})
```

---

### Cycle 19: `--llms` respects `--format yaml`

**Red**:
```ts
test('--llms respects --format yaml', async () => {
  const cli = Cli.create('test')
  cli.command('ping', { description: 'Health check', run: () => ({ pong: true }) })

  const { output } = await serve(cli, ['--llms', '--format', 'yaml'])
  expect(output).toContain('version: clac.v1')
  expect(output).toContain('name: ping')
})
```

---

### Cycle 20: Full manifest snapshot

**Red**:
```ts
test('full manifest snapshot', async () => {
  const cli = Cli.create('test')
  cli.command('greet', {
    description: 'Greet someone',
    args: z.object({ name: z.string().describe('Name to greet') }),
    options: z.object({ loud: z.boolean().default(false).describe('Shout it') }),
    output: z.object({ message: z.string() }),
    annotations: { readOnlyHint: true },
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
```

---

### Cycle 21: Verify all tests pass

- `pnpm test` — all pass
- `pnpm check:types` — no errors
- `pnpm check` — lint passes

---

## Files Changed

| File | Change |
|---|---|
| `Schema.ts` | Implement `toJsonSchema()` wrapping `z.toJSONSchema()`, stripping `$schema` |
| `Schema.test.ts` | **New** — tests for schema conversion (cycles 1–9) |
| `Cli.ts` | Add `Annotations` type, add `annotations` to `CommandDefinition`, extract `--llms` flag in `extractBuiltinFlags()`, add `collectCommands()` tree walker, add manifest generation short-circuit in `serve()` |
| `Cli.test.ts` | Add `describe('--llms')` with manifest tests (cycles 10–20) |
