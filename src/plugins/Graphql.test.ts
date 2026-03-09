import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import { Cli, Plugins } from 'incur'
import { buildSchema, graphql, introspectionFromSchema } from 'graphql'

import { introspection, startTestServer } from '../../test/fixtures/graphql/server.js'
import { createSelection } from './graphql/Selection.js'

async function serve(
  cli: { serve: Cli.Cli['serve'] },
  argv: string[],
  options: Cli.serve.Options = {},
) {
  let output = ''
  let exitCode: number | undefined
  await cli.serve(argv, {
    stdout(s) {
      output += s
    },
    exit(code) {
      exitCode = code
    },
    ...options,
  })
  return { exitCode, output }
}

describe('graphql', () => {
  test('loads introspection schema and enumerates root query and mutation fields', async () => {
    const server = await startTestServer()
    try {
      const cli = Cli.create('acme').plugin(
        'graphql',
        Plugins.graphql({
          schema: introspection,
          transport: {
            url: server.baseUrl,
          },
        }),
      )

      const manifest = await serve(cli, ['graphql', '--llms', '--format', 'json'])
      expect(JSON.parse(manifest.output).commands.map((command: any) => command.name)).toEqual([
        'graphql delete-user',
        'graphql get-user',
        'graphql list-users',
        'graphql raw',
        'graphql update-user',
      ])
    } finally {
      await server.close()
    }
  })

  test('infers argument schemas from field arguments and marks mutations as mutating', async () => {
    const server = await startTestServer()
    try {
      const cli = Cli.create('acme').plugin(
        'graphql',
        Plugins.graphql({
          schema: introspection,
          transport: {
            url: server.baseUrl,
          },
        }),
      )

      const schema = await serve(cli, ['schema', 'graphql', 'update-user', '--format', 'json'])
      expect(JSON.parse(schema.output)).toMatchObject({
        name: 'graphql update-user',
        schema: {
          input: {
            properties: {
              input: {
                properties: {
                  email: { type: 'string' },
                  status: { enum: ['ACTIVE', 'DISABLED'] },
                  userId: { type: 'string' },
                },
                required: ['userId'],
                type: 'object',
              },
            },
            required: ['input'],
          },
          options: {
            properties: {
              json: { type: 'string' },
            },
          },
        },
      })

      const manifest = await serve(cli, ['graphql', '--llms-full', '--format', 'json'])
      expect(
        JSON.parse(manifest.output).commands.find((command: any) => command.name === 'graphql update-user'),
      ).toMatchObject({
        mutates: true,
      })
    } finally {
      await server.close()
    }
  })

  test('synthesizes deterministic selections with bounded nested expansion', async () => {
    const server = await startTestServer()
    try {
      const cli = Cli.create('acme').plugin(
        'graphql',
        Plugins.graphql({
          schema: introspection,
          transport: {
            url: server.baseUrl,
          },
        }),
      )

      const result = await serve(cli, ['graphql', 'get-user', '--userId', 'u-1', '--format', 'json'])
      expect(JSON.parse(result.output)).toEqual({
        email: 'u-1@acme.dev',
        id: 'u-1',
        manager: {
          email: 'u-1-mgr-1@acme.dev',
          id: 'u-1-mgr-1',
          status: 'ACTIVE',
        },
        status: 'ACTIVE',
      })

      const manifest = await serve(cli, ['graphql', '--llms-full', '--format', 'json'])
      const command = JSON.parse(manifest.output).commands.find(
        (entry: any) => entry.name === 'graphql get-user',
      )
      const outputSchema = command.schema.output.anyOf[0]
      expect(outputSchema.properties.id.anyOf[0]).toMatchObject({ type: 'string' })
      expect(outputSchema.properties.manager.anyOf[0].properties.id.anyOf[0]).toMatchObject({
        type: 'string',
      })
    } finally {
      await server.close()
    }
  })

  test('merges scalar args with --json payloads for mixed GraphQL mutations', async () => {
    const schema = buildSchema(/* GraphQL */ `
      type Issue {
        id: ID!
        email: String!
      }

      input IssueUpdateInput {
        email: String
      }

      type Query {
        noop: String!
      }

      type Mutation {
        issueUpdate(id: ID!, input: IssueUpdateInput!): Issue!
      }
    `)
    const introspection = introspectionFromSchema(schema)
    const server = createServer(async (req, res) => {
      if (req.method !== 'POST' || req.url !== '/graphql') {
        res.statusCode = 404
        res.end('not found')
        return
      }

      let body = ''
      for await (const chunk of req) body += chunk.toString()

      const payload = JSON.parse(body || '{}') as {
        operationName?: string | undefined
        query?: string | undefined
        variables?: Record<string, unknown> | undefined
      }

      const result = await graphql({
        operationName: payload.operationName,
        rootValue: {
          issueUpdate({
            id,
            input,
          }: {
            id: string
            input: { email?: string | undefined }
          }) {
            return {
              email: input.email ?? `${id}@acme.dev`,
              id,
            }
          },
          noop() {
            return 'ok'
          },
        },
        schema,
        source: payload.query ?? '',
        variableValues: payload.variables,
      })

      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(result))
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as AddressInfo

    try {
      const cli = Cli.create('acme').plugin(
        'graphql',
        Plugins.graphql({
          schema: introspection,
          transport: {
            url: `http://127.0.0.1:${address.port}/graphql`,
          },
        }),
      )

      const result = await serve(cli, [
        'graphql',
        'issue-update',
        '--id',
        'ISS-1',
        '--json',
        '{"input":{"email":"issue@example.com"}}',
        '--format',
        'json',
      ])

      expect(result.exitCode).toBeUndefined()
      expect(JSON.parse(result.output)).toEqual({
        email: 'issue@example.com',
        id: 'ISS-1',
      })
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error) reject(error)
          else resolve()
        }),
      )
    }
  })

  test('supports raw graphql via --query, --file, stdin, variables, and operation name', async () => {
    const server = await startTestServer()
    const dir = await mkdtemp(join(tmpdir(), 'incur-graphql-'))
    const file = join(dir, 'query.graphql')
    await writeFile(
      file,
      'query GetUser($userId: ID!) { getUser(userId: $userId) { id email status } }',
      'utf8',
    )

    const stdin = new PassThrough()
    const original = Object.getOwnPropertyDescriptor(process, 'stdin')

    try {
      const cli = Cli.create('acme').plugin(
        'graphql',
        Plugins.graphql({
          schema: introspection,
          transport: {
            url: server.baseUrl,
          },
        }),
      )

      const fromQuery = await serve(cli, [
        'graphql',
        'raw',
        '--query',
        'query GetUser($userId: ID!) { getUser(userId: $userId) { id email status } }',
        '--variables',
        '{"userId":"u-1"}',
        '--operationName',
        'GetUser',
        '--format',
        'json',
      ])
      expect(JSON.parse(fromQuery.output)).toEqual({
        getUser: {
          email: 'u-1@acme.dev',
          id: 'u-1',
          status: 'ACTIVE',
        },
      })

      const fromFile = await serve(cli, [
        'graphql',
        'raw',
        '--file',
        file,
        '--variables',
        '{"userId":"u-2"}',
        '--operationName',
        'GetUser',
        '--format',
        'json',
      ])
      expect(JSON.parse(fromFile.output)).toEqual({
        getUser: {
          email: 'u-2@acme.dev',
          id: 'u-2',
          status: 'ACTIVE',
        },
      })

      Object.defineProperty(process, 'stdin', { configurable: true, value: stdin })
      stdin.end('query GetUser($userId: ID!) { getUser(userId: $userId) { id email status } }')

      const fromStdin = await serve(cli, [
        'graphql',
        'raw',
        '--variables',
        '{"userId":"u-3"}',
        '--operationName',
        'GetUser',
        '--format',
        'json',
      ])
      expect(JSON.parse(fromStdin.output)).toEqual({
        getUser: {
          email: 'u-3@acme.dev',
          id: 'u-3',
          status: 'ACTIVE',
        },
      })
    } finally {
      if (original) Object.defineProperty(process, 'stdin', original)
      await server.close()
    }
  })

  test('surfaces structured graphql errors for raw execution', async () => {
    const server = await startTestServer()
    try {
      const cli = Cli.create('acme').plugin(
        'graphql',
        Plugins.graphql({
          schema: introspection,
          transport: {
            url: server.baseUrl,
          },
        }),
      )

      const result = await serve(cli, [
        'graphql',
        'raw',
        '--query',
        'query GetUser($userId: ID!) { getUser(userId: $userId) { id } }',
        '--variables',
        '{"userId":"missing"}',
        '--operationName',
        'GetUser',
        '--format',
        'json',
      ])

      expect(result.exitCode).toBe(1)
      expect(JSON.parse(result.output)).toMatchObject({
        code: 'GRAPHQL_OPERATION_FAILED',
        message: 'user was not found',
      })
    } finally {
      await server.close()
    }
  })

  test('fails plugin resolution when a generated command would collide with graphql raw', async () => {
    const cli = Cli.create('acme').plugin(
      'graphql',
      Plugins.graphql({
        schema: 'type Query { raw: String! }',
        transport: {
          url: 'https://example.test/graphql',
        },
      }),
    )

    const result = await serve(cli, ['--help', '--format', 'json'])
    expect(result.exitCode).toBe(1)
    expect(JSON.parse(result.output)).toMatchObject({
      code: 'PLUGIN_RESOLUTION_FAILED',
      message: "Failed to resolve plugin 'graphql': Duplicate GraphQL command name 'raw'",
    })
  })

  test('rejects list arguments configured as positionals', async () => {
    const cli = Cli.create('acme').plugin(
      'graphql',
      Plugins.graphql({
        schema: 'type Query { echo(ids: [ID!]!): String! }',
        positionals: {
          echo: ['ids'],
        },
        transport: {
          url: 'https://example.test/graphql',
        },
      }),
    )

    const result = await serve(cli, ['--help', '--format', 'json'])
    expect(result.exitCode).toBe(1)
    expect(JSON.parse(result.output)).toMatchObject({
      code: 'PLUGIN_RESOLUTION_FAILED',
      message: "Failed to resolve plugin 'graphql': GraphQL argument 'ids' cannot be positional",
    })
  })

  test('falls back to __typename when depth would otherwise produce an empty object selection', () => {
    const schema = buildSchema(/* GraphQL */ `
      type Leaf {
        value: String!
      }

      type Inner {
        leaf: Leaf!
      }

      type Wrapper {
        inner: Inner!
      }

      type Query {
        wrapper: Wrapper!
      }
    `)

    const selection = createSelection(schema.getQueryType()!.getFields().wrapper!.type, { depth: 1 })

    expect(selection.selection).toContain('__typename')
    expect(selection.selection?.length).toBeGreaterThan(0)
    expect(selection.schema.safeParse({ inner: { __typename: 'Inner' } }).success).toBe(true)
  })
})
