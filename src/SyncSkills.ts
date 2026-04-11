import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import * as Cli from './Cli.js'
import { formatExamples } from './Cli.js'
import * as Agents from './internal/agents.js'
import * as Skill from './Skill.js'

/**
 * Throws if a skill name (or SKILL.md frontmatter `name:` value) is shaped
 * such that it could escape `tmpDir` or — after passing through
 * `Agents.install()`'s `sanitizeName()` — collapse to an empty / `.` / `..`
 * value that would resolve `canonicalDir` to `canonicalBase` itself and let
 * the install loop's `rmForce` wipe every installed skill.
 */
function assertSafeSkillName(name: string, prefix: string): void {
  if (
    !name ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\0') ||
    name === '.' ||
    name === '..'
  )
    throw new Error(`${prefix} ${JSON.stringify(name)}`)
}

/** Generates skill files from a command map and installs them natively. */
export async function sync(
  name: string,
  commands: Map<string, any>,
  options: sync.Options = {},
): Promise<sync.Result> {
  const { contextRules = [], depth = 1, description, global = true } = options
  const cwd = options.cwd ?? (global ? resolvePackageRoot() : process.cwd())
  const contextPath = resolveContextPath({ cwd, global })

  const groups = new Map<string, string>()
  if (description) groups.set(name, description)
  const entries = collectEntries(commands, [], groups)
  const files = Skill.split(name, entries, depth, groups)

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `incur-skills-${name}-`))
  try {
    const skills: sync.Skill[] = []
    for (const file of files) {
      const filePath = file.dir
        ? path.join(tmpDir, file.dir, 'SKILL.md')
        : path.join(tmpDir, 'SKILL.md')
      await fs.mkdir(path.dirname(filePath), { recursive: true })
      await fs.writeFile(filePath, `${file.content}\n`)
      const nameMatch = file.content.match(/^name:\s*(.+)$/m)
      const descMatch = file.content.match(/^description:\s*(.+)$/m)
      skills.push({ name: nameMatch?.[1] ?? (file.dir || name), description: descMatch?.[1] })
    }

    const context = Skill.generateContext(name, entries, contextRules)
    await fs.mkdir(path.dirname(contextPath), { recursive: true })
    await fs.writeFile(contextPath, `${context}\n`)

    // Include additional SKILL.md files matched by glob patterns
    if (options.include) {
      for (const pattern of options.include) {
        const globPattern = pattern === '_root' ? 'SKILL.md' : path.join(pattern, 'SKILL.md')
        for await (const match of fs.glob(globPattern, { cwd })) {
          try {
            const content = await fs.readFile(path.resolve(cwd, match), 'utf8')
            const nameMatch = content.match(/^name:\s*(.+)$/m)
            const skillName =
              pattern === '_root' ? (nameMatch?.[1] ?? name) : path.basename(path.dirname(match))
            const dest = path.join(tmpDir, skillName, 'SKILL.md')
            await fs.mkdir(path.dirname(dest), { recursive: true })
            await fs.writeFile(dest, content)
            if (!skills.some((s) => s.name === skillName)) {
              const descMatch = content.match(/^description:\s*(.+)$/m)
              skills.push({ name: skillName, description: descMatch?.[1], external: true })
            }
          } catch {}
        }
      }
    }

    // Include additional SKILL.md files from inline content.
    //
    // Build-time escape hatch for CLIs compiled into single-file executables
    // (e.g. `bun build --compile`): the source tree that `include` globs
    // against no longer exists at runtime, so the caller bakes SKILL.md
    // bodies into the binary via a text import
    // (`import skill from './SKILL.md' with { type: 'text' }`) and passes
    // the strings here. Installed via the same tmpDir pipeline as
    // glob-loaded skills so the downstream install flow is identical.
    //
    // Inline is a *fallback*, not an override: if `include` (or the
    // command generator) already produced a skill with the same name, skip
    // the inline entry entirely. Rationale: in dev mode, `include` reads
    // the live source file, which may be fresher than whatever was baked
    // into the binary at last build; in compiled-binary mode, `include`
    // finds nothing and inline takes over. Using "skip-if-exists" instead
    // of "overwrite" keeps dev-mode edits authoritative.
    if (options.skills) {
      const tmpDirResolved = path.resolve(tmpDir)
      for (const skill of options.skills) {
        // Reject names that could escape `tmpDir` via path traversal *before*
        // touching the filesystem. The downstream `Agents.install()` discovery
        // pass also runs `sanitizeName()`, but only after these writes have
        // already landed — by then a malicious `../foo` payload would have
        // dropped a SKILL.md outside the temp tree, and the `finally` cleanup
        // (which only `rm`s `tmpDir`) would not remove it. Fail loud here
        // instead of silently rewriting, since a path-shaped `name` always
        // indicates a caller bug, not a legitimate use case.
        assertSafeSkillName(skill.name, 'sync.skills: invalid skill name')
        // The frontmatter `name:` is also a vector. `Agents.install()`
        // re-reads SKILL.md from disk and **prefers the frontmatter name
        // over the directory name**, then sanitizes via `sanitizeName()`
        // which collapses `..` to `''`. An empty name then resolves
        // `canonicalDir` to `canonicalBase` itself and `rmForce` would wipe
        // every installed skill. The Agents-layer containment check is the
        // backstop, but we also fail loud here so a buggy caller sees the
        // problem at the source rather than getting a generic install error.
        // `\s*` would match newlines and slide the capture into the next
        // line — for `name: \n---\n` the greedy `(.+)` would then capture
        // the YAML delimiter `---`, smuggling an empty/`...`-shaped name
        // past the validator. Use `[^\S\n]*` (whitespace except newline) so
        // the match stays anchored to the `name:` line.
        const inlineNameMatch = skill.content.match(/^name:[^\S\n]*(.*)$/m)
        if (inlineNameMatch)
          assertSafeSkillName(
            inlineNameMatch[1]?.trim() ?? '',
            'sync.skills: invalid SKILL.md frontmatter `name:`',
          )
        if (skills.some((s) => s.name === skill.name)) continue
        const dest = path.join(tmpDir, skill.name, 'SKILL.md')
        // Defense in depth: even if the regex above misses some platform
        // quirk, refuse to write if the resolved destination is not strictly
        // inside `tmpDir`.
        const destResolved = path.resolve(dest)
        if (!destResolved.startsWith(tmpDirResolved + path.sep))
          throw new Error(`sync.skills: skill name ${JSON.stringify(skill.name)} escapes tmp dir`)
        await fs.mkdir(path.dirname(dest), { recursive: true })
        await fs.writeFile(dest, skill.content)
        const descMatch = skill.content.match(/^description:\s*(.+)$/m)
        skills.push({ name: skill.name, description: descMatch?.[1], external: true })
      }
    }

    const { paths, agents } = Agents.install(tmpDir, { global, cwd })

    // Remove stale skills from previous installs
    const currentNames = new Set(paths.map((p) => path.basename(p)))
    const prev = readMeta(name)
    if (prev?.skills) {
      for (const old of prev.skills) {
        if (currentNames.has(old)) continue
        Agents.remove(old, { global, cwd })
      }
    }

    // Write skills hash + names for staleness detection. Inline entries that
    // are shadowed by a command-derived skill of the same name don't
    // contribute to the hash, so changing a shadowed baked body doesn't
    // produce a false "Skills are out of date" prompt. The read side in
    // `Cli.serve` mirrors this exact filter so the two hashes always agree.
    //
    // Inline entries shadowed by an `include` glob are still hashed: the
    // read side cannot expand globs without doing a filesystem walk on every
    // CLI invocation. The residual false positive only fires in dev mode
    // (where `include` matches the live source tree); compiled binaries
    // never see it because their `include` finds nothing at runtime.
    const hashEntries = collectEntries(commands, [])
    const generatedNames = Skill.generatedNames(name, hashEntries, depth)
    const inlineForHash =
      options.skills?.filter((s) => !generatedNames.has(s.name)) ?? undefined
    writeMeta(name, Skill.hash(hashEntries, inlineForHash), [...currentNames])

    return { skills, paths, agents }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
}

