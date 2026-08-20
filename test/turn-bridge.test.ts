import { describe, expect, it } from 'vitest'

import { TurnBridge } from '../src/reply/turn-bridge.js'
import type { SessionEvent } from '../src/reply/turn-bridge.js'
import type { ChatSurface } from '../src/interact/surface.js'

function fakeSurface() {
  const sent: string[] = []
  const edits: { messageId: number; html: string }[] = []
  let nextId = 0

  const surface: ChatSurface = {
    async send(_target, html) {
      sent.push(html)
      return (nextId += 1)
    },
    async edit(_target, messageId, html) {
      edits.push({ messageId, html })
    },
  }

  return { surface, sent, edits, latest: () => edits[edits.length - 1]?.html }
}

function build(options: { bound?: boolean } = {}) {
  const chat = fakeSurface()
  const bridge = new TurnBridge({
    surface: chat.surface,
    targetOf: (sessionId) =>
      options.bound === false || sessionId !== 'S' ? undefined : { chatId: '42' },
    throttleMs: 0,
    placeholder: '…',
  })
  return { bridge, chat }
}

const start: SessionEvent = { type: 'turn/start', data: { turn: 1 } }
const end: SessionEvent = { type: 'turn/end', data: { turn: 1 } }

const delta = (text: string, turn = 1): SessionEvent => ({
  type: 'assistant/chunk',
  data: { turn, chunk: { type: 'text-delta', text } },
})

describe('TurnBridge — streaming a turn', () => {
  it('posts a placeholder when the turn opens', async () => {
    const { bridge, chat } = build()
    await bridge.handle('S', start)
    expect(chat.sent).toEqual(['…'])
  })

  it('streams text deltas into the message', async () => {
    const { bridge, chat } = build()
    await bridge.handle('S', start)
    await bridge.handle('S', delta('Hello '))
    await bridge.handle('S', delta('**world**'))

    expect(chat.latest()).toBe('Hello <b>world</b>')
  })

  it('closes the reply when the turn ends', async () => {
    const { bridge, chat } = build()
    await bridge.handle('S', start)
    await bridge.handle('S', delta('done'))
    await bridge.handle('S', end)

    expect(chat.latest()).toBe('done')
    expect(bridge.isStreaming('S')).toBe(false)
  })

  it('prefers the assembled assistant message over the accumulated deltas', async () => {
    const { bridge, chat } = build()
    await bridge.handle('S', start)
    await bridge.handle('S', delta('partial'))
    await bridge.handle('S', {
      type: 'assistant/message',
      data: { turn: 1, message: { content: [{ type: 'text', text: 'the complete answer' }] } },
    })
    await bridge.handle('S', end)

    expect(chat.latest()).toBe('the complete answer')
  })
})

describe('TurnBridge — what it filters out', () => {
  it('ignores sessions that are not bound to a chat', async () => {
    const { bridge, chat } = build({ bound: false })
    await bridge.handle('S', start)
    await bridge.handle('S', delta('text'))

    expect(chat.sent).toHaveLength(0)
  })

  it('keeps the model\'s reasoning out of the chat', async () => {
    const { bridge, chat } = build()
    await bridge.handle('S', start)
    await bridge.handle('S', {
      type: 'assistant/chunk',
      data: { turn: 1, chunk: { type: 'reasoning-delta', text: 'let me think' } },
    })

    expect(chat.edits).toHaveLength(0)
  })

  it('keeps tool-call fragments out of the chat', async () => {
    const { bridge, chat } = build()
    await bridge.handle('S', start)
    await bridge.handle('S', {
      type: 'assistant/chunk',
      data: { turn: 1, chunk: { type: 'tool-call-delta', text: '{"path":' } },
    })

    expect(chat.edits).toHaveLength(0)
  })

  it('ignores events for a turn other than the open one', async () => {
    const { bridge, chat } = build()
    await bridge.handle('S', start)
    await bridge.handle('S', delta('from another turn', 9))

    expect(chat.edits).toHaveLength(0)
  })

  it('ignores deltas with no open turn at all', async () => {
    const { bridge, chat } = build()
    await bridge.handle('S', delta('orphan'))
    expect(chat.sent).toHaveLength(0)
  })

  it('ignores event types it does not consume', async () => {
    const { bridge, chat } = build()
    await bridge.handle('S', start)
    await bridge.handle('S', { type: 'tool/result', data: {} })
    expect(chat.edits).toHaveLength(0)
  })
})

describe('TurnBridge — lifecycle', () => {
  it('closes a stranded turn when a new one opens', async () => {
    const { bridge, chat } = build()
    await bridge.handle('S', start)
    await bridge.handle('S', delta('first turn'))
    await bridge.handle('S', { type: 'turn/start', data: { turn: 2 } })

    expect(chat.sent).toHaveLength(2)
    expect(bridge.isStreaming('S')).toBe(true)
  })

  it('closes open streams on dispose', async () => {
    const { bridge } = build()
    await bridge.handle('S', start)
    await bridge.dispose()
    expect(bridge.isStreaming('S')).toBe(false)
  })

  it('survives a surface failure without throwing at the harness', async () => {
    const bridge = new TurnBridge({
      surface: {
        send: async () => {
          throw new Error('telegram is down')
        },
        edit: async () => undefined,
      },
      targetOf: () => ({ chatId: '42' }),
      throttleMs: 0,
    })

    await expect(bridge.handle('S', start)).resolves.toBeUndefined()
    await expect(bridge.handle('S', delta('text'))).resolves.toBeUndefined()
  })
})
