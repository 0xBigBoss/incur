import { describe, expect, test, vi } from 'vitest'

vi.mock('./SyncSkills.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./SyncSkills.js')>()
  return { ...actual, readHash: () => undefined }
})

import { app as prefixedApp } from '../test/fixtures/hono-api-prefixed.js'
import { app } from '../test/fixtures/hono-api.js'
import { app as openapiApp, spec as openapiSpec } from '../test/fixtures/hono-openapi-app.js'
import { spec } from '../test/fixtures/openapi-spec.js'
import * as Cli from './Cli.js'
import * as Openapi from './Openapi.js'

function serve(cli: { serve: Cli.Cli['serve'] }, argv: string[]) {
  let output = ''
  let exitCode: number | undefined
  return cli
    .serve(argv, {
      stdout: (s) => (output += s),
      stderr: (s) => (output += s),
      exit: (c) => {
        exitCode = c
      },
    })
    .then(() => ({
      output,
      exitCode,
    }))
}

function json(output: string) {
  return JSON.parse(output.replace(/"duration": "[^"]+"/g, '"duration": "<stripped>"'))
}

describe('generateCommands', () => {
  test('generates command entries from spec', async () => {
    const commands = await Openapi.generateCommands(spec, app.fetch)
    expect(commands.has('listUsers')).toBe(true)
    expect(commands.has('createUser')).toBe(true)
    expect(commands.has('getUser')).toBe(true)
    expect(commands.has('deleteUser')).toBe(true)
    expect(commands.has('healthCheck')).toBe(true)
  })

  test('command has description from summary', async () => {
    const commands = await Openapi.generateCommands(spec, app.fetch)
    const cmd = commands.get('listUsers')!
    expect(cmd.description).toBe('List users')
  })

  test('non-object request body (array) is submitted via --body escape hatch', async () => {
    // Issue 1 regression: the generator used to flatten `bodySchema.properties`
    // into option flags only. For endpoints whose request body is a top-level
    // array or primitive, `properties` is undefined and the handler silently
    // dropped the body — making the endpoint uninvokable. The fix: always
    // expose a `--body` option (raw JSON string) when the endpoint has any
    // request body; handler prefers it over the flattened-prop fallback.
    const arraySpec = {
      openapi: '3.0.0',
      info: { title: 'Bulk API', version: '1.0.0' },
      paths: {
        '/bulk/insert': {
          post: {
            operationId: 'bulkInsert',
            summary: 'Insert many',
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: { type: 'array', items: { type: 'string' } },
                },
              },
            },
            responses: {
              '200': { description: 'ok', content: { 'application/json': { schema: {} } } },
            },
          },
        },
      },
    } as const

    let capturedBody: string | undefined
    let capturedContentType: string | null = null
    const fetch = async (req: Request) => {
      capturedBody = await req.text()
      capturedContentType = req.headers.get('content-type')
      return new Response(JSON.stringify({ received: JSON.parse(capturedBody) }), {
        headers: { 'content-type': 'application/json' },
      })
    }

    const commands = await Openapi.generateCommands(arraySpec as any, fetch)
    const bulkInsert = commands.get('bulkInsert')!
    expect(bulkInsert).toBeDefined()
    // The generator exposes `--body` when the body schema isn't an object,
    // even if it's required. The handler passes the raw JSON string through.
    const context = {
      args: {},
      options: { body: '["alpha","beta","gamma"]' },
      error: (e: any) => ({ error: e }),
      ok: (d: any) => d,
    }
    const result = await bulkInsert.run(context)
    expect(capturedBody).toBe('["alpha","beta","gamma"]')
    expect(capturedContentType).toBe('application/json')
    expect(result).toEqual({ received: ['alpha', 'beta', 'gamma'] })
  })

  test('Swagger 2 required non-object body rejects empty invocations at handler time', async () => {
    // Issue 4 regression: `bodyRequiredTopLevel` used to only check
    // `op.requestBody?.required` (OpenAPI 3 shape), so a Swagger 2
    // endpoint declaring `in: body, required: true, schema: { type:
    // 'array' }` silently fell through and the command accepted an
    // empty invocation, calling the server with no payload. Fix: union
    // the Swagger 2 body parameter's own `required` field into the
    // requiredness check, and enforce at handler time (not schema
    // time, because that would block the `--json` full-payload path).
    let fetchCalled = false
    const fetch = async (_req: Request) => {
      fetchCalled = true
      return new Response('{}', { headers: { 'content-type': 'application/json' } })
    }
    const swagger2Spec = {
      swagger: '2.0',
      info: { title: 'Legacy', version: '1.0.0' },
      paths: {
        '/bulk': {
          post: {
            operationId: 'bulk',
            parameters: [
              {
                name: 'items',
                in: 'body',
                required: true,
                schema: { type: 'array', items: { type: 'string' } },
              },
            ],
            responses: { '200': { description: 'ok', schema: {} } },
          },
        },
      },
    } as const
    const commands = await Openapi.generateCommands(swagger2Spec as any, fetch)
    const bulk = commands.get('bulk')!
    expect(bulk).toBeDefined()
    // Empty invocation: handler returns a VALIDATION_ERROR and never
    // calls the server.
    const errorResult = await bulk.run({
      args: {},
      options: {},
      error: (e: any) => e,
      ok: (d: any) => d,
    })
    expect(errorResult).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: expect.stringContaining('request body is required'),
    })
    expect(fetchCalled).toBe(false)
    // Valid `--body` string is accepted and actually hits the server.
    await bulk.run({
      args: {},
      options: { body: '["alpha","beta"]' },
      error: (e: any) => e,
      ok: (d: any) => d,
    })
    expect(fetchCalled).toBe(true)
  })

  test('--json payload routes array bodies to options.body for OpenAPI handlers', async () => {
    // Issue 5 regression: `--json` is the framework's documented way
    // to pass the full body payload in one flag, but
    // `resolveCommandOptions` used to always `{ ...options,
    // ...parsedPayload }` — which silently drops array and primitive
    // payloads (spreading an array into an object produces numeric
    // keys). The OpenAPI handler only looks at `options.body` and
    // flattened props, so `--json '["a","b"]'` for an array body
    // sent nothing at all. Fix: detect non-object payloads in
    // `resolveCommandOptions` and route them to `options.body` as the
    // raw JSON string, preserving the existing object-spread path.
    let capturedBody: string | undefined
    const fetch = async (req: Request) => {
      capturedBody = await req.text()
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' },
      })
    }
    const arraySpec = {
      openapi: '3.0.0',
      info: { title: 'Bulk', version: '1.0.0' },
      paths: {
        '/bulk': {
          post: {
            operationId: 'bulkJson',
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: { type: 'array', items: { type: 'string' } },
                },
              },
            },
            responses: {
              '200': { description: 'ok', content: { 'application/json': { schema: {} } } },
            },
          },
        },
      },
    } as const
    const cli = Cli.create('bulk-cli').command('api', {
      fetch,
      openapi: arraySpec as any,
    })
    const { output, exitCode } = await serve(cli, [
      'api',
      'bulkJson',
      '--json',
      '["alpha","beta","gamma"]',
      '--format',
      'json',
    ])
    expect(exitCode).toBeUndefined()
    expect(capturedBody).toBe('["alpha","beta","gamma"]')
    expect(json(output)).toEqual({ ok: true })
  })

  test('--json payload works for required object bodies (end-to-end via cli.serve)', async () => {
    // Issue 6 regression: even after Issues 4 and 5 were fixed, required
    // per-prop flags on object bodies were still emitted as
    // schema-required, so `api createUser --json '{"name":"Bob"}'`
    // failed Parser validation with "name is missing" before
    // `resolveCommandOptions` got a chance to merge the --json payload
    // into options. Fix: always mark flattened per-prop flags as
    // optional at schema time and enforce requiredness in the handler
    // AFTER the merge. This test is the reviewer's exact repro
    // against the shipped `createUser` OpenAPI 3 fixture.
    let capturedBody: string | undefined
    const fetch = async (req: Request) => {
      capturedBody = await req.text()
      return new Response(JSON.stringify({ created: true, name: 'Bob' }), {
        headers: { 'content-type': 'application/json' },
      })
    }
    const cli = Cli.create('t').command('api', { fetch, openapi: spec })
    // Happy path: --json supplies the required `name`.
    const happy = await serve(cli, [
      'api',
      'createUser',
      '--json',
      '{"name":"Bob"}',
      '--format',
      'json',
    ])
    expect(happy.exitCode).toBeUndefined()
    expect(capturedBody).toBe('{"name":"Bob"}')
    expect(json(happy.output)).toEqual({ created: true, name: 'Bob' })

    // Missing required field via --json: resolveCommandOptions validates
    // the payload against the full body schema and rejects before the
    // handler runs. Fetch is not called.
    capturedBody = undefined
    const missingJson = await serve(cli, ['api', 'createUser', '--json', '{}', '--format', 'json'])
    expect(missingJson.exitCode).toBe(1)
    expect(capturedBody).toBeUndefined()
    expect(missingJson.output).toContain('VALIDATION_ERROR')
    expect(missingJson.output).toContain('name')

    // Missing required field via --body (the raw escape hatch bypasses
    // `resolveCommandOptions` schema validation because --body is a
    // string, not the parsed payload). The handler's post-merge gate
    // catches it and emits a VALIDATION_ERROR that names the missing
    // field. This is the path my handler validation specifically
    // covers — it's unreachable via --json.
    capturedBody = undefined
    const missingBody = await serve(cli, ['api', 'createUser', '--body', '{}', '--format', 'json'])
    expect(missingBody.exitCode).toBe(1)
    expect(capturedBody).toBeUndefined()
    expect(missingBody.output).toContain('missing required body fields')
    expect(missingBody.output).toContain('name')

    // Flattened --<prop> path still works for the common case.
    capturedBody = undefined
    const flat = await serve(cli, ['api', 'createUser', '--name', 'Alice', '--format', 'json'])
    expect(flat.exitCode).toBeUndefined()
    expect(capturedBody).toBe('{"name":"Alice"}')
  })

  test('object request body still accepts flattened --<prop> options', async () => {
    // Regression guard: the Issue 1 fix added a `--body` escape hatch but must
    // not break the existing flattened-property convenience for object bodies.
    let capturedBody: string | undefined
    const fetch = async (req: Request) => {
      capturedBody = await req.text()
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' },
      })
    }
    const commands = await Openapi.generateCommands(spec, fetch)
    const createUser = commands.get('createUser')!
    await createUser.run({
      args: {},
      options: { name: 'Bob' },
      error: (e: any) => ({ error: e }),
      ok: (d: any) => d,
    })
    expect(capturedBody).toBe('{"name":"Bob"}')
  })
})

