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
  expect(result.skills.map((s) => s.name)).toContain('greet')
  expect(result.skills.map((s) => s.name)).toContain('ping')

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

test('writes CONTEXT.md with rules and command names', async () => {
  const tmp = join(tmpdir(), `clac-context-test-${Date.now()}`)
  mkdirSync(tmp, { recursive: true })

  const cli = Cli.create('my-tool', { description: 'A useful tool' })
  cli.command('run', { description: 'Run something', run: () => ({}) })
  cli.command('destroy', {
    description: 'Destroy something',
    mutates: true,
    destructive: true,
    run: () => ({}),
  })

  const commands = Cli.toCommands.get(cli)!
  const installDir = join(tmp, 'install')
  mkdirSync(join(installDir, '.agents', 'skills'), { recursive: true })

  await SyncSkills.sync('my-tool', commands, {
    global: false,
    cwd: installDir,
    contextRules: ['Confirm destructive actions with the user.'],
  })

  const content = readFileSync(join(installDir, 'CONTEXT.md'), 'utf8')
  expect(content).toContain('# my-tool Context')
  expect(content).toContain('Confirm destructive actions with the user.')
  expect(content).toContain('- run')
  expect(content).toContain('- destroy')

  rmSync(tmp, { recursive: true, force: true })
})

test('global sync writes CONTEXT.md to the canonical agent directory instead of the package root', async () => {
  const tmp = join(tmpdir(), `clac-global-context-test-${Date.now()}`)
  const homeDir = join(tmp, 'home')
  const packageRoot = join(tmp, 'pkg')
  const binPath = join(packageRoot, 'dist', 'bin.js')
  mkdirSync(homeDir, { recursive: true })
  mkdirSync(join(packageRoot, 'dist'), { recursive: true })
  writeFileSync(join(packageRoot, 'package.json'), '{}\n')
  writeFileSync(binPath, '')

  const savedHome = process.env.HOME
  const savedArgv1 = process.argv[1]

  try {
    process.env.HOME = homeDir
    process.argv[1] = binPath
    vi.resetModules()

    const FreshCli = await import('./Cli.js')
    const FreshSyncSkills = await import('./SyncSkills.js')

    const cli = FreshCli.create('my-tool', { description: 'A useful tool' })
    cli.command('run', { description: 'Run something', run: () => ({}) })

    const commands = FreshCli.toCommands.get(cli)!
    await FreshSyncSkills.sync('my-tool', commands, {
      contextRules: ['Confirm destructive actions with the user.'],
    })

    expect(existsSync(join(packageRoot, 'CONTEXT.md'))).toBe(false)

    const content = readFileSync(join(homeDir, '.agents', 'CONTEXT.md'), 'utf8')
    expect(content).toContain('# my-tool Context')
    expect(content).toContain('Confirm destructive actions with the user.')
    expect(content).toContain('- run')
  } finally {
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
    if (savedArgv1 === undefined) process.argv.splice(1, 1)
    else process.argv[1] = savedArgv1
    vi.resetModules()
    rmSync(tmp, { recursive: true, force: true })
  }
})
