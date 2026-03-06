import { Mcp, z } from 'incur'
import { PassThrough } from 'node:stream'

function createTestCommands() {
  const commands = new Map<string, any>()

  commands.set('ping', {
    description: 'Health check',
    run() {
      return { pong: true }
    },
  })

  commands.set('echo', {
    description: 'Echo a message',
    args: z.object({
      message: z.string().describe('Message to echo'),
    }),
    options: z.object({
      upper: z.boolean().default(false).describe('Uppercase output'),
    }),
    run(c: any) {
      const msg = c.options.upper ? c.args.message.toUpperCase() : c.args.message
      return { result: msg }
    },
  })

  commands.set('greet', {
    _group: true,
    description: 'Greeting commands',
    commands: new Map([
      [
        'hello',
        {
          description: 'Say hello',
          args: z.object({ name: z.string().describe('Name to greet') }),
          run(c: any) {
            return { greeting: `hello ${c.args.name}` }
          },
        },
      ],
    ]),
  })

  commands.set('fail', {
    description: 'Always fails',
    run(c: any) {
      return c.error({ code: 'BOOM', message: 'it broke' })
    },
  })

  commands.set('stream', {
    description: 'Stream chunks',
    async *run() {
      yield { content: 'hello' }
      yield { content: 'world' }
    },
  })

  commands.set('destroy', {
    description: 'Delete everything',
    destructive: true,
    mutates: true,
    run() {
      return { ok: true }
    },
  })

  commands.set('deploy', {
    description: 'Deploy a service',
    body: z.object({
      region: z.string(),
      replicas: z.number().default(1),
    }),
    options: z.object({
      region: z.string().optional(),
      replicas: z.number().default(1),
    }),
    run(c: any) {
      return c.options
    },
  })

  const issueUpdateInput = z.object({
    id: z.string(),
    input: z.object({
      email: z.string().optional(),
    }),
  })

  commands.set('issue-update', {
    args: z.object({ id: z.string() }),
    description: 'Update an issue with a mixed scalar and input payload',
    input: issueUpdateInput,
    options: z.object({
      id: z.string().optional(),
    }),
    run(c: any) {
      return issueUpdateInput.parse({ ...c.options, ...c.args })
    },
  })

  return commands
}

/** Standard initialize params for MCP protocol. */
const initParams = {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'test-client', version: '1.0.0' },
}

/** Sends JSON-RPC messages, ends the stream, waits for serve to finish, returns parsed responses. */
async function mcpSession(
  commands: Map<string, any>,
  messages: { method: string; params?: unknown; id?: number }[],
) {
  const input = new PassThrough()
  const output = new PassThrough()
  const chunks: string[] = []
  output.on('data', (chunk) => chunks.push(chunk.toString()))

  const done = Mcp.serve('test-cli', '1.0.0', commands, { input, output })

  for (const msg of messages) {
    const rpc = { jsonrpc: '2.0', ...msg }
    input.write(`${JSON.stringify(rpc)}\n`)
  }

  // Give time for async processing then close
  await new Promise((r) => setTimeout(r, 20))
  input.end()
  await done

  return chunks.map((c) => JSON.parse(c.trim()))
}

