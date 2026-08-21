import { describe, expect, it } from 'vitest'

import { TurnBridge } from '../src/reply/turn-bridge.js'
import type { SessionEvent } from '../src/reply/turn-bridge.js'
import { canStreamTo } from '../src/reply/rich-stream.js'
import type { RichChat } from '../src/reply/rich-stream.js'

/** A Bot API stand-in recording every rich call the bridge makes. */
function fakeChat() {
  const drafts: { draftId: number; markdown: string }[] = []
  const sent: string[] = []
  const placeholders: string[] = []
  const edits: { messageId: number; markdown: string }[] = []
  let nextId = 0

  const chat: RichChat = {
    async sendRichMessage(options) {
      sent.push(options.markdown)
      return { messageId: (nextId += 1) }
    },
    async sendRichMessageDraft(options) {
      drafts.push({ draftId: options.draftId, markdown: options.markdown })
    },
    async sendMessage(options) {
      placeholders.push(options.html)
      return { messageId: (nextId += 1) }
    },
    async editRichMessage(options) {
      edits.push({ messageId: options.messageId, markdown: options.markdown })
      return undefined
    },
  }

  return {
    chat,
    drafts,
    sent,
    placeholders,
    edits,
    /** The newest draft frame — what the user is watching mid-turn. */
    frame: () => drafts[drafts.length - 1]?.markdown,
    /** The finished reply, wherever it landed. */
    final: () => edits[edits.length - 1]?.markdown ?? sent[sent.length - 1],
  }
}

