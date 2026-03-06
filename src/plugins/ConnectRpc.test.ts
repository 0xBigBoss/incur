import { Cli, Plugins } from 'incur'

import { startTestServer } from '../../test/fixtures/connectrpc/server.js'
import { UserService } from '../../test/fixtures/connectrpc/user_pb.js'

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
  return { output, exitCode }
}

describe('connectRpc', () => {
  test('supports the connect protocol with generated kebab-case commands', async () => {
    const server = await startTestServer('connect')
    try {
      const cli = Cli.create('acme').plugin(
        'users',
        Plugins.connectRpc({
          service: UserService,
          transport: {
            baseUrl: server.baseUrl,
            protocol: 'connect',
          },
          positionals: {
            deleteUser: ['userId'],
            getUser: ['userId'],
          },
        }),
      )

      const help = await serve(cli, ['users', '--help'])
      expect(help.output).toContain('get-user')
      expect(help.output).toContain('list-users')
      expect(help.output).toContain('watch-users')

      const result = await serve(cli, ['users', 'get-user', 'u-1', '--format', 'json'])
      expect(JSON.parse(result.output)).toMatchObject({
        email: 'u-1@acme.dev',
        status: 'active',
        tags: ['alpha', 'beta'],
        userId: 'u-1',
      })
    } finally {
      await server.close()
    }
  })

  test('supports the grpc protocol with the same generated handlers', async () => {
    const server = await startTestServer('grpc')
    try {
      const cli = Cli.create('acme').plugin(
        'users',
        Plugins.connectRpc({
          service: UserService,
          transport: {
            baseUrl: server.baseUrl,
            protocol: 'grpc',
          },
          positionals: {
            getUser: ['userId'],
          },
        }),
      )

      const result = await serve(cli, ['users', 'get-user', 'u-2', '--format', 'json'])
      expect(JSON.parse(result.output)).toMatchObject({
        email: 'u-2@acme.dev',
        userId: 'u-2',
      })
    } finally {
      await server.close()
    }
  })
})