export declare namespace sync {
  /** Options for syncing skills. */
  type Options = {
    /** Working directory for resolving `include` globs. Defaults to `process.cwd()`. */
    cwd?: string | undefined
    /** Rules to include in generated `CONTEXT.md`. */
    contextRules?: string[] | undefined
    /** Grouping depth for skill files. Defaults to `1`. */
    depth?: number | undefined
    /** CLI description, used as the top-level group description. */
    description?: string | undefined
    /** Install globally (`~/.config/agents/skills/`) instead of project-local. Defaults to `true`. */
    global?: boolean | undefined
    /** Glob patterns for directories containing SKILL.md files to include (e.g. `"skills/*"`, `"my-skill"`). Skill name is the parent directory name. */
    include?: string[] | undefined
    /**
     * Inline SKILL.md entries to install alongside the generated and
     * glob-included ones. Intended for CLIs compiled into single-file
     * executables where `include` globs cannot reach the original source
     * tree at runtime — bake the body in via a text import at build time
     * (e.g. Bun's `import skill from './SKILL.md' with { type: 'text' }`)
     * and pass it through here. Inline entries act as a fallback: if a
     * skill with the same `name` was already produced by the command
     * generator or by `include`, the inline entry is skipped so dev-mode
     * filesystem edits stay authoritative.
     */
    skills?: Array<{ name: string; content: string }> | undefined
  }
  /** Result of a sync operation. */
  type Result = {
    /** Per-agent install details (non-universal agents only). */
    agents: import('./internal/agents.js').install.AgentInstall[]
    /** Canonical install paths. */
    paths: string[]
    /** Synced skills with metadata. */
    skills: Skill[]
  }
  /** A synced skill entry. */
  type Skill = {
    /** Description extracted from the skill frontmatter. */
    description?: string | undefined
    /** Whether this skill was included from a local file (not generated from commands). */
    external?: boolean | undefined
    /** Skill directory name. */
    name: string
  }
}