function build(options: { bound?: boolean; group?: boolean } = {}) {
  const chat = fakeChat()
  const bridge = new TurnBridge({
    chat: chat.chat,
    targetOf: (sessionId) =>
      options.bound === false || sessionId !== 'S' ? undefined : { chatId: '42' },
    canDraft: () => options.group !== true,
    throttleMs: 0,
    placeholder: '…',
    heartbeatMs: 0,
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
  it('shows a placeholder draft as soon as the turn opens', async () => {
    const { bridge, chat } = build()
    await bridge.handle('S', start)
    expect(chat.frame()).toBe('…')
  })

  it('streams markdown verbatim, for Telegram to render', async () => {
    const { bridge, chat } = build()
    await bridge.handle('S', start)
    await bridge.handle('S', delta('Hello '))
    await bridge.handle('S', delta('**world**'))

    expect(chat.frame()).toBe('Hello **world**')
  })

  it('keeps one draft id for the turn, so frames animate together', async () => {
    const { bridge, chat } = build()
    await bridge.handle('S', start)
    await bridge.handle('S', delta('a'))
    await bridge.handle('S', delta('b'))

    expect(new Set(chat.drafts.map((d) => d.draftId)).size).toBe(1)
    expect(chat.drafts[0]?.draftId).not.toBe(0)
  })

  it('gives a later turn its own draft id, so it does not animate out of the last', async () => {
    const { bridge, chat } = build()
    await bridge.handle('S', start)
    await bridge.handle('S', end)
    await bridge.handle('S', { type: 'turn/start', data: { turn: 2 } })

    const ids = new Set(chat.drafts.map((d) => d.draftId))
    expect(ids.size).toBe(2)
  })

  it('persists the reply when the turn ends, since a draft is ephemeral', async () => {
    const { bridge, chat } = build()
    await bridge.handle('S', start)
    await bridge.handle('S', delta('done'))
    await bridge.handle('S', end)

    expect(chat.sent).toEqual(['done'])
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

    expect(chat.final()).toBe('the complete answer')
  })
})

describe('TurnBridge — what it filters out', () => {
  it('ignores sessions that are not bound to a chat', async () => {
    const { bridge, chat } = build({ bound: false })
    await bridge.handle('S', start)
    await bridge.handle('S', delta('text'))

    expect(chat.drafts).toHaveLength(0)
    expect(chat.sent).toHaveLength(0)
  })

  it('keeps the model\'s reasoning out of the chat', async () => {
    const { bridge, chat } = build()
    await bridge.handle('S', start)
    await bridge.handle('S', {
      type: 'assistant/chunk',
      data: { turn: 1, chunk: { type: 'reasoning-delta', text: 'let me think' } },
    })

    expect(chat.drafts.slice(1)).toHaveLength(0)
  })

  it('keeps tool-call fragments out of the chat', async () => {
    const { bridge, chat } = build()
    await bridge.handle('S', start)
    await bridge.handle('S', {
      type: 'assistant/chunk',
      data: { turn: 1, chunk: { type: 'tool-call-delta', text: '{"path":' } },
    })

    expect(chat.drafts.slice(1)).toHaveLength(0)
  })

  it('ignores events for a turn other than the open one', async () => {
    const { bridge, chat } = build()
    await bridge.handle('S', start)
    await bridge.handle('S', delta('from another turn', 9))

    expect(chat.drafts.slice(1)).toHaveLength(0)
  })

  it('ignores deltas with no open turn at all', async () => {
    const { bridge, chat } = build()
    await bridge.handle('S', delta('orphan'))
    expect(chat.drafts).toHaveLength(0)
  })

  it('ignores event types it does not consume', async () => {
    const { bridge, chat } = build()
    await bridge.handle('S', start)
    await bridge.handle('S', { type: 'tool/result', data: {} })
    expect(chat.drafts.slice(1)).toHaveLength(0)
  })
})

describe('TurnBridge — lifecycle', () => {
  it('closes a stranded turn when a new one opens', async () => {
    const { bridge, chat } = build()
    await bridge.handle('S', start)
    await bridge.handle('S', delta('first turn'))
    await bridge.handle('S', { type: 'turn/start', data: { turn: 2 } })

    // The stranded turn was persisted rather than left as an expiring draft.
    expect(chat.sent).toEqual(['first turn'])
    expect(bridge.isStreaming('S')).toBe(true)
  })

  it('closes open streams on dispose', async () => {
    const { bridge } = build()
    await bridge.handle('S', start)
    await bridge.dispose()
    expect(bridge.isStreaming('S')).toBe(false)
  })

  it('survives a chat failure without throwing at the harness', async () => {
    const bridge = new TurnBridge({
      chat: {
        sendRichMessage: async () => {
          throw new Error('telegram is down')
        },
        sendRichMessageDraft: async () => {
          throw new Error('telegram is down')
        },
        sendMessage: async () => {
          throw new Error('telegram is down')
        },
        editRichMessage: async () => undefined,
      },
      targetOf: () => ({ chatId: '42' }),
      canDraft: () => true,
      throttleMs: 0,
      heartbeatMs: 0,
    })

    await expect(bridge.handle('S', start)).resolves.toBeUndefined()
    await expect(bridge.handle('S', delta('text'))).resolves.toBeUndefined()
  })
})


describe('TurnBridge — groups, which have no draft api', () => {
  it('posts a placeholder instead of a draft', async () => {
    const { bridge, chat } = build({ group: true })
    await bridge.handle('S', start)

    expect(chat.drafts).toHaveLength(0)
    expect(chat.placeholders).toEqual(['…'])
  })

  it('does not stream, because there is nothing to stream into', async () => {
    const { bridge, chat } = build({ group: true })
    await bridge.handle('S', start)
    await bridge.handle('S', delta('working'))

    expect(chat.drafts).toHaveLength(0)
    expect(chat.edits).toHaveLength(0)
  })

  it('replaces the placeholder with the finished reply', async () => {
    const { bridge, chat } = build({ group: true })
    await bridge.handle('S', start)
    await bridge.handle('S', delta('the answer'))
    await bridge.handle('S', end)

    expect(chat.edits).toHaveLength(1)
    expect(chat.edits[0]?.markdown).toBe('the answer')
  })
})

describe('canStreamTo', () => {
  it('streams to a private chat when streaming is on', () => {
    expect(canStreamTo('562660734', true)).toBe(true)
  })

  it('does not stream when the operator switched it off', () => {
    // The switch used to be read as "which throttle to use", so turning it off
    // changed nothing at all.
    expect(canStreamTo('562660734', false)).toBe(false)
  })

  it('does not stream to a group even when streaming is on', () => {
    // Groups carry negative ids and have no draft API.
    expect(canStreamTo('-1001234567890', true)).toBe(false)
  })

  it('does not stream to a group with streaming off either', () => {
    expect(canStreamTo('-1001234567890', false)).toBe(false)
  })
})
