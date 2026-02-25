# clac — CLI Framework for Agent Consumption

## Problem Statement

CLI frameworks today (commander, cac, citty, yargs) are designed for human consumption: pretty help text, free-form stdout, unstructured errors. But CLIs are increasingly consumed by LLM agents (Amp, Claude Code, Cursor, etc.) that need to **discover** commands, **understand** their parameters via schemas, and **parse** their output reliably.

Agents currently scrape `--help` text, regex stdout, and guess at error meanings. This is brittle, wastes tokens, and leads to misuse. There is no "llms.txt for CLIs" — no standard way for a CLI to declare its capabilities in a machine-readable format.

MCP solves this for server-based tools, but many developer tools are and should remain CLIs. There is no lightweight, CLI-native framework that makes commands as discoverable and parseable as MCP tools — without the transport overhead.

## Solution

**clac** is a TypeScript library for building CLI applications that are first-class citizens for LLM agent consumption. It is a drop-in alternative to commander/cac/citty that adds:

1. **Zod-powered argument/option schemas** — full type inference + auto-generated JSON Schema for every command
2. **Structured output contract** — every command outputs via a standard envelope (`{ ok, data, error, meta }`) with format negotiation (`--format toon|json|jsonl|yaml|md`)
3. **Auto-generated skill files** — each command ships a Markdown skill file (with frontmatter) that agents can read to instantly understand usage, parameters, examples, and behavior
4. **Built-in agent discovery** — every clac CLI gets a free `--llms` flag that dumps the full command manifest
5. **Next-action CTAs** — commands can declare "next commands" that nudge agents toward logical follow-up actions
6. **Structured errors** — errors include stable codes, hints, field-level details, and retryability signals

