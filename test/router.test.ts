import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { AccessPolicy } from '../src/access.js'
import { TextCapture } from '../src/interact/text-capture.js'
import { UpdateRouter } from '../src/router.js'
import type { AgentRunner } from '../src/router.js'
import type { TelegramUpdate } from '../src/telegram/types.js'

const OWNER = 7
const STRANGER = 99

/** A router wired to spies, with a real access policy in a temp directory. */
async function build(options: { allowFrom?: number[]; media?: unknown } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-telegram-router-'))
  const access = await AccessPolicy.open(join(dir, 'owner.json'), {
    allowFrom: options.allowFrom ?? [OWNER],
    claimCode: 'the-code',
  })

  const said: string[] = []
  const answered: string[] = []
  const runner: AgentRunner = {
    prompt: vi.fn(async () => undefined),
    reset: vi.fn(async () => undefined),
    stop: vi.fn(async () => true),
    status: vi.fn(async () => 'session ch-1, cwd /tmp'),
  }
  const questions = { handleCallback: vi.fn(() => false) }
  const approvals = { handleCallback: vi.fn(() => false) }
  const textCapture = new TextCapture()

  const router = new UpdateRouter({
    chat: {
      sendMessage: async ({ html }) => void said.push(html),
      answerCallbackQuery: async (id) => void answered.push(id),
    },
    access,
    questions,
    approvals,
    textCapture,
    runner,
    botUsername: 'my_bot',
    ...(options.media ? { media: options.media as never } : {}),
    redact: (text) => text.split('SECRET-TOKEN').join('<redacted>'),
  })

  return { router, said, answered, runner, questions, approvals, textCapture, access }
}

/** A text message update from `from`. */
function message(text: string, from = OWNER, chatId = 1): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      chat: { id: chatId, type: 'private' },
      from: { id: from },
      text,
    },
  }
}

describe('UpdateRouter — access', () => {
  it('sends an allowed user\'s message to the agent', async () => {
    const { router, runner } = await build()
    await router.handle(message('build the thing'))
    expect(runner.prompt).toHaveBeenCalledWith({ chatId: '1' }, [
      { type: 'text', text: 'build the thing' },
    ])
  })

  it('never lets an unauthorised message reach the agent', async () => {
    const { router, runner, said } = await build()
    await router.handle(message('rm -rf /', STRANGER))

    expect(runner.prompt).not.toHaveBeenCalled()
    expect(said[0]).toContain('not allowed')
  })

  it('refuses commands from an unauthorised user too', async () => {
    const { router, runner } = await build()
    await router.handle(message('/new', STRANGER))
    expect(runner.reset).not.toHaveBeenCalled()
  })

  it('tells an unclaimed bot\'s first visitor how to claim it', async () => {
    const { router, said } = await build({ allowFrom: [] })
    await router.handle(message('hello', STRANGER))
    expect(said[0]).toContain('/claim')
  })

  it('grants ownership for the right claim code', async () => {
    const { router, said, runner } = await build({ allowFrom: [] })
    await router.handle(message('/claim the-code', STRANGER))
    expect(said[0]).toContain('Claimed')

    await router.handle(message('now do work', STRANGER))
    expect(runner.prompt).toHaveBeenCalled()
  })

  it('refuses a wrong claim code', async () => {
    const { router, said } = await build({ allowFrom: [] })
    await router.handle(message('/claim wrong', STRANGER))
    expect(said[0]).toContain('not right')
  })
})

