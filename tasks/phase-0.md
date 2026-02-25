# Phase 0: Project Setup & Scaffolding

**Goal:** Clean slate. Remove scaffolded placeholder code, add missing dependencies, create empty module files with barrel exports, verify toolchain works end-to-end.

**Precondition:** Project already has biome, vitest, zile, typescript, changesets configured and working. `@toon-format/toon` and `yaml` are installed.

---

## Steps

- [ ] Add `zod` as a dependency
- [ ] Remove `src/Foo.ts` and `src/Foo.test.ts`
- [ ] Create empty module files with placeholder exports (just enough so barrel compiles):
  - `src/Cli.ts`
  - `src/Errors.ts`
  - `src/Formatter.ts`
  - `src/Parser.ts`
  - `src/Schema.ts`
  - `src/Skill.ts`
  - `src/internal/types.ts`
  - `src/internal/utils.ts`
- [ ] Update `src/index.ts` to namespace re-exports + `z` re-export:
  ```ts
  export * as Cli from './Cli.js'
  export * as Errors from './Errors.js'
  export * as Formatter from './Formatter.js'
  export * as Parser from './Parser.js'
  export * as Schema from './Schema.js'
  export * as Skill from './Skill.js'
  export { z } from 'zod'
  ```
- [ ] Verify toolchain:
  - `pnpm check:types` passes (no type errors)
  - `pnpm check` passes (biome lint/format)
  - `pnpm test --run` passes (no tests yet = 0 failures)
  - `pnpm build` succeeds

---

## Done When

- Zero scaffolded code remains
- All module files exist (empty but exporting)
- Barrel `index.ts` compiles with all namespace exports
- `z` is re-exported from `'zod'`
- All four toolchain commands pass clean
