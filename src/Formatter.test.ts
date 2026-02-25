import { decode } from '@toon-format/toon'
import { Formatter } from 'clac'

describe('format', () => {
  test('formats success envelope as TOON', () => {
    const result = Formatter.format({
      ok: true,
      data: { message: 'hello world' },
      meta: { command: 'greet', duration: '0ms' },
    })

    expect(result).toMatchInlineSnapshot(`
      "ok: true
      data:
        message: hello world
      meta:
        command: greet
        duration: 0ms"
    `)
  })

  test('formats error envelope as TOON', () => {
    const result = Formatter.format({
      ok: false,
      error: { code: 'UNKNOWN', message: 'boom' },
      meta: { command: 'fail', duration: '0ms' },
    })

    expect(result).toMatchInlineSnapshot(`
      "ok: false
      error:
        code: UNKNOWN
        message: boom
      meta:
        command: fail
        duration: 0ms"
    `)
  })

  test('round-trips through TOON decode', () => {
    const envelope = {
      ok: true,
      data: { items: [1, 2, 3] },
      meta: { command: 'list', duration: '5ms' },
    }

    const result = decode(Formatter.format(envelope))
    expect(result).toMatchObject(envelope)
  })
})