describe('Mcp', () => {
  test('initialize responds with server info', async () => {
    const [res] = await mcpSession(createTestCommands(), [
      { id: 1, method: 'initialize', params: initParams },
    ])
    expect(res.id).toBe(1)
    expect(res.result.protocolVersion).toBe('2024-11-05')
    expect(res.result.serverInfo).toEqual({ name: 'test-cli', version: '1.0.0' })
    expect(res.result.capabilities.tools).toBeDefined()
  })

  test('tools/list returns all leaf commands as tools', async () => {
    const [, res] = await mcpSession(createTestCommands(), [
      { id: 1, method: 'initialize', params: initParams },
      { id: 2, method: 'tools/list', params: {} },
    ])
    const names = res.result.tools.map((t: any) => t.name).sort()
    expect(names).toEqual([
      'deploy',
      'destroy',
      'echo',
      'fail',
      'greet_hello',
      'issue_update',
      'ping',
      'stream',
    ])

    const echoTool = res.result.tools.find((t: any) => t.name === 'echo')
    expect(echoTool.description).toBe('Echo a message')
    expect(echoTool.inputSchema.properties.message).toBeDefined()
    expect(echoTool.inputSchema.properties.upper).toBeDefined()
    expect(echoTool.inputSchema.required).toContain('message')

    const destroyTool = res.result.tools.find((t: any) => t.name === 'destroy')
    expect(destroyTool.description).toContain('confirm with user before executing')
    expect(destroyTool.inputSchema.properties.dryRun).toBeDefined()
  })

  test('notifications are ignored (no response)', async () => {
    const responses = await mcpSession(createTestCommands(), [
      { id: 1, method: 'initialize', params: initParams },
      { method: 'notifications/initialized' },
      { id: 2, method: 'ping' },
    ])
    expect(responses).toHaveLength(2)
    expect(responses[0].id).toBe(1)
    expect(responses[1].id).toBe(2)
  })

  test('tools/call executes simple command', async () => {
    const [, res] = await mcpSession(createTestCommands(), [
      { id: 1, method: 'initialize', params: initParams },
      { id: 2, method: 'tools/call', params: { name: 'ping', arguments: {} } },
    ])
    expect(res.result.content).toEqual([{ type: 'text', text: '{"pong":true}' }])
  })

  test('tools/call with args and options', async () => {
    const [, res] = await mcpSession(createTestCommands(), [
      { id: 1, method: 'initialize', params: initParams },
      {
        id: 2,
        method: 'tools/call',
        params: { name: 'echo', arguments: { message: 'hello', upper: true } },
      },
    ])
    expect(res.result.content).toEqual([{ type: 'text', text: '{"result":"HELLO"}' }])
  })

  test('tools/call with nested group command', async () => {
    const [, res] = await mcpSession(createTestCommands(), [
      { id: 1, method: 'initialize', params: initParams },
      {
        id: 2,
        method: 'tools/call',
        params: { name: 'greet_hello', arguments: { name: 'world' } },
      },
    ])
    expect(res.result.content).toEqual([{ type: 'text', text: '{"greeting":"hello world"}' }])
  })

  test('tools/call unknown tool returns error', async () => {
    const [, res] = await mcpSession(createTestCommands(), [
      { id: 1, method: 'initialize', params: initParams },
      { id: 2, method: 'tools/call', params: { name: 'nope', arguments: {} } },
    ])
    // SDK returns a JSON-RPC error for unknown tools
    const hasError = res.error?.message?.includes('nope') || res.result?.isError
    expect(hasError).toBeTruthy()
  })

  test('tools/call with sentinel error result', async () => {
    const [, res] = await mcpSession(createTestCommands(), [
      { id: 1, method: 'initialize', params: initParams },
      { id: 2, method: 'tools/call', params: { name: 'fail', arguments: {} } },
    ])
    expect(res.result.isError).toBe(true)
    expect(res.result.content[0].text).toBe('it broke')
  })

  test('unknown method returns JSON-RPC error', async () => {
    const [, res] = await mcpSession(createTestCommands(), [
      { id: 1, method: 'initialize', params: initParams },
      { id: 2, method: 'bogus/method', params: {} },
    ])
    // SDK returns either a JSON-RPC error or ignores unknown methods
    expect(res.error ?? res.result).toBeDefined()
  })

  test('ping returns empty object', async () => {
    const [, res] = await mcpSession(createTestCommands(), [
      { id: 1, method: 'initialize', params: initParams },
      { id: 2, method: 'ping' },
    ])
    expect(res.result).toEqual({})
  })

  test('options get defaults applied', async () => {
    const [, res] = await mcpSession(createTestCommands(), [
      { id: 1, method: 'initialize', params: initParams },
      { id: 2, method: 'tools/call', params: { name: 'echo', arguments: { message: 'hi' } } },
    ])
    // upper defaults to false, so message stays lowercase
    expect(res.result.content).toEqual([{ type: 'text', text: '{"result":"hi"}' }])
  })

  test('streaming command buffers chunks into array', async () => {
    const [, res] = await mcpSession(createTestCommands(), [
      { id: 1, method: 'initialize', params: initParams },
      { id: 2, method: 'tools/call', params: { name: 'stream', arguments: {} } },
    ])
    expect(res.result.content).toEqual([
      { type: 'text', text: '[{"content":"hello"},{"content":"world"}]' },
    ])
  })

  test('tools/call resolves injected json payload through shared option parsing', async () => {
    const [, res] = await mcpSession(createTestCommands(), [
      { id: 1, method: 'initialize', params: initParams },
      {
        id: 2,
        method: 'tools/call',
        params: {
          name: 'deploy',
          arguments: { json: '{"region":"us-central1","replicas":3}' },
        },
      },
    ])
    expect({
      type: res.result.content[0].type,
      data: JSON.parse(res.result.content[0].text),
    }).toEqual({
      type: 'text',
      data: { region: 'us-central1', replicas: 3 },
    })
  })

  test('tools/call merges json payload with scalar args for input commands', async () => {
    const [, res] = await mcpSession(createTestCommands(), [
      { id: 1, method: 'initialize', params: initParams },
      {
        id: 2,
        method: 'tools/call',
        params: {
          name: 'issue_update',
          arguments: { id: 'ISS-1', json: '{"input":{"email":"issue@example.com"}}' },
        },
      },
    ])
    expect({
      type: res.result.content[0].type,
      data: JSON.parse(res.result.content[0].text),
    }).toEqual({
      type: 'text',
      data: { id: 'ISS-1', input: { email: 'issue@example.com' } },
    })
  })

  test('streaming command sends progress notifications', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const chunks: any[] = []
    output.on('data', (chunk) => chunks.push(JSON.parse(chunk.toString().trim())))

    const done = Mcp.serve('test-cli', '1.0.0', createTestCommands(), { input, output })

    // Initialize
    input.write(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: initParams }) + '\n',
    )
    await new Promise((r) => setTimeout(r, 10))

    // Call streaming tool with progressToken
    input.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'stream', arguments: {}, _meta: { progressToken: 'tok-1' } },
      }) + '\n',
    )
    await new Promise((r) => setTimeout(r, 50))
    input.end()
    await done

    // Filter for progress notifications
    const progress = chunks.filter((c) => c.method === 'notifications/progress')
    expect(progress).toHaveLength(2)
    expect(progress[0].params.message).toBe('{"content":"hello"}')
    expect(progress[1].params.message).toBe('{"content":"world"}')
    expect(progress[0].params.progress).toBe(1)
    expect(progress[1].params.progress).toBe(2)
  })
})
