import { describe, expect, it } from 'vitest'

import { helpText, parseCommand } from '../src/commands.js'
import { TextCapture } from '../src/interact/text-capture.js'

describe('parseCommand', () => {
  it('parses a bare command', () => {
    expect(parseCommand('/new')).toEqual({ name: 'new', args: '' })
  })

  it('parses a command with arguments', () => {
    expect(parseCommand('/claim abc123')).toEqual({ name: 'claim', args: 'abc123' })
  })

  it('keeps multi-word arguments together', () => {
    expect(parseCommand('/claim  a b  c ')).toEqual({ name: 'claim', args: 'a b  c' })
  })

  it('lowercases the command name', () => {
    expect(parseCommand('/NEW')).toEqual({ name: 'new', args: '' })
  })

  it('accepts a command addressed to this bot', () => {
    expect(parseCommand('/new@my_bot', 'my_bot')).toEqual({ name: 'new', args: '' })
  })

  it('ignores a command addressed to a different bot in the same group', () => {
    expect(parseCommand('/new@other_bot', 'my_bot')).toBeUndefined()
  })

  it('matches the bot suffix case-insensitively', () => {
    expect(parseCommand('/new@My_Bot', 'my_bot')).toEqual({ name: 'new', args: '' })
  })

  it('ignores an unknown command, leaving it as a prompt', () => {
    expect(parseCommand('/deploy')).toBeUndefined()
  })

  it('ignores ordinary text', () => {
    expect(parseCommand('what is 2 + 2?')).toBeUndefined()
  })

  it('ignores a slash inside a sentence', () => {
    expect(parseCommand('read src/index.ts /new stuff')).toBeUndefined()
  })

  it('ignores an empty message', () => {
    expect(parseCommand('')).toBeUndefined()
  })
})

describe('helpText', () => {
  it('lists every command', () => {
    const help = helpText()
    expect(help).toContain('/new')
    expect(help).toContain('/status')
    expect(help).toContain('/claim')
  })
})

describe('TextCapture', () => {
  const chat = { chatId: '1' }

  it('reports that nothing is waiting by default', () => {
    expect(new TextCapture().isWaiting(chat)).toBe(false)
  })

  it('hands the next message to a waiting prompt', async () => {
    const capture = new TextCapture()
    const waited = capture.next(chat)
    expect(capture.deliver(chat, 'my answer')).toBe(true)
    await expect(waited).resolves.toBe('my answer')
  })

  it('reports no consumer when nothing is waiting', () => {
    expect(new TextCapture().deliver(chat, 'stray')).toBe(false)
  })

  it('does not let one chat consume another chat\'s message', async () => {
    const capture = new TextCapture()
    capture.next(chat)
    expect(capture.deliver({ chatId: '2' }, 'wrong chat')).toBe(false)
  })

  it('treats a forum topic as its own conversation', () => {
    const capture = new TextCapture()
    capture.next({ chatId: '1', threadId: 5 })
    expect(capture.deliver({ chatId: '1' }, 'general')).toBe(false)
    expect(capture.deliver({ chatId: '1', threadId: 5 }, 'topic')).toBe(true)
  })

  it('cancels a wait when its signal aborts', async () => {
    const capture = new TextCapture()
    const controller = new AbortController()
    const waited = capture.next(chat, controller.signal)
    controller.abort()
    await expect(waited).resolves.toBeUndefined()
  })

  it('supersedes an earlier wait on the same chat', async () => {
    const capture = new TextCapture()
    const first = capture.next(chat)
    const second = capture.next(chat)

    await expect(first).resolves.toBeUndefined()
    capture.deliver(chat, 'answer')
    await expect(second).resolves.toBe('answer')
  })

  it('cancels every wait on dispose', async () => {
    const capture = new TextCapture()
    const waited = capture.next(chat)
    capture.dispose()
    await expect(waited).resolves.toBeUndefined()
  })
})
