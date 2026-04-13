---
"@0xbigboss/incur": patch
---

fix(CommandOptions): revert runtime dry-run auto-derivation

In 0.4.4 the `dryRun` auto-derivation was extended from the `--llms` manifest (safe metadata) into `resolveCommandOptions` (runtime gate). That broke any command that declares its own `dryRun: z.boolean().optional()` in the options schema and returns a custom dry-run plan from its handler: the framework would hijack `--dry-run`, short-circuit with the generic `{ dryRun, command, args, options }` envelope, and never invoke the handler at all.

Reverts only the `src/CommandOptions.ts` change. The manifest auto-derivation in `Cli.ts`, the secret-safe dry-run envelope (env removal), and the kebab-case Skill table rendering all stay.
