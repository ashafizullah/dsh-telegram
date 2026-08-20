import { describe, expect, it, vi } from 'vitest'

import { ReplyStream } from '../src/reply/streamer.js'
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

  return { surface, sent, edits }
}

/** A stream with throttling disabled, so a test never waits on a timer. */
function build(limit = 4096) {
  const chat = fakeSurface()
  const stream = new ReplyStream({
    surface: chat.surface,
    target: { chatId: '42' },
    throttleMs: 0,
    limit,
    placeholder: '…',
  })
  return { stream, chat }
}

describe('ReplyStream — lifecycle', () => {
  it('posts a placeholder as soon as it starts, so the chat shows progress', async () => {
    const { stream, chat } = build()
    await stream.start()
    expect(chat.sent).toEqual(['…'])
  })

  it('starts on its own if the first delta arrives without an explicit start', async () => {
    const { stream, chat } = build()
    await stream.append('hi')
    await stream.finish()
    expect(chat.sent).toHaveLength(1)
  })

  it('does not post twice when started twice', async () => {
    const { stream, chat } = build()
    await stream.start()
    await stream.start()
    expect(chat.sent).toHaveLength(1)
  })
})

describe('ReplyStream — markdown', () => {
  it('renders accumulated markdown as Telegram HTML', async () => {
    const { stream, chat } = build()
    await stream.start()
    await stream.append('**bold**')
    await stream.finish()
    expect(chat.edits[chat.edits.length - 1]?.html).toBe('<b>bold</b>')
  })

  it('keeps a half-arrived code fence valid mid-stream', async () => {
    const { stream, chat } = build()
    await stream.start()
    await stream.append('```js\nlet a = 1')
    expect(chat.edits[chat.edits.length - 1]?.html).toBe(
      '<pre><code class="language-js">let a = 1</code></pre>',
    )
    await stream.finish()
  })

  it('accumulates deltas rather than replacing them', async () => {
    const { stream, chat } = build()
    await stream.append('one ')
    await stream.append('two ')
    await stream.append('three')
    await stream.finish()
    expect(chat.edits[chat.edits.length - 1]?.html).toBe('one two three')
  })

  it('takes an authoritative final text over the accumulated buffer', async () => {
    const { stream, chat } = build()
    await stream.append('partial')
    await stream.finish('the whole answer')
    expect(chat.edits[chat.edits.length - 1]?.html).toBe('the whole answer')
  })
})

describe('ReplyStream — long replies', () => {
  it('sends a second message once the reply outgrows one', async () => {
    const { stream, chat } = build(60)
    await stream.start()
    await stream.append(`${'a'.repeat(50)}\n\n${'b'.repeat(50)}`)
    await stream.finish()

    expect(chat.sent.length).toBeGreaterThan(1)
    for (const edit of chat.edits) expect(edit.html.length).toBeLessThanOrEqual(60)
  })

  it('keeps the first message stable once it has been filled', async () => {
    const { stream, chat } = build(60)
    await stream.start()
    await stream.append(`${'a'.repeat(50)}\n\n`)
    await stream.append('b'.repeat(50))
    await stream.append('c'.repeat(10))
    await stream.finish()

    const first = chat.edits.filter((edit) => edit.messageId === 1)
    expect(first[first.length - 1]?.html).toBe('a'.repeat(50))
  })
})

describe('ReplyStream — throttling', () => {
  it('coalesces rapid deltas into fewer edits', async () => {
    vi.useFakeTimers()
    try {
      const chat = fakeSurface()
      const stream = new ReplyStream({
        surface: chat.surface,
        target: { chatId: '42' },
        throttleMs: 1000,
        limit: 4096,
        placeholder: '…',
      })

      await stream.start()
      void stream.append('a')
      void stream.append('b')
      void stream.append('c')
      expect(chat.edits).toHaveLength(0)

      await vi.advanceTimersByTimeAsync(1000)
      expect(chat.edits).toHaveLength(1)
      expect(chat.edits[0]?.html).toBe('abc')
    } finally {
      vi.useRealTimers()
    }
  })

  it('flushes everything pending when it finishes, ignoring the throttle', async () => {
    vi.useFakeTimers()
    try {
      const chat = fakeSurface()
      const stream = new ReplyStream({
        surface: chat.surface,
        target: { chatId: '42' },
        throttleMs: 10_000,
        limit: 4096,
        placeholder: '…',
      })

      await stream.start()
      void stream.append('late text')
      await stream.finish()
      expect(chat.edits[chat.edits.length - 1]?.html).toBe('late text')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('ReplyStream — failure', () => {
  it('marks the placeholder with the error instead of leaving it dangling', async () => {
    const { stream, chat } = build()
    await stream.start()
    await stream.fail(new Error('model exploded'))
    expect(chat.edits[chat.edits.length - 1]?.html).toContain('model exploded')
  })

  it('keeps whatever text had already streamed when it fails', async () => {
    const { stream, chat } = build()
    await stream.start()
    await stream.append('half an answer')
    await stream.fail(new Error('interrupted'))
    const last = chat.edits[chat.edits.length - 1]?.html ?? ''
    expect(last).toContain('half an answer')
    expect(last).toContain('interrupted')
  })

  it('ignores deltas that arrive after it has finished', async () => {
    const { stream, chat } = build()
    await stream.start()
    await stream.finish('done')
    const count = chat.edits.length
    await stream.append('too late')
    expect(chat.edits).toHaveLength(count)
  })

  it('survives a send failure without throwing at the caller', async () => {
    const chat = fakeSurface()
    const stream = new ReplyStream({
      surface: {
        ...chat.surface,
        edit: async () => {
          throw new Error('telegram is down')
        },
      },
      target: { chatId: '42' },
      throttleMs: 0,
      limit: 4096,
      placeholder: '…',
    })

    await stream.start()
    await expect(stream.append('text')).resolves.toBeUndefined()
    await expect(stream.finish()).resolves.toBeUndefined()
  })
})
