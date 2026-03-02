import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { detectRunner } from './internal/pm.js'
import { detectPackageSpecifier } from './SyncMcp.js'

/** Default check interval: 24 hours. */
const DEFAULT_INTERVAL = 86_400_000

/** Default npm registry URL. */
const DEFAULT_REGISTRY = 'https://registry.npmjs.org'

/** Default fetch timeout in milliseconds. */
const FETCH_TIMEOUT = 3_000

/** Checks the npm registry for a newer version. Returns the latest version if an update is available, `undefined` otherwise. Caches the check timestamp to avoid hitting the registry on every invocation. */
export async function check(
  name: string,
  currentVersion: string,
  options: check.Options = {},
): Promise<string | undefined> {
  const interval = options.interval ?? DEFAULT_INTERVAL
  const meta = readMeta(name)
  if (meta?.checkedAt && Date.now() - new Date(meta.checkedAt).getTime() < interval) {
    // Within throttle window — use cached result
    if (meta.latestVersion && compareVersions(meta.latestVersion, currentVersion) > 0)
      return meta.latestVersion
    return undefined
  }

  const registry = options.registry ?? DEFAULT_REGISTRY
  const url = `${registry.replace(/\/$/, '')}/${encodeURIComponent(name)}/latest`

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
    if (!res.ok) return undefined
    const pkg = (await res.json()) as { version?: string }
    const latest = pkg.version
    if (!latest) return undefined

    writeMeta(name, { latestVersion: latest, checkedAt: new Date().toISOString() })

    if (compareVersions(latest, currentVersion) > 0) return latest
    return undefined
  } catch {
    return undefined
  } finally {
    clearTimeout(timeout)
  }
}

export declare namespace check {
  /** Options for checking for updates. */
  type Options = {
    /** Check interval in milliseconds. Defaults to 24 hours. */
    interval?: number | undefined
    /** npm registry URL. Defaults to `https://registry.npmjs.org`. */
    registry?: string | undefined
  }
}

/** Runs the package manager install command to update the CLI globally. Returns the installed version. */
export async function update(name: string): Promise<update.Result> {
  const runner = detectRunner()
  const spec = detectPackageSpecifier(name)

  // Map runner to install command
  const { cmd, args } = installCommand(runner, spec)
  const { stdout } = await exec(cmd, args)

  return { stdout: stdout.trim() }
}

export declare namespace update {
  /** Result of an update operation. */
  type Result = {
    /** Raw stdout from the install command. */
    stdout: string
  }
}

/** @internal Builds the install command for a package manager. */
function installCommand(
  runner: string,
  spec: string,
): { cmd: string; args: string[] } {
  if (runner === 'pnpx') return { cmd: 'pnpm', args: ['add', '-g', `${spec}@latest`] }
  if (runner === 'bunx') return { cmd: 'bun', args: ['add', '-g', `${spec}@latest`] }
  return { cmd: 'npm', args: ['install', '-g', `${spec}@latest`] }
}

/** @internal Compares two semver strings. Returns >0 if a > b, <0 if a < b, 0 if equal. */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map(Number)
  const pb = b.replace(/^v/, '').split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** @internal Returns the metadata file path for a CLI. */
function metaPath(name: string): string {
  const dir = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
  return join(dir, 'incur', `${name}.json`)
}

/** @internal Reads the stored metadata for a CLI. */
function readMeta(name: string): Meta | undefined {
  try {
    return JSON.parse(readFileSync(metaPath(name), 'utf-8'))
  } catch {
    return undefined
  }
}

/** @internal Writes update metadata, merging with existing data. */
function writeMeta(name: string, data: { latestVersion: string; checkedAt: string }) {
  const file = metaPath(name)
  const dir = file.substring(0, file.lastIndexOf('/'))
  let existing: Record<string, unknown> = {}
  try {
    existing = JSON.parse(readFileSync(file, 'utf-8'))
  } catch {}
  const merged = { ...existing, ...data }
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(file, JSON.stringify(merged) + '\n')
}

/** @internal Metadata stored in the shared meta file. */
type Meta = {
  checkedAt?: string | undefined
  hash?: string | undefined
  latestVersion?: string | undefined
  skills?: string[] | undefined
}

/** Promisified execFile with stderr in error message. */
function exec(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (error, stdout, stderr) => {
      if (error) {
        const msg = stderr?.trim() || stdout?.trim() || error.message
        reject(new Error(msg))
      } else resolve({ stdout, stderr })
    })
  })
}