describe('UpdateRouter — commands', () => {
  it('starts a fresh conversation on /new', async () => {
    const { router, runner, said } = await build()
    await router.handle(message('/new'))

    expect(runner.reset).toHaveBeenCalledWith({ chatId: '1' })
    expect(said[0]).toContain('fresh conversation')
  })

  it('cancels the current turn on /stop', async () => {
    const { router, runner, said } = await build()
    await router.handle(message('/stop'))

    expect(runner.stop).toHaveBeenCalled()
    expect(said[0]).toContain('Stopped')
  })

  it('says so when /stop had nothing to cancel', async () => {
    const { router, runner, said } = await build()
    ;(runner.stop as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false)
    await router.handle(message('/stop'))
    expect(said[0]).toContain('Nothing was running')
  })

  it('reports the session on /status', async () => {
    const { router, said } = await build()
    await router.handle(message('/status'))
    expect(said[0]).toContain('ch-1')
  })

  it('lists the commands on /help', async () => {
    const { router, said } = await build()
    await router.handle(message('/help'))
    expect(said[0]).toContain('/new')
  })

  it('reports the user id on /whoami', async () => {
    const { router, said } = await build()
    await router.handle(message('/whoami'))
    expect(said[0]).toContain(String(OWNER))
  })

  it('ignores a command addressed to another bot in a group', async () => {
    const { router, runner } = await build()
    await router.handle(message('/new@other_bot'))

    expect(runner.reset).not.toHaveBeenCalled()
    expect(runner.prompt).toHaveBeenCalled()
  })

  it('treats an unknown slash word as an ordinary prompt', async () => {
    const { router, runner } = await build()
    await router.handle(message('/deploy staging'))
    expect(runner.prompt).toHaveBeenCalledWith({ chatId: '1' }, [
      { type: 'text', text: '/deploy staging' },
    ])
  })
})

describe('UpdateRouter — pending prompts', () => {
  it('gives a waiting question the typed answer instead of the agent', async () => {
    const { router, runner, textCapture } = await build()
    const waited = textCapture.next({ chatId: '1' })

    await router.handle(message('the branch is main'))

    await expect(waited).resolves.toBe('the branch is main')
    expect(runner.prompt).not.toHaveBeenCalled()
  })

  it('lets a waiting question take a message that looks like a command', async () => {
    const { router, runner, textCapture } = await build()
    const waited = textCapture.next({ chatId: '1' })

    await router.handle(message('/new'))

    await expect(waited).resolves.toBe('/new')
    expect(runner.reset).not.toHaveBeenCalled()
  })

  it('only diverts messages from the chat that is waiting', async () => {
    const { router, runner, textCapture } = await build()
    textCapture.next({ chatId: '1' })

    await router.handle(message('other chat', OWNER, 2))
    expect(runner.prompt).toHaveBeenCalledWith({ chatId: '2' }, [
      { type: 'text', text: 'other chat' },
    ])
  })
})

describe('UpdateRouter — button presses', () => {
  const press = (data: string, from = OWNER): TelegramUpdate => ({
    update_id: 2,
    callback_query: { id: 'cb-1', from: { id: from }, data },
  })

  it('acknowledges the press before anything else', async () => {
    const { router, answered } = await build()
    await router.handle(press('q:tok:0'))
    expect(answered).toEqual(['cb-1'])
  })

  it('offers the press to questions first', async () => {
    const { router, questions, approvals } = await build()
    questions.handleCallback.mockReturnValueOnce(true)

    await router.handle(press('q:tok:0'))
    expect(questions.handleCallback).toHaveBeenCalledWith('q:tok:0')
    expect(approvals.handleCallback).not.toHaveBeenCalled()
  })

  it('falls through to approvals when questions do not own it', async () => {
    const { router, approvals } = await build()
    await router.handle(press('a:tok:0'))
    expect(approvals.handleCallback).toHaveBeenCalledWith('a:tok:0')
  })

  it('acknowledges but ignores a stale press nobody owns', async () => {
    const { router, answered } = await build()
    await expect(router.handle(press('q:gone:0'))).resolves.toBeUndefined()
    expect(answered).toEqual(['cb-1'])
  })

  it('ignores a press from an unauthorised user', async () => {
    const { router, questions } = await build()
    await router.handle(press('q:tok:0', STRANGER))
    expect(questions.handleCallback).not.toHaveBeenCalled()
  })
})