/** Recursively collects leaf commands as `Skill.CommandInfo`. */
function collectEntries(
  commands: Map<string, any>,
  prefix: string[],
  groups: Map<string, string> = new Map(),
): Skill.CommandInfo[] {
  const result: Skill.CommandInfo[] = []
  for (const [name, entry] of commands) {
    const entryPath = [...prefix, name]
    if ('_group' in entry && entry._group) {
      if (entry.description) groups.set(entryPath.join(' '), entry.description)
      result.push(...collectEntries(entry.commands, entryPath, groups))
    } else {
      const cmd: Skill.CommandInfo = { name: entryPath.join(' ') }
      if (entry.description) cmd.description = entry.description
      if (entry.args) cmd.args = entry.args
      if (entry.env) cmd.env = entry.env
      if (entry.hint) cmd.hint = entry.hint
      const options = Cli.getCommandOptionsSchema(entry)
      if (options) cmd.options = options
      if (entry.output) cmd.output = entry.output
      if (entry.mutates)
        cmd.hint = [cmd.hint, 'Use `--dry-run` before executing this mutating command.']
          .filter(Boolean)
          .join(' ')
      if (entry.destructive)
        cmd.hint = [cmd.hint, 'Confirm with the user before executing this destructive command.']
          .filter(Boolean)
          .join(' ')
      const examples = formatExamples(entry.examples)
      if (examples) {
        const cmdName = entryPath.join(' ')
        cmd.examples = examples.map((e) => ({
          ...e,
          command: e.command ? `${cmdName} ${e.command}` : cmdName,
        }))
      }
      result.push(cmd)
    }
  }
  return result.sort((a, b) => a.name.localeCompare(b.name))
}

/** Resolves the package root from the executing bin script (`process.argv[1]`). Walks up from the bin's directory looking for `package.json`. Falls back to `process.cwd()`. */
function resolvePackageRoot(): string {
  const bin = process.argv[1]
  if (!bin) return process.cwd()
  let dir = path.dirname(
    (() => {
      try {
        // resolve symlinks for normal bin scripts
        return fsSync.realpathSync(bin)
      } catch {
        // Bun compiled binaries use a virtual `/$bunfs/` path for argv[1]
        return process.execPath
      }
    })(),
  )
  const root = path.parse(dir).root
  while (dir !== root) {
    try {
      fsSync.accessSync(path.join(dir, 'package.json'))
      return dir
    } catch {}
    dir = path.dirname(dir)
  }
  return process.cwd()
}

/** Returns the hash file path for a CLI. */
function hashPath(name: string): string {
  const dir = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share')
  return path.join(dir, 'incur', `${name}.json`)
}

/** @internal Writes the skills metadata for staleness detection and cleanup. */
function writeMeta(name: string, hash: string, skills: string[]) {
  const file = hashPath(name)
  const dir = path.dirname(file)
  if (!fsSync.existsSync(dir)) fsSync.mkdirSync(dir, { recursive: true })
  fsSync.writeFileSync(file, JSON.stringify({ hash, skills, at: new Date().toISOString() }) + '\n')
}

/** @internal Reads the stored metadata for a CLI. */
function readMeta(name: string): { hash: string; skills?: string[] } | undefined {
  try {
    return JSON.parse(fsSync.readFileSync(hashPath(name), 'utf-8'))
  } catch {
    return undefined
  }
}

/** Reads the stored skills hash for a CLI. Returns `undefined` if no hash exists. */
export function readHash(name: string): string | undefined {
  return readMeta(name)?.hash
}

function resolveContextPath(options: { cwd: string; global: boolean }): string {
  if (!options.global) return path.join(options.cwd, 'CONTEXT.md')
  return path.join(os.homedir(), '.agents', 'CONTEXT.md')
}