describe('cli integration', () => {
  function createCli() {
    return Cli.create('test', { description: 'test' }).command('api', {
      fetch: app.fetch,
      openapi: spec,
    })
  }

  test('GET /users via operationId', async () => {
    const { output } = await serve(createCli(), ['api', 'listUsers'])
    expect(output).toContain('Alice')
  })

  test('GET /users?limit=5 via options', async () => {
    const { output } = await serve(createCli(), [
      'api',
      'listUsers',
      '--limit',
      '5',
      '--format',
      'json',
    ])
    expect(json(output).limit).toBe(5)
  })

  test('GET /users/:id via positional arg', async () => {
    const { output } = await serve(createCli(), ['api', 'getUser', '42'])
    expect(output).toMatchInlineSnapshot(`
      "id: 42
      name: Alice
      "
    `)
  })

  test('POST /users via createUser with body options', async () => {
    const { output } = await serve(createCli(), ['api', 'createUser', '--name', 'Bob'])
    expect(output).toMatchInlineSnapshot(`
      "created: true
      name: Bob
      "
    `)
  })

  test('DELETE /users/:id via deleteUser', async () => {
    const { output } = await serve(createCli(), ['api', 'deleteUser', '1'])
    expect(output).toMatchInlineSnapshot(`
      "deleted: true
      id: 1
      "
    `)
  })

  test('GET /health via healthCheck', async () => {
    const { output } = await serve(createCli(), ['api', 'healthCheck'])
    expect(output).toMatchInlineSnapshot(`
      "ok: true
      "
    `)
  })

  test('--help on api shows subcommands', async () => {
    const { output } = await serve(createCli(), ['api', '--help'])
    expect(output).toContain('listUsers')
    expect(output).toContain('createUser')
    expect(output).toContain('getUser')
    expect(output).toContain('deleteUser')
    expect(output).toContain('healthCheck')
  })

  test('--help on specific command shows typed args/options', async () => {
    const { output } = await serve(createCli(), ['api', 'getUser', '--help'])
    expect(output).toContain('id')
    expect(output).toContain('Get a user by ID')
  })

  test('--help on createUser shows body options', async () => {
    const { output } = await serve(createCli(), ['api', 'createUser', '--help'])
    expect(output).toContain('name')
    expect(output).toContain('Create a user')
  })

  test('--format json', async () => {
    const { output } = await serve(createCli(), ['api', 'healthCheck', '--format', 'json'])
    expect(json(output)).toEqual({ ok: true })
  })

  test('--verbose wraps in envelope', async () => {
    const { output } = await serve(createCli(), [
      'api',
      'healthCheck',
      '--verbose',
      '--format',
      'json',
    ])
    const parsed = json(output)
    expect(parsed.ok).toBe(true)
    expect(parsed.data).toEqual({ ok: true })
    expect(parsed.meta.command).toContain('api')
  })

  test('missing required path param shows validation error', async () => {
    const { exitCode } = await serve(createCli(), ['api', 'getUser'])
    expect(exitCode).toBe(1)
  })
})