Default output format is **TOON** ([Token-Oriented Object Notation](https://github.com/toon-format/toon)) — ~40% fewer tokens than JSON with higher LLM comprehension accuracy. JSON for machine-to-machine, JSONL for streaming.

## User Stories

1. As a CLI author, I want to define commands with Zod schemas for arguments and options, so that I get full TypeScript type inference and auto-generated JSON Schema without manual work
2. As a CLI author, I want structured output to be the default (not an afterthought), so that agents can reliably parse my CLI's responses
3. As a CLI author, I want to declare CTAs ("next commands") on each command, so that agents know what logical actions to take after a command completes
4. As a CLI author, I want skill files auto-generated from my command definitions, so that agents can discover and understand my CLI without scraping help text
5. As a CLI author, I want to define output schemas per command, so that agents can validate responses and know exactly what shape of data to expect
6. As a CLI author, I want nested subcommands at arbitrary depth (e.g. `mycli repo clone`), so that I can organize complex CLIs naturally
7. As a CLI author, I want a standard error envelope with codes, hints, and field errors, so that agents can self-correct when something goes wrong
8. As a CLI author, I want streaming support via JSONL, so that long-running commands can emit incremental results agents can process in real-time
9. As a CLI author, I want a single `--format` flag handled globally, so that I don't have to implement format negotiation per command
10. As a CLI author, I want the framework to handle argument parsing end-to-end, so that I don't need commander/yargs as a dependency
11. As an LLM agent, I want to run `mycli --llms` to get a complete machine-readable manifest of all commands, their schemas, and examples, so that I can use the CLI correctly on the first try
12. As an LLM agent, I want every command's output to include a `meta.nextCommands` field, so that I know what to do next without guessing
13. As an LLM agent, I want errors to include a `hint` field with actionable instructions (e.g. "set GH_TOKEN env var"), so that I can self-correct without asking the user
14. As an LLM agent, I want output in TOON by default, so that I can read it efficiently with ~40% fewer tokens than JSON and higher comprehension accuracy
15. As an LLM agent, I want JSON Schema for every command's input and output, so that I can validate my invocations and parse results with certainty
16. As an LLM agent, I want skill files in Markdown with structured frontmatter, so that I can be loaded with the right context for each command (like Amp skills)
17. As an LLM agent, I want errors to tell me if they're retryable, so that I don't waste cycles retrying non-transient failures
18. As an LLM agent, I want `--format json` to emit only JSON on stdout with no banners/logs mixed in, so that I can `JSON.parse()` stdout reliably
19. As a CLI author, I want to annotate commands with behavior hints (readOnly, destructive, idempotent), so that agents can make safety decisions before executing
20. As a CLI author, I want a single-package install with zero config to get started, so that adoption is frictionless

## Implementation Decisions

### API

Commands are defined with a Hono-like chainable API. `Cli.create()` returns an instance, and `.command()` registers commands inline. `Cli.command()` creates composable sub-command trees. Uses `const` generic modifier to preserve literal types for full inference:

```ts
import { Cli, z } from 'clac'

const cli = Cli.create('gh', {
  version: '1.0.0',
  description: 'GitHub CLI',
})

// Top-level command
cli.command('version', {
  description: 'Print version',
  output: z.object({ version: z.string() }),
  run: () => ({ version: '1.0.0' }),
})

// Compose subcommand groups
const pr = Cli.command('pr', { description: 'Pull request commands' })

pr.command('list', {
  description: 'List pull requests',
  annotations: { readOnly: true },
  args: z.object({
    repo: z.string().optional().describe('Repository in owner/repo format'),
  }),
  options: z.object({
    state: z.enum(['open', 'closed', 'merged', 'all']).default('open').describe('Filter by state'),
    limit: z.number().default(30).describe('Maximum number of PRs to return'),
    label: z.array(z.string()).optional().describe('Filter by labels'),
  }),
  alias: { state: 's', limit: 'l' },
  output: z.object({
    prs: z.array(z.object({
      number: z.number(),
      title: z.string(),
      state: z.string(),
      author: z.string(),
      url: z.string(),
    })),
  }),
  run: async ({ args, options }) => {
    // implementation
    return { prs: [...] }
  },
  next: (result) => [
    { command: 'pr view', args: { number: result.prs[0]?.number }, description: 'View details of a PR' },
    { command: 'pr checkout', description: 'Check out a PR locally' },
  ],
})

pr.command('checkout', {
  description: 'Check out a PR locally',
  args: z.object({
    number: z.number().describe('PR number'),
  }),
  output: z.object({ branch: z.string() }),
  run: async ({ args }) => {
    return { branch: `pr-${args.number}` }
  },
})

// Mount group onto CLI
cli.command(pr)

cli.serve()
```

### Subcommands

Subcommands use Hono-style composition. A `command()` without `run` is a group — it only has sub-commands. Commands are self-contained and can be defined in separate files, then mounted via `cli.command(sub)`. Nesting is arbitrary:

```ts
// pr/index.ts
import { Cli, z } from 'clac'

export const pr = Cli.command('pr', { description: 'Pull request commands' })
pr.command('list', { ... })
pr.command('view', { ... })

// pr/review.ts
export const review = Cli.command('review', { description: 'PR review commands' })
review.command('approve', { ... })
review.command('request-changes', { ... })

// pr/index.ts — nest group within group
pr.command(review) // gh pr review approve

// cli.ts
import { pr } from './pr/index.js'
cli.command(pr) // gh pr list, gh pr review approve, etc.
```

### Output Envelope

Every command response is wrapped in a standard envelope. All formats use the same underlying data — only the serialization changes.

#### `--format toon` (default)

Token-efficient, LLM-optimized. Tabular arrays collapse into CSV-style rows. ~40% fewer tokens than JSON.

```toon
ok: true
schemaVersion: gh.v1
data:
  prs[3]{number,title,state,author,url}:
    123,Add feature X,open,jake,"https://github.com/org/repo/pull/123"
    456,Fix bug in parser,closed,alice,"https://github.com/org/repo/pull/456"
    789,Update docs,open,bob,"https://github.com/org/repo/pull/789"
meta:
  command: pr list
  duration: 340ms
  nextCommands[2]{command,description}:
    pr view --number 123,View details of a PR
    pr checkout,Check out a PR locally
```

#### `--format json` / `--json`

Deterministic, machine-parseable. Use when agents need `JSON.parse()` reliability.

```json
{
  "ok": true,
  "schemaVersion": "gh.v1",
  "data": {
    "prs": [
      {
        "number": 123,
        "title": "Add feature X",
        "state": "open",
        "author": "jake",
        "url": "https://github.com/org/repo/pull/123"
      },
      ...
    ]
  },
  "meta": {
    "command": "pr list",
    "duration": "340ms",
    "nextCommands": [
      { "command": "pr view --number 123", "description": "View details of a PR" },
      { "command": "pr checkout", "description": "Check out a PR locally" }
    ]
  }
}
```

#### `--format yaml`

Familiar to most agents. More tokens than TOON, but well-supported.

```yaml
ok: true
schemaVersion: gh.v1
data:
  prs:
    - number: 123
      title: Add feature X
      state: open
      author: jake
      url: https://github.com/org/repo/pull/123
    - number: 456
      title: Fix bug in parser
      state: closed
      author: alice
      url: https://github.com/org/repo/pull/456
    - number: 789
      title: Update docs
      state: open
      author: bob
      url: https://github.com/org/repo/pull/789
meta:
  command: pr list
  duration: 340ms
  nextCommands:
    - command: pr view --number 123
      description: View details of a PR
    - command: pr checkout
      description: Check out a PR locally
```

#### `--format jsonl`

Streaming. One JSON object per line. Final line is the meta envelope. For commands with `streaming: true`.

```jsonl
{"type":"data","item":{"number":123,"title":"Add feature X","state":"open","author":"jake","url":"https://github.com/org/repo/pull/123"}}
{"type":"data","item":{"number":456,"title":"Fix bug in parser","state":"closed","author":"alice","url":"https://github.com/org/repo/pull/456"}}
{"type":"data","item":{"number":789,"title":"Update docs","state":"open","author":"bob","url":"https://github.com/org/repo/pull/789"}}
{"type":"meta","ok":true,"schemaVersion":"gh.v1","meta":{"command":"pr list","duration":"340ms","nextCommands":[...]}}
```

#### `--format md`

Markdown tables. Good for pasting into issues, PRs, or docs.

```md
# pr list

| # | Title | State | Author |
|---|-------|-------|--------|
| 123 | Add feature X | open | jake |
| 456 | Fix bug in parser | closed | alice |
| 789 | Update docs | open | bob |

## Next Commands

- `pr view --number 123` — View details of a PR
- `pr checkout` — Check out a PR locally
```

#### Error Envelope

Errors use the same format system. Example in TOON (default):

```toon
ok: false
schemaVersion: gh.v1
error:
  code: NOT_AUTHENTICATED
  message: GitHub token not found
  hint: Pass --token or set GH_TOKEN environment variable
  retryable: false
  fieldErrors[0]:
meta:
  command: pr list
  exitCode: 1
```

### Global Flags

Every clac CLI gets these flags for free (not declared by the author):

- `--format toon|json|jsonl|yaml|md` (default: `toon`)
- `--json` (shorthand for `--format json`)
- `--no-color` / `NO_COLOR` env var support
- `--llms` (dump full skill manifest, respects `--format`, defaults to TOON)
- `--help` (human-readable help, but structured)
- `--version`

### Streaming (JSONL)

For commands that declare `streaming: true`, `--format jsonl` emits one JSON object per line on stdout. Progress/logs go to stderr. The final line is always the meta envelope.

### Agent Discovery (`--llms`)

Running `mycli --llms` outputs a manifest of all commands — essentially `tools/list` but for CLI. Defaults to TOON like everything else:

```toon
name: gh
version: 1.0.0
description: GitHub CLI
schemaVersion: clac.v1
commands[1]{name,description}:
  pr list,List pull requests
```

### Auto-Generated Skill Files

At **build time** (or via `mycli --llms --format md`), clac generates a Markdown skill file per command:

```markdown
---
title: "gh pr list"
description: "List pull requests"
command: "gh pr list"
annotations:
  readOnly: true
---

# gh pr list

List pull requests from a GitHub repository.

## Usage

\`\`\`
gh pr list [repo] [--state open|closed|merged|all] [--limit 30] [--label ...]
\`\`\`

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| repo | string | no | Repository in owner/repo format |

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| --state | enum(open,closed,merged,all) | open | Filter by state |
| --limit | number | 30 | Maximum number of PRs to return |
| --label | string[] | - | Filter by labels |

## Output Schema

Returns `{ prs: Array<{ number, title, state, author, url }> }`

## Examples

\`\`\`bash
# List open PRs (default)
gh pr list

# List closed PRs with limit
gh pr list --state closed --limit 10

# List PRs for specific repo
gh pr list owner/repo --label bug
\`\`\`

## Next Commands

- `gh pr view --number <number>` — View details of a PR
- `gh pr checkout` — Check out a PR locally
```

### Command Annotations

Borrowed from MCP tool annotations, each command can declare behavioral hints:

- `readOnly` — does not modify state
- `destructive` — irreversible side effects (delete, overwrite)
- `idempotent` — safe to retry
- `openWorld` — interacts with external systems

These appear in skill files and the `--llms` manifest so agents can make safety decisions.

### Argument Parsing

clac handles all argument parsing internally — no commander/yargs dependency. Features:

- Positional args (ordered, from Zod schema keys)
- Named options (`--flag value`, `--flag=value`, `-f value`)
- Boolean flags (`--verbose`, `--no-color`)
- Array options (`--label bug --label feature`)
- Enum validation (from Zod enums)
- Type coercion (string → number, string → boolean)
- Required/optional with defaults (from Zod `.default()` / `.optional()`)
- Aliasing via `alias` property (`alias: { state: 's' }` → `-s` for `--state`)

### Error Handling

Errors thrown inside `run()` are caught and wrapped in the error envelope automatically. Authors can throw structured errors. Error classes follow the `BaseError` pattern with namespaced `override name`:

```ts
import { Errors } from 'clac'

// Base error class — all clac errors extend this
// Errors.BaseError

// Throw a structured CLI error
throw new Errors.ClacError({
  code: 'NOT_AUTHENTICATED',
  message: 'GitHub token not found',
  hint: 'Pass --token or set GH_TOKEN environment variable',
  retryable: false,
})

// Error class naming convention:
// override name = 'Clac.NotAuthenticatedError'
// override name = 'Clac.ValidationError'
// override name = 'Clac.ParseError'
```

Validation errors (wrong types, missing required args) are auto-generated from Zod with `fieldErrors` populated.

### stdout/stderr Discipline

- **stdout**: only structured output (envelope). Never banners, logs, or progress in any format mode.
- **stderr**: logs, progress, warnings, human-readable messages. Agents can ignore stderr; humans see it in terminal.

### Package Structure

Single package: `clac`. Uses `export * as` namespace pattern with PascalCase module files:

```
src/
├── index.ts              # Public API re-exports only
├── Cli.ts                # Cli.create() — main entry point
├── Cli.test.ts           # Colocated tests
├── Cli.test-d.ts         # Type tests for generic inference
├── Errors.ts             # BaseError, ClacError, ValidationError, ParseError
├── Errors.test.ts
├── Formatter.ts          # Output envelope formatting (yaml/json/jsonl/md/text)
├── Formatter.test.ts
├── Parser.ts             # Argument parsing
├── Parser.test.ts
├── Skill.ts              # Skill file generation
├── Skill.test.ts
├── Schema.ts             # Zod → JSON Schema conversion
├── Schema.test.ts
└── internal/
    ├── types.ts          # Shared internal types
    └── utils.ts          # Internal helpers
```

Exports (via `export * as` namespace re-exports):

```ts
// src/index.ts
export * as Cli from './Cli.js'
export * as Errors from './Errors.js'
export * as Formatter from './Formatter.js'
export * as Parser from './Parser.js'
export * as Skill from './Skill.js'
export * as Schema from './Schema.js'
export { z } from 'zod'
```

All exported functions use `declare namespace` for associated types:

```ts
// src/Cli.ts
export function create(name: string, options: create.Options = {}): create.ReturnType { ... }

export declare namespace create {
  type Options = {
    readonly version?: string | undefined
    readonly description?: string | undefined
  }
  type ReturnType = Cli
  type ErrorType = never
}
```

### TypeScript Conventions

- **`type` over `interface`** — always use `type` for type definitions
- **`const` generic modifier** — preserve literal types in command schemas for full inference
- **camelCase generics** — `<const args extends z.ZodObject<any>>` not `<T>`
- **Options default `= {}`** — use `options: Options = {}` not `options?: Options`
- **`.js` extensions** — all imports include `.js` for ESM compatibility
- **`satisfies`** — use for config objects to preserve literal types while type-checking
- **No enums** — use `as const` objects for fixed sets
- **Classes for errors only** — all other APIs use factory functions
- **No `readonly`** — skip `readonly` on type properties; adds noise without real value

## Testing Decisions

Tests should verify **external behavior** — what a user/agent sees when invoking the CLI — not internal implementation details.

### Modules to test

Tests are colocated with source (`Module.test.ts`). Each test file uses `describe()` named after the function being tested:

- **Parser** (`Parser.test.ts`) — positional args, options, flags, type coercion, aliases, array options, validation errors. Highest-risk module, most comprehensive tests.
- **Formatter** (`Formatter.test.ts`) — envelope generation across all formats (toon, json, jsonl, yaml, md). Verify stdout/stderr separation. Verify schemaVersion inclusion.
- **Cli** (`Cli.test.ts`, `Cli.test-d.ts`) — `create`, `.command()`, `.serve()`. Dot-notation to tree routing, `--llms` manifest generation. Type tests for generic inference on args/options/output schemas.
- **Skill** (`Skill.test.ts`) — Markdown output matches expected format, frontmatter is correct, examples render properly.
- **Errors** (`Errors.test.ts`) — ClacError wrapping, Zod validation error formatting, exit codes, hint propagation. Verify `override name` follows `Clac.ErrorName` convention.
- **Schema** (`Schema.test.ts`) — Zod → JSON Schema conversion for the `--llms` manifest and skill files.

### Test approach

```ts
// Example test structure (Parser.test.ts)
import { describe, expect, test } from 'vitest'
import * as Parser from './Parser.js'

describe('parse', () => {
  test('parses positional args', () => {
    expect(Parser.parse(['clone', 'repo-url'])).toMatchObject({
      args: { url: 'repo-url' },
    })
  })

  test('throws on missing required arg', () => {
    expect(() => Parser.parse([])).toThrowErrorMatchingInlineSnapshot(
      `[Clac.ValidationError: Missing required argument: url]`,
    )
  })
})
```

- Unit tests for Parser and Formatter (pure functions, easy to test in isolation)
- Integration tests that create a CLI with `Cli.create()`, register commands via `.command()`, invoke `.serve()`, and assert on stdout/stderr/exit code
- Snapshot tests for skill file generation (Markdown output stability)
- Type tests (`Module.test-d.ts`) to verify generic inference preserves literal types from Zod schemas
- Schema validation tests: define a command with output schema, run it, validate output against declared JSON Schema

## Out of Scope

- **Interactive prompts** (select, confirm, input) — clac is non-interactive by design. Agents can't interact with prompts.
- **MCP server generation** — future scope. The `--llms` manifest is designed to be MCP-compatible, making a future `clac-to-mcp` bridge straightforward.
- **`clac exec` runtime wrapper** — the universal agent↔CLI bridge idea. Requires adoption first. Future scope.
- **Community skill files for non-clac CLIs** — hand-written adapters for git, docker, etc. Different product.
- **Config file loading** (`.clacrc`, `clac.config.ts`) — keep it code-only for v1.
- **Shell completions** — nice-to-have, not core to the agent-first mission.
- **Internationalization** — English only for v1.

## Further Notes

### Relationship to MCP

clac is not a replacement for MCP — it's the **CLI-native equivalent**. MCP is for long-running servers with bidirectional communication. clac is for fire-and-forget CLI invocations. The two can coexist: a tool could ship both a clac CLI and an MCP server, sharing the same command definitions.

The `--llms` manifest is intentionally shaped like MCP's `tools/list` response (with `inputSchema`, `outputSchema`, `annotations`) so that bridging is trivial in the future.

### Why TOON default

[TOON](https://github.com/toon-format/toon) (Token-Oriented Object Notation) is purpose-built for LLM consumption. It achieves ~40% fewer tokens than JSON with higher comprehension accuracy across benchmarks (73.9% vs JSON's 69.7%). It combines YAML-like indentation for nested data with CSV-style tabular layouts for uniform arrays — the best of both worlds. TOON is a lossless JSON round-trip, so `--json` remains available for programmatic consumption. The `@toon-format/toon` TypeScript SDK provides `encode`/`decode`.

### Design Philosophy

- **Schema-first**: if it's not in the schema, it doesn't exist. No undocumented flags or ad-hoc output fields.
- **Convention over configuration**: global flags, envelope format, skill file structure are all fixed. Authors focus on their commands, not framework boilerplate.
- **Agent-pessimistic**: assume agents will misuse your CLI. Give them schemas to validate against, hints when they fail, and CTAs to guide them forward.
- **Human-compatible**: structured output is agent-first, but `--format md` and stderr ensure humans aren't left behind.

### Naming

"clac" = **CL**I for **A**gent **C**onsumption. Also "calc" backwards — computing things, but inverted for the agent era.
