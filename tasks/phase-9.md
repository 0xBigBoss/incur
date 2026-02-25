# Phase 9: Skill Files — Markdown Generation

## Design

Generate Markdown skill files from command definitions. A skill file is a self-contained document describing one command — arguments, options, output schema, annotations, and CTAs — in a format agents can consume as context.

### API

`Skill.generate(cli)` takes a CLI name + collected command data and returns a concatenated Markdown string of all commands. Each command section has YAML frontmatter and structured sections.

### Output Format

Per command:

```markdown
---
title: "gh pr list"
description: "List pull requests"
command: "gh pr list"
annotations:
  readOnlyHint: true
---

# gh pr list

List pull requests from a GitHub repository.

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| repo | string | no | Repository in owner/repo format |

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| --state | string | open | Filter by state |
| --limit | number | 30 | Max PRs to return |

## Output

```json
{ "type": "object", "properties": { ... } }
```

## Next Commands

- `gh pr view --number <number>` — View details of a PR
```

### Sections are conditional

- **Arguments** — only if `args` schema exists
- **Options** — only if `options` schema exists
- **Output** — only if `output` schema exists
- **Next Commands** — only if `cta` callback exists (show as static examples)
- **Annotations** — only if any annotations are set

### Integration with `--llms --format md`

`Cli.serve(['--llms', '--format', 'md'])` calls `Skill.generate()` instead of the generic formatter. This overrides the normal `--format md` path specifically for `--llms`.

### No new dependencies

Uses the existing `Schema.toJsonSchema()` for output schema rendering and Zod introspection for args/options tables.

---

## TDD Cycles

### Cycle 1: Minimal skill file with title and description

**Red** (`Skill.test.ts`):
```ts
test('generates skill file with frontmatter and heading', () => {
  const result = Skill.generate('test', [
    { name: 'ping', description: 'Health check' },
  ])
  expect(result).toMatchInlineSnapshot(`
    "---
    title: test ping
    description: Health check
    command: test ping
    ---

    # test ping

    Health check"
  `)
})
```

**Green**: Build the basic `generate()` function that iterates commands and produces frontmatter + heading.

---

### Cycle 2: Arguments table from input schema

**Red**:
```ts
test('includes arguments table', () => {
  const result = Skill.generate('test', [
    {
      name: 'greet',
      description: 'Greet someone',
      args: z.object({
        name: z.string().describe('Name to greet'),
      }),
    },
  ])
  expect(result).toContain('## Arguments')
  expect(result).toContain('| name ')
  expect(result).toContain('| string ')
})
```

**Green**: Extract args schema shape, render as a Markdown table with Name, Type, Required, Description columns.

---

### Cycle 3: Options table from options schema

**Red**:
```ts
test('includes options table', () => {
  const result = Skill.generate('test', [
    {
      name: 'list',
      description: 'List items',
      options: z.object({
        limit: z.number().default(30).describe('Max items'),
        verbose: z.boolean().default(false).describe('Show details'),
      }),
    },
  ])
  expect(result).toContain('## Options')
  expect(result).toContain('| --limit ')
  expect(result).toContain('| 30 ')
})
```

**Green**: Extract options schema shape, render as table with Flag, Type, Default, Description columns.

---

### Cycle 4: Output schema section

**Red**:
```ts
test('includes output schema as JSON', () => {
  const result = Skill.generate('test', [
    {
      name: 'greet',
      description: 'Greet someone',
      outputSchema: { type: 'object', properties: { message: { type: 'string' } } },
    },
  ])
  expect(result).toContain('## Output')
  expect(result).toContain('"message"')
})
```

**Green**: Render the JSON schema in a fenced `json` code block.

---

### Cycle 5: Annotations in frontmatter

**Red**:
```ts
test('includes annotations in frontmatter', () => {
  const result = Skill.generate('test', [
    {
      name: 'list',
      description: 'List items',
      annotations: { readOnlyHint: true },
    },
  ])
  expect(result).toContain('annotations:')
  expect(result).toContain('readOnlyHint: true')
})
```

**Green**: Add annotations block to YAML frontmatter when present.

---

### Cycle 6: Omits empty sections

**Red**:
```ts
test('omits sections when not applicable', () => {
  const result = Skill.generate('test', [
    { name: 'ping', description: 'Health check' },
  ])
  expect(result).not.toContain('## Arguments')
  expect(result).not.toContain('## Options')
  expect(result).not.toContain('## Output')
  expect(result).not.toContain('## Next Commands')
})
```

**Green**: Already works — sections only render when data exists.

---

### Cycle 7: Multiple commands concatenated

**Red**:
```ts
test('concatenates multiple commands with separator', () => {
  const result = Skill.generate('test', [
    { name: 'ping', description: 'Health check' },
    { name: 'pong', description: 'Pong back' },
  ])
  expect(result).toContain('# test ping')
  expect(result).toContain('# test pong')
})
```

**Green**: Join command sections with `\n\n---\n\n`.

---

### Cycle 8: Wire into `--llms --format md`

**Red** (`Cli.test.ts`):
```ts
test('--llms --format md outputs skill files', async () => {
  const cli = Cli.create('test')
  cli.command('greet', {
    description: 'Greet someone',
    args: z.object({ name: z.string().describe('Name to greet') }),
    output: z.object({ message: z.string() }),
    readOnly: true,
    run: ({ args }) => ({ message: `hello ${args.name}` }),
  })

  const { output } = await serve(cli, ['--llms', '--format', 'md'])
  expect(output).toContain('# test greet')
  expect(output).toContain('## Arguments')
  expect(output).toContain('## Output')
  expect(output).toContain('readOnlyHint: true')
})
```

**Green**: In `serve()`, when `llms && format === 'md'`, call `Skill.generate()` with collected command data instead of `Formatter.format(buildManifest(...))`.

---

### Cycle 9: Verify all tests pass

- `pnpm test` — all pass
- `pnpm check:types` — no errors
- `pnpm check` — lint passes

---

## Input Shape

`Skill.generate()` accepts pre-collected command data (not the raw command tree) so it stays decoupled from `Cli` internals. The input type:

```ts
type CommandInfo = {
  name: string
  description?: string
  args?: z.ZodObject<any>
  options?: z.ZodObject<any>
  outputSchema?: Record<string, unknown>
  annotations?: Record<string, boolean>
}
```

`Cli.ts` collects this from the command tree (reusing `collectCommands` logic) and passes it to `Skill.generate()`.

---

## Files Changed

| File | Change |
|---|---|
| `Skill.ts` | Implement `generate()` — frontmatter, heading, args/options tables, output schema, annotations |
| `Skill.test.ts` | New — tests for each section, omission, multi-command |
| `Cli.ts` | Wire `--llms --format md` to `Skill.generate()` |
| `Cli.test.ts` | Add test for `--llms --format md` integration |