describe('@hono/zod-openapi integration', () => {
  function createCli() {
    return Cli.create('test', { description: 'test' }).command('api', {
      fetch: openapiApp.fetch,
      openapi: openapiSpec,
    })
  }

  test('GET /users via listUsers', async () => {
    const { output } = await serve(createCli(), ['api', 'listUsers'])
    expect(output).toContain('Alice')
  })

  test('GET /users?limit=5', async () => {
    const { output } = await serve(createCli(), [
      'api',
      'listUsers',
      '--limit',
      '5',
      '--format',
      'json',
    ])
    expect(json(output).limit).toBe(5)
  })

  test('GET /users/:id via getUser', async () => {
    const { output } = await serve(createCli(), ['api', 'getUser', '42'])
    expect(output).toMatchInlineSnapshot(`
      "id: 42
      name: Alice
      "
    `)
  })

  test('POST /users via createUser', async () => {
    const { output } = await serve(createCli(), ['api', 'createUser', '--name', 'Bob'])
    expect(output).toMatchInlineSnapshot(`
      "created: true
      name: Bob
      "
    `)
  })

  test('DELETE /users/:id via deleteUser', async () => {
    const { output } = await serve(createCli(), ['api', 'deleteUser', '1'])
    expect(output).toMatchInlineSnapshot(`
      "deleted: true
      id: 1
      "
    `)
  })

  test('GET /health via healthCheck', async () => {
    const { output } = await serve(createCli(), ['api', 'healthCheck'])
    expect(output).toMatchInlineSnapshot(`
      "ok: true
      "
    `)
  })

  test('--help shows operationId commands', async () => {
    const { output } = await serve(createCli(), ['api', '--help'])
    expect(output).toContain('listUsers')
    expect(output).toContain('getUser')
    expect(output).toContain('createUser')
    expect(output).toContain('deleteUser')
    expect(output).toContain('healthCheck')
    expect(output).toContain('updateUser')
  })

  test('--help on getUser shows path param', async () => {
    const { output } = await serve(createCli(), ['api', 'getUser', '--help'])
    expect(output).toContain('id')
  })

  test('--help on createUser shows body options', async () => {
    const { output } = await serve(createCli(), ['api', 'createUser', '--help'])
    expect(output).toContain('name')
  })

  test('--help on updateUser shows path param and body options', async () => {
    const { output } = await serve(createCli(), ['api', 'updateUser', '--help'])
    expect(output).toContain('id')
    expect(output).toContain('name')
    expect(output).toContain('Update a user')
  })

  test('--format json', async () => {
    const { output } = await serve(createCli(), ['api', 'healthCheck', '--format', 'json'])
    expect(json(output)).toEqual({ ok: true })
  })

  test('--verbose wraps in envelope', async () => {
    const { output } = await serve(createCli(), [
      'api',
      'healthCheck',
      '--verbose',
      '--format',
      'json',
    ])
    const parsed = json(output)
    expect(parsed.ok).toBe(true)
    expect(parsed.data).toEqual({ ok: true })
    expect(parsed.meta.command).toContain('api')
  })

  test('missing required path param shows validation error', async () => {
    const { exitCode } = await serve(createCli(), ['api', 'getUser'])
    expect(exitCode).toBe(1)
  })

  test('PUT /users/:id with path param + body options', async () => {
    const { output } = await serve(createCli(), ['api', 'updateUser', '1', '--name', 'Updated'])
    expect(output).toMatchInlineSnapshot(`
      "id: 1
      name: Updated
      "
    `)
  })

  test('PUT /users/:id with optional boolean body option', async () => {
    const { output } = await serve(createCli(), [
      'api',
      'updateUser',
      '1',
      '--name',
      'Updated',
      '--active',
      'true',
      '--format',
      'json',
    ])
    const parsed = json(output)
    expect(parsed.id).toBe(1)
    expect(parsed.name).toBe('Updated')
    expect(parsed.active).toBe(true)
  })

  test('query param coercion with zod-openapi generated spec', async () => {
    const { output } = await serve(createCli(), [
      'api',
      'listUsers',
      '--limit',
      '3',
      '--format',
      'json',
    ])
    expect(json(output).limit).toBe(3)
  })
})

