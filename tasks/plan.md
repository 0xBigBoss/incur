# clac — Implementation Plan

Phased TDD approach. Each phase is a vertical slice — one test → one implementation → repeat. Every phase produces a working (if minimal) system. No horizontal slicing (all tests first, then all code).

Reference: [tasks/prd.md](./prd.md)

---

## Phase 1: Tracer Bullet — Minimal CLI

**Goal:** Prove the full path works: `Cli.create()` → `.command()` → `.serve()` → parse argv → run handler → output YAML envelope on stdout.

**Setup:**
- [ ] Clean up scaffolded `Foo.ts` / `Foo.test.ts`
- [ ] Add `zod` dependency
- [ ] Add `@toon-format/toon` dependency (for TOON serialization)
- [ ] Add `yaml` dependency (for YAML format option)
- [ ] Set up `src/index.ts` with namespace re-exports

**TDD cycles (Cli.test.ts):**
1. `Cli.create('test')` returns a cli instance with name
2. `Cli.create('test', { version: '1.0.0', description: '...' })` accepts options as second arg
3. `cli.command('hello', { ... })` registers a command
4. `cli.serve(['hello'])` routes to the correct command handler
5. Handler receives parsed `args` and `options` from Zod schemas
6. Output is wrapped in `{ ok: true, data, meta }` envelope
7. Output is serialized as TOON to stdout (default format)
8. Non-zero exit + error envelope when command not found

**Behaviors to test through public interface:**
```ts
const cli = Cli.create('test', { version: '0.1.0', description: 'Test CLI' })
cli.command('greet', {
  args: z.object({ name: z.string() }),
  output: z.object({ message: z.string() }),
  run: ({ args }) => ({ message: `hello ${args.name}` }),
})
// assert stdout is YAML envelope with { ok: true, data: { message: 'hello world' } }
```

**Files created:** `Cli.ts`, `Cli.test.ts`, `index.ts`

---

## Phase 2: Parser — Full Argument Parsing

**Goal:** Robust argv parsing driven by Zod schemas. Pure module, no CLI coupling.

**TDD cycles (Parser.test.ts):**
1. Parses positional args in schema key order
2. Parses `--flag value` named options
3. Parses `--flag=value` syntax
4. Parses `-f value` short aliases (given alias map)
5. Parses boolean flags (`--verbose` → true, `--no-color` → false)
6. Parses array options (`--label bug --label feature`)
7. Coerces string → number for numeric Zod schemas
8. Coerces string → boolean for boolean Zod schemas
9. Applies Zod `.default()` values for missing options
10. Treats `.optional()` fields as not required
11. Throws `Clac.ParseError` on unknown flags
12. Throws `Clac.ValidationError` on missing required args
13. Throws `Clac.ValidationError` on Zod validation failure (enum mismatch, etc.)
14. Returns `{ args, options }` matching inferred Zod types

**Files created:** `Parser.ts`, `Parser.test.ts`

**Wire in:** Update `Cli.ts` to use `Parser.parse()` instead of inline parsing from Phase 1.

---

## Phase 3: Errors — Structured Error Handling

**Goal:** Error classes + auto-wrapping of thrown errors into the error envelope.

**TDD cycles (Errors.test.ts):**
1. `BaseError` extends `Error`, sets `override name`
2. `ClacError` accepts `{ code, message, hint, retryable }`, sets `name = 'Clac.ClacError'`
3. `ValidationError` accepts `{ message, fieldErrors }`, sets `name = 'Clac.ValidationError'`
4. `ParseError` for arg parsing failures, sets `name = 'Clac.ParseError'`
5. `fieldErrors` has shape `Array<{ path, expected, received, message }>`

**TDD cycles (Cli.test.ts — error wrapping):**
6. `ClacError` thrown in `run()` → error envelope with code/hint/retryable on stdout
7. Plain `Error` thrown in `run()` → error envelope with code `'UNKNOWN'`
8. Zod validation failure during parsing → error envelope with `fieldErrors`
9. Exit code is 1 for errors

**Files created:** `Errors.ts`, `Errors.test.ts`

---

## Phase 4: Formatter — Output Formats

**Goal:** Support `--format toon|json|jsonl|yaml|md`, `--json` shorthand. stdout/stderr discipline.

**TDD cycles (Formatter.test.ts):**
1. `format(envelope, 'toon')` → valid TOON string with `ok`, `data`, `meta`
2. `format(envelope, 'json')` → valid JSON string, parseable via `JSON.parse()`
3. `format(envelope, 'yaml')` → valid YAML string
4. `format(envelope, 'md')` → Markdown with tables
5. `format(errorEnvelope, 'toon')` → error envelope with `ok: false`, `error` block
6. `format(errorEnvelope, 'json')` → JSON error envelope
7. `schemaVersion` is included in all formats
8. `meta.duration` is included (string, e.g. `'340ms'`)

**TDD cycles (Cli.test.ts — format flag):**
9. `cli.serve(['greet', 'world', '--format', 'json'])` → JSON on stdout
10. `cli.serve(['greet', 'world', '--json'])` → same as `--format json`
11. Default format is TOON (no flag needed)
12. Logs/warnings go to stderr, never stdout in any format

**Files created:** `Formatter.ts`, `Formatter.test.ts`

---

## Phase 5: Subcommands — Group Composition

**Goal:** `Cli.command('name')` without `run` acts as a group. Composable subcommand trees mounted via `cli.command(sub)`.