describe('UpdateRouter — robustness', () => {
  it('ignores an update carrying neither a message nor a press', async () => {
    const { router, said } = await build()
    await expect(router.handle({ update_id: 3 })).resolves.toBeUndefined()
    expect(said).toHaveLength(0)
  })

  it('ignores a message with no sender', async () => {
    const { router, runner } = await build()
    await router.handle({
      update_id: 4,
      message: { message_id: 1, chat: { id: 1, type: 'private' }, text: 'hi' },
    })
    expect(runner.prompt).not.toHaveBeenCalled()
  })

  it('says so when a photo arrives but attachments are not configured', async () => {
    const { router, said } = await build()
    await router.handle({
      update_id: 5,
      message: {
        message_id: 1,
        chat: { id: 1, type: 'private' },
        from: { id: OWNER },
        photo: [{ file_id: 'abc' }],
      },
    })
    expect(said[0]).toContain('attachments')
  })

  it('sends a photo through the collector when one is configured', async () => {
    const { router, runner } = await build({
      media: {
        collect: async () => [{ type: 'image', attachment: { attachmentId: 'a1' } }],
      },
    })

    await router.handle({
      update_id: 6,
      message: {
        message_id: 1,
        chat: { id: 1, type: 'private' },
        from: { id: OWNER },
        photo: [{ file_id: 'abc' }],
        caption: 'why this error?',
      },
    })

    expect(runner.prompt).toHaveBeenCalledWith({ chatId: '1' }, [
      { type: 'image', attachment: { attachmentId: 'a1' } },
    ])
  })

  it('does not read a captioned file as a command', async () => {
    // '/new' as a caption on a screenshot is a caption, not a reset.
    const { router, runner } = await build({
      media: { collect: async () => [{ type: 'text', text: '/new' }] },
    })

    await router.handle({
      update_id: 7,
      message: {
        message_id: 1,
        chat: { id: 1, type: 'private' },
        from: { id: OWNER },
        photo: [{ file_id: 'abc' }],
        caption: '/new',
      },
    })

    expect(runner.reset).not.toHaveBeenCalled()
    expect(runner.prompt).toHaveBeenCalled()
  })

  it('reports a prompt failure into the chat instead of dying', async () => {
    const { router, runner, said } = await build()
    ;(runner.prompt as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('no model route'))

    await expect(router.handle(message('hello'))).resolves.toBeUndefined()
    expect(said[0]).toContain('no model route')
  })

  it('keeps the poll loop alive when a handler throws outright', async () => {
    const { router, runner } = await build()
    ;(runner.reset as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'))
    await expect(router.handle(message('/new'))).resolves.toBeUndefined()
  })

  it('routes an edited message like a new one', async () => {
    const { router, runner } = await build()
    await router.handle({
      update_id: 6,
      edited_message: {
        message_id: 1,
        chat: { id: 1, type: 'private' },
        from: { id: OWNER },
        text: 'revised prompt',
      },
    })
    expect(runner.prompt).toHaveBeenCalledWith({ chatId: '1' }, [
      { type: 'text', text: 'revised prompt' },
    ])
  })
})


describe('UpdateRouter — what it says out loud', () => {
  it('redacts a secret quoted by a failure before posting it to the chat', async () => {
    const { router, runner, said } = await build()
    ;(runner.prompt as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('request to https://api.example/botSECRET-TOKEN/x failed'),
    )

    await router.handle(message('hello'))

    expect(said[0]).not.toContain('SECRET-TOKEN')
    // Redaction runs before html escaping, so the marker arrives escaped and
    // the user reads a literal <redacted> rather than markup.
    expect(said[0]).toContain('&lt;redacted&gt;')
  })

  it('still tells the user what went wrong', async () => {
    const { router, runner, said } = await build()
    ;(runner.prompt as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('disk full'))

    await router.handle(message('hello'))
    expect(said[0]).toContain('disk full')
  })
})