describe('basePath', () => {
  test('fetch gateway prepends basePath to request path', async () => {
    const cli = Cli.create('test', { description: 'test' }).command('api', {
      fetch: prefixedApp.fetch,
      basePath: '/api',
    })
    const { output } = await serve(cli, ['api', 'users'])
    expect(output).toContain('Alice')
  })

  test('fetch gateway basePath with query params', async () => {
    const cli = Cli.create('test', { description: 'test' }).command('api', {
      fetch: prefixedApp.fetch,
      basePath: '/api',
    })
    const { output } = await serve(cli, ['api', 'users', '--limit', '5', '--format', 'json'])
    expect(json(output).limit).toBe(5)
  })

  test('fetch gateway basePath with POST', async () => {
    const cli = Cli.create('test', { description: 'test' }).command('api', {
      fetch: prefixedApp.fetch,
      basePath: '/api',
    })
    const { output } = await serve(cli, ['api', 'users', '-X', 'POST', '-d', '{"name":"Bob"}'])
    expect(output).toContain('Bob')
    expect(output).toContain('created')
  })

  test('openapi with basePath prepends to spec paths', async () => {
    const cli = Cli.create('test', { description: 'test' }).command('api', {
      fetch: prefixedApp.fetch,
      openapi: spec,
      basePath: '/api',
    })
    const { output } = await serve(cli, ['api', 'listUsers'])
    expect(output).toContain('Alice')
  })

  test('openapi basePath with path params', async () => {
    const cli = Cli.create('test', { description: 'test' }).command('api', {
      fetch: prefixedApp.fetch,
      openapi: spec,
      basePath: '/api',
    })
    const { output } = await serve(cli, ['api', 'getUser', '42'])
    expect(output).toMatchInlineSnapshot(`
      "id: 42
      name: Alice
      "
    `)
  })

  test('openapi basePath with body options', async () => {
    const cli = Cli.create('test', { description: 'test' }).command('api', {
      fetch: prefixedApp.fetch,
      openapi: spec,
      basePath: '/api',
    })
    const { output } = await serve(cli, ['api', 'createUser', '--name', 'Bob'])
    expect(output).toContain('created')
    expect(output).toContain('Bob')
  })

  test('openapi basePath with health check', async () => {
    const cli = Cli.create('test', { description: 'test' }).command('api', {
      fetch: prefixedApp.fetch,
      openapi: spec,
      basePath: '/api',
    })
    const { output } = await serve(cli, ['api', 'healthCheck', '--format', 'json'])
    expect(json(output)).toEqual({ ok: true })
  })
})