**TDD cycles (Cli.test.ts — subcommands):**
1. `Cli.command('pr', { description: '...' })` without `run` returns a command that accepts sub-commands
2. `pr.command('list', { ... })` registers a sub-command
3. `cli.command(pr)` mounts the sub-command tree — `cli.serve(['pr', 'list'])` routes correctly
4. Nested: command within command → `cli.serve(['pr', 'review', 'approve'])` works
5. Sub-commands defined in separate modules can be imported and mounted
6. Unknown subcommand → error envelope suggesting valid subcommands
7. Running `cli.serve(['pr'])` with no subcommand → help-like error listing available subcommands

---

## Phase 6: Schema — JSON Schema Generation

**Goal:** Convert Zod schemas to JSON Schema. Power the `--llms` manifest.

**TDD cycles (Schema.test.ts):**
1. `z.string()` → `{ type: 'string' }`
2. `z.number()` → `{ type: 'number' }`
3. `z.boolean()` → `{ type: 'boolean' }`
4. `z.enum(['a', 'b'])` → `{ type: 'string', enum: ['a', 'b'] }`
5. `z.array(z.string())` → `{ type: 'array', items: { type: 'string' } }`
6. `z.object({ ... })` → `{ type: 'object', properties: { ... }, required: [...] }`
7. `.optional()` removes from `required`
8. `.default(val)` adds `default` to schema
9. `.describe('...')` adds `description` to schema

**TDD cycles (Cli.test.ts — --llms):**
10. `cli.serve(['--llms'])` → YAML manifest with all commands (default format)
11. Manifest includes `inputSchema` and `outputSchema` per command
12. Manifest includes `annotations` per command
13. Manifest includes `schemaVersion: 'clac.v1'`
14. Nested group commands appear with full path (e.g. `pr list`)

**Files created:** `Schema.ts`, `Schema.test.ts`

**Note:** Consider using `zod-to-json-schema` if it covers our needs. Evaluate before writing from scratch.

---

## Phase 7: CTAs — Next Commands

**Goal:** `next` function on commands populates `meta.nextCommands` in output.

**TDD cycles (Cli.test.ts — next commands):**
1. Command with `next` function → output envelope includes `meta.nextCommands`
2. `next` receives the command's return value as argument
3. `nextCommands` entries have `{ command, description }` shape
4. `nextCommands` entries can optionally include `args`
5. Command without `next` → `meta.nextCommands` is empty array
6. `next` returning empty array → `meta.nextCommands` is empty array

---

## Phase 8: Skill Files — Markdown Generation

**Goal:** Auto-generate Markdown skill files with YAML frontmatter from command definitions.

**TDD cycles (Skill.test.ts):**
1. Generates valid Markdown with YAML frontmatter (`title`, `description`, `command`)
2. Frontmatter includes `annotations` when present
3. Includes `## Usage` section with synopsis
4. Includes `## Arguments` table (name, type, required, description)
5. Includes `## Options` table (flag, type, default, description)
6. Includes `## Output Schema` section
7. Includes `## Next Commands` section when `next` is defined
8. Omits sections when not applicable (no args → no Arguments section)

**TDD cycles (Cli.test.ts — --llms --format md):**
9. `cli.serve(['--llms', '--format', 'md'])` → concatenated Markdown of all commands

**Files created:** `Skill.ts`, `Skill.test.ts`

---

## Phase 9: Global Flags & Polish

**Goal:** Built-in `--help`, `--version`, `--no-color`, streaming, final polish.

**TDD cycles (Cli.test.ts — global flags):**
1. `cli.serve(['--version'])` → outputs version string
2. `cli.serve(['--help'])` → structured help text listing all commands
3. `cli.serve(['pr', '--help'])` → help for the `pr` group, listing subcommands
4. `cli.serve(['pr', 'list', '--help'])` → help for `pr list` with args/options
5. `--no-color` disables ANSI codes in text/help output
6. `NO_COLOR=1` env var has same effect as `--no-color`

**TDD cycles (streaming):**
7. Command with `streaming: true` + `--format jsonl` → JSONL on stdout
8. Each line is valid JSON
9. Final line is the meta envelope
10. Non-streaming command with `--format jsonl` → single JSON line + meta line

**TDD cycles (type tests — Cli.test-d.ts):**
11. `args` in `run()` callback infers correct types from Zod schema
12. `options` in `run()` callback infers correct types from Zod schema
13. `next` callback receives correctly typed result
14. `alias` keys are constrained to keys of `options` schema

---

## Dependency Graph

```
Phase 1 (tracer bullet)
  ├── Phase 2 (parser) ──────────────────┐
  ├── Phase 3 (errors) ──────────────────┤
  │                                      ▼
  ├── Phase 4 (formatter) ──── Phase 6 (schema)
  │                                      │
  ├── Phase 5 (subcommands)              ▼
  │                            Phase 8 (skills)
  ├── Phase 7 (CTAs)
  │
  └── Phase 9 (global flags & polish) ← all above
```

Phases 2, 3, 4, 5, 7 can be parallelized after Phase 1. Phase 6 depends on having the formatter. Phase 8 depends on schema. Phase 9 is the final integration pass.

---

## Per-Phase Checklist

Before marking a phase complete:

- [ ] All tests pass (`pnpm test`)
- [ ] Types check (`pnpm check:types`)
- [ ] Lint passes (`pnpm check`)
- [ ] Each test describes behavior, not implementation
- [ ] Each test uses the public interface only
- [ ] No speculative features added beyond the phase scope
