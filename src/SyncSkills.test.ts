import { Cli, SyncSkills } from 'incur'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let savedXdg: string | undefined

beforeEach(() => {
  savedXdg = process.env.XDG_DATA_HOME
})

afterEach(() => {
  if (savedXdg === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = savedXdg
})

test('generates skill files and installs to canonical location', async () => {
  const tmp = join(tmpdir(), `clac-sync-test-${Date.now()}`)
  mkdirSync(tmp, { recursive: true })

  const cli = Cli.create('test', { description: 'A test CLI' })
  cli.command('ping', { description: 'Health check', run: () => ({ pong: true }) })
  cli.command('greet', { description: 'Say hello', run: () => ({ hi: true }) })

  const commands = Cli.toCommands.get(cli)!
  const installDir = join(tmp, 'install')
  mkdirSync(join(installDir, '.agents', 'skills'), { recursive: true })

  const result = await SyncSkills.sync('test', commands, {
    description: 'A test CLI',
    // Use a fake home dir so we don't pollute the real one
    global: false,
    cwd: installDir,
  })

  expect(result.skills.length).toBeGreaterThan(0)
  expect(result.skills.map((s) => s.name)).toContain('test-greet')
  expect(result.skills.map((s) => s.name)).toContain('test-ping')

  // Verify skills were installed to canonical location
  for (const p of result.paths) {
    expect(existsSync(join(p, 'SKILL.md'))).toBe(true)
  }

  rmSync(tmp, { recursive: true, force: true })
})

test('uses custom depth', async () => {
  const tmp = join(tmpdir(), `clac-depth-test-${Date.now()}`)
  mkdirSync(tmp, { recursive: true })

  const cli = Cli.create('test')
  cli.command('ping', { description: 'Ping', run: () => ({}) })
  cli.command('pong', { description: 'Pong', run: () => ({}) })

  const commands = Cli.toCommands.get(cli)!
  const installDir = join(tmp, 'install')
  mkdirSync(join(installDir, '.agents', 'skills'), { recursive: true })

  const result = await SyncSkills.sync('test', commands, {
    depth: 0,
    global: false,
    cwd: installDir,
  })

  // depth 0 = single skill
  expect(result.skills).toHaveLength(1)

  rmSync(tmp, { recursive: true, force: true })
})

test('writes hash after successful sync', async () => {
  const tmp = join(tmpdir(), `clac-hash-test-${Date.now()}`)
  mkdirSync(tmp, { recursive: true })
  process.env.XDG_DATA_HOME = tmp

  const cli = Cli.create('hash-test')
  cli.command('ping', { description: 'Health check', run: () => ({}) })

  const commands = Cli.toCommands.get(cli)!
  const installDir = join(tmp, 'install')
  mkdirSync(join(installDir, '.agents', 'skills'), { recursive: true })

  await SyncSkills.sync('hash-test', commands, {
    global: false,
    cwd: installDir,
  })

  const stored = SyncSkills.readHash('hash-test')
  expect(stored).toMatch(/^[0-9a-f]{16}$/)

  rmSync(tmp, { recursive: true, force: true })
})

test('readHash returns undefined when no hash exists', () => {
  const tmp = join(tmpdir(), `clac-hash-test-${Date.now()}`)
  mkdirSync(tmp, { recursive: true })
  process.env.XDG_DATA_HOME = tmp

  expect(SyncSkills.readHash('nonexistent')).toBeUndefined()

  rmSync(tmp, { recursive: true, force: true })
})

test('installs inline skills passed via sync.skills', async () => {
  // Exercise the build-time escape hatch path — simulates a compiled binary
  // that baked SKILL.md content into a text import at build time and has
  // no source tree to glob at runtime.
  const tmp = join(tmpdir(), `clac-inline-test-${Date.now()}`)
  mkdirSync(tmp, { recursive: true })

  const cli = Cli.create('inline-tool', { description: 'Inline test tool' })
  cli.command('ping', { description: 'Health check', run: () => ({}) })

  const commands = Cli.toCommands.get(cli)!
  const installDir = join(tmp, 'install')
  mkdirSync(join(installDir, '.agents', 'skills'), { recursive: true })

  const inlineContent = `---
name: baked-skill
description: Skill whose body was baked into the binary at build time.
---

# Baked skill

Proof that the content was installed via sync.skills.
`

  const result = await SyncSkills.sync('inline-tool', commands, {
    global: false,
    cwd: installDir,
    skills: [{ name: 'baked-skill', content: inlineContent }],
  })

  // Metadata entry lands in result with external=true so consumers can
  // distinguish inline/glob skills from auto-generated command skills.
  const baked = result.skills.find((s) => s.name === 'baked-skill')
  expect(baked).toBeDefined()
  expect(baked?.external).toBe(true)
  expect(baked?.description).toBe('Skill whose body was baked into the binary at build time.')

  // Installed SKILL.md on disk matches the inline body verbatim.
  const bakedPath = result.paths.find((p) => p.endsWith('baked-skill'))
  expect(bakedPath).toBeDefined()
  expect(readFileSync(join(bakedPath!, 'SKILL.md'), 'utf8')).toBe(inlineContent)

  rmSync(tmp, { recursive: true, force: true })
})

test('sync.skills yields to include when both provide the same name', async () => {
  // Regression guard for the dev-mode edit path: when both sync.include and
  // sync.skills produce an entry with the same name, the glob match must
  // win because it's read from the live source tree, not whatever stale
  // string was baked in at last build.
  const tmp = join(tmpdir(), `clac-inline-override-test-${Date.now()}`)
  mkdirSync(tmp, { recursive: true })

  const cli = Cli.create('override-tool', { description: 'Override test' })
  cli.command('ping', { description: 'Health check', run: () => ({}) })

  const commands = Cli.toCommands.get(cli)!
  const installDir = join(tmp, 'install')
  mkdirSync(join(installDir, '.agents', 'skills'), { recursive: true })

  // Stage a fresh SKILL.md in the source tree that `include` will find.
  const skillDir = join(installDir, 'skills', 'shared-skill')
  mkdirSync(skillDir, { recursive: true })
  const freshContent = `---
name: shared-skill
description: Live source content (fresher than baked).
---

# Live version
`
  writeFileSync(join(skillDir, 'SKILL.md'), freshContent)

  const staleContent = `---
name: shared-skill
description: Stale baked content.
---

# Baked (should lose)
`

  const result = await SyncSkills.sync('override-tool', commands, {
    global: false,
    cwd: installDir,
    include: ['skills/*'],
    skills: [{ name: 'shared-skill', content: staleContent }],
  })

  const shared = result.skills.find((s) => s.name === 'shared-skill')
  expect(shared).toBeDefined()
  // Description comes from the live glob match, not the baked string.
  expect(shared?.description).toBe('Live source content (fresher than baked).')

  const sharedPath = result.paths.find((p) => p.endsWith('shared-skill'))
  expect(sharedPath).toBeDefined()
  expect(readFileSync(join(sharedPath!, 'SKILL.md'), 'utf8')).toBe(freshContent)

  rmSync(tmp, { recursive: true, force: true })
})

test('installed SKILL.md contains frontmatter', async () => {
  const tmp = join(tmpdir(), `clac-content-test-${Date.now()}`)
  mkdirSync(tmp, { recursive: true })

  const cli = Cli.create('my-tool', { description: 'A useful tool' })
  cli.command('run', { description: 'Run something', run: () => ({}) })

  const commands = Cli.toCommands.get(cli)!
  const installDir = join(tmp, 'install')
  mkdirSync(join(installDir, '.agents', 'skills'), { recursive: true })

  const result = await SyncSkills.sync('my-tool', commands, {
    global: false,
    cwd: installDir,
  })

  const skillPath = result.paths[0]!
  const content = readFileSync(join(skillPath, 'SKILL.md'), 'utf8')
  expect(content).toContain('name:')
  expect(content).toContain('description:')

  rmSync(tmp, { recursive: true, force: true })
})
