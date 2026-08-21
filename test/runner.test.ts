import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { BindingStore } from '../src/session/bindings.js'
import { SessionRunner } from '../src/session/runner.js'
import type { AgentHost, RunningAgent } from '../src/session/runner.js'

const CHAT = { chatId: '1' }

/** One text prompt part, the ordinary case. */
const text = (value: string) => [{ type: 'text' as const, text: value }]

/** An agent host backed by an in-memory map, with spies on every transition. */
function fakeHost() {
  const agents = new Map<string, RunningAgent & { prompts: string[]; cancelled: string[] }>()
  const created: string[] = []
  const resumed: string[] = []
  let resumable = true

  const make = (sessionId: string) => {
    const agent = {
      sessionId,
      prompts: [] as string[],
      cancelled: [] as string[],
      /** The override in force when each prompt was queued. */
      routes: [] as (undefined | { provider: string; model: string })[],
      model: undefined as undefined | { provider: string; model: string },
      followup(content: readonly { type: string; text?: string }[]) {
        agent.prompts.push(content.map((part) => part.text ?? `[${part.type}]`).join(''))
        agent.routes.push(agent.model)
      },
      useModel(route: { provider: string; model: string } | undefined) {
        agent.model = route
        return true
      },
      cancel(reason: string) {
        agent.cancelled.push(reason)
      },
      async dispose() {
        agents.delete(sessionId)
      },
    }
    agents.set(sessionId, agent)
    return agent
  }

  const host: AgentHost = {
    live: (sessionId) => agents.get(sessionId),
    async create(sessionId) {
      created.push(sessionId)
      return make(sessionId)
    },
    async resume(sessionId) {
      resumed.push(sessionId)
      return resumable ? make(sessionId) : undefined
    },
  }

  return {
    host,
    agents,
    created,
    resumed,
    setResumable: (value: boolean) => void (resumable = value),
  }
}

let bindings: BindingStore

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-telegram-runner-'))
  bindings = await BindingStore.open(join(dir, 'bindings.json'))
})

function build(
  host: AgentHost,
  ids = ['s1', 's2', 's3'],
  visionModel?: () => { provider: string; model: string } | undefined,
) {
  const queue = [...ids]
  return new SessionRunner({
    host,
    bindings,
    cwd: '/work',
    newSessionId: () => queue.shift() ?? 'exhausted',
    ...(visionModel ? { visionModel } : {}),
  })
}

/** A prompt carrying an image, as a screenshot with a caption arrives. */
const withImage = (caption: string) => [
  { type: 'text' as const, text: caption },
  { type: 'image' as const, attachment: { attachmentId: 'a1' } as never },
]

const VISION = { provider: 'openai', model: 'gpt-5' }

describe('SessionRunner — first message', () => {
  it('creates a session and binds the chat to it', async () => {
    const fake = fakeHost()
    await build(fake.host).prompt(CHAT, text('hello'))

    expect(fake.created).toEqual(['s1'])
    expect(bindings.forChat(CHAT)?.sessionId).toBe('s1')
  })

  it('delivers the prompt to the new agent', async () => {
    const fake = fakeHost()
    await build(fake.host).prompt(CHAT, text('hello'))
    expect(fake.agents.get('s1')?.prompts).toEqual(['hello'])
  })

  it('starts the session in the configured working directory', async () => {
    const fake = fakeHost()
    const create = vi.spyOn(fake.host, 'create')
    await build(fake.host).prompt(CHAT, text('hello'))
    expect(create).toHaveBeenCalledWith('s1', '/work')
  })
})

describe('SessionRunner — continuing a conversation', () => {
  it('reuses the loaded agent for a second message', async () => {
    const fake = fakeHost()
    const runner = build(fake.host)

    await runner.prompt(CHAT, text('one'))
    await runner.prompt(CHAT, text('two'))

    expect(fake.created).toEqual(['s1'])
    expect(fake.agents.get('s1')?.prompts).toEqual(['one', 'two'])
  })

  it('resumes from the log after a restart', async () => {
    const first = fakeHost()
    await build(first.host).prompt(CHAT, text('before restart'))

    // A new process: the binding survives, the loaded agent does not.
    const second = fakeHost()
    await build(second.host).prompt(CHAT, text('after restart'))

    expect(second.resumed).toEqual(['s1'])
    expect(second.created).toEqual([])
  })

  it('starts fresh when the persisted session can no longer be loaded', async () => {
    const first = fakeHost()
    await build(first.host).prompt(CHAT, text('before'))

    const second = fakeHost()
    second.setResumable(false)
    await build(second.host, ['s9']).prompt(CHAT, text('after'))

    expect(second.created).toEqual(['s9'])
    expect(bindings.forChat(CHAT)?.sessionId).toBe('s9')
  })

  it('starts fresh when resuming throws outright', async () => {
    const first = fakeHost()
    await build(first.host).prompt(CHAT, text('before'))

    const second = fakeHost()
    vi.spyOn(second.host, 'resume').mockRejectedValueOnce(new Error('log is corrupt'))
    await build(second.host, ['s9']).prompt(CHAT, text('after'))

    expect(second.created).toEqual(['s9'])
  })

  it('does not create two sessions for two messages arriving together', async () => {
    const fake = fakeHost()
    const runner = build(fake.host)

    await Promise.all([runner.prompt(CHAT, text('one')), runner.prompt(CHAT, text('two'))])

    expect(fake.created).toEqual(['s1'])
    expect(fake.agents.get('s1')?.prompts).toEqual(['one', 'two'])
  })

  it('keeps separate conversations for separate chats', async () => {
    const fake = fakeHost()
    const runner = build(fake.host)

    await runner.prompt({ chatId: '1' }, text('a'))
    await runner.prompt({ chatId: '2' }, text('b'))

    expect(fake.created).toEqual(['s1', 's2'])
  })
})

describe('SessionRunner — reset', () => {
  it('forgets the binding so the next message starts fresh', async () => {
    const fake = fakeHost()
    const runner = build(fake.host)

    await runner.prompt(CHAT, text('one'))
    await runner.reset(CHAT)
    await runner.prompt(CHAT, text('two'))

    expect(fake.created).toEqual(['s1', 's2'])
  })

  it('disposes the loaded agent it is discarding', async () => {
    const fake = fakeHost()
    const runner = build(fake.host)

    await runner.prompt(CHAT, text('one'))
    await runner.reset(CHAT)

    expect(fake.agents.has('s1')).toBe(false)
  })

  it('does nothing for a chat that has no conversation yet', async () => {
    const fake = fakeHost()
    await expect(build(fake.host).reset(CHAT)).resolves.toBeUndefined()
  })

  it('still forgets the binding when disposal fails', async () => {
    const fake = fakeHost()
    const runner = build(fake.host)
    await runner.prompt(CHAT, text('one'))

    const agent = fake.agents.get('s1')
    if (agent) agent.dispose = async () => Promise.reject(new Error('stuck'))

    await runner.reset(CHAT)
    expect(bindings.forChat(CHAT)).toBeUndefined()
  })
})

describe('SessionRunner — stop and status', () => {
  it('cancels the loaded agent', async () => {
    const fake = fakeHost()
    const runner = build(fake.host)
    await runner.prompt(CHAT, text('one'))

    await expect(runner.stop(CHAT)).resolves.toBe(true)
    expect(fake.agents.get('s1')?.cancelled).toHaveLength(1)
  })

  it('reports nothing to stop for an unbound chat', async () => {
    const fake = fakeHost()
    await expect(build(fake.host).stop(CHAT)).resolves.toBe(false)
  })

  it('reports nothing to stop when the session is only on disk', async () => {
    const first = fakeHost()
    await build(first.host).prompt(CHAT, text('one'))

    const second = fakeHost()
    await expect(build(second.host).stop(CHAT)).resolves.toBe(false)
  })

  it('says there is no conversation before the first message', async () => {
    const fake = fakeHost()
    await expect(build(fake.host).status(CHAT)).resolves.toContain('No conversation yet')
  })

  it('reports the session id and working directory', async () => {
    const fake = fakeHost()
    const runner = build(fake.host)
    await runner.prompt(CHAT, text('one'))

    const status = await runner.status(CHAT)
    expect(status).toContain('s1')
    expect(status).toContain('/work')
    expect(status).toContain('loaded')
  })

  it('reports an unloaded session as idle', async () => {
    const first = fakeHost()
    await build(first.host).prompt(CHAT, text('one'))

    const second = fakeHost()
    expect(await build(second.host).status(CHAT)).toContain('idle')
  })
})


describe('SessionRunner — empty prompts', () => {
  it('does not wake an agent for a prompt with no content', async () => {
    // A message whose every attachment failed to read produces no parts.
    const fake = fakeHost()
    await build(fake.host).prompt(CHAT, [])
    expect(fake.created).toEqual([])
  })
})


describe('SessionRunner — the model an image turn runs on', () => {
  it('moves a turn carrying an image onto the vision model', async () => {
    const fake = fakeHost()
    await build(fake.host, ['s1'], () => VISION).prompt(CHAT, withImage('why this error?'))

    expect(fake.agents.get('s1')?.routes).toEqual([VISION])
  })

  it('keeps the next text turn there too, because the log still holds the image', async () => {
    // Per-turn is not possible: the provider inspects the whole history, so
    // reverting would fail every following turn.
    const fake = fakeHost()
    const runner = build(fake.host, ['s1'], () => VISION)

    await runner.prompt(CHAT, withImage('why this error?'))
    await runner.prompt(CHAT, text('now fix it'))

    expect(fake.agents.get('s1')?.routes).toEqual([VISION, VISION])
  })

  it('leaves an image turn alone when no vision model is configured', async () => {
    const fake = fakeHost()
    await build(fake.host, ['s1']).prompt(CHAT, withImage('look'))

    expect(fake.agents.get('s1')?.routes).toEqual([undefined])
  })

  it('does not move a text turn even when a vision model is configured', async () => {
    const fake = fakeHost()
    await build(fake.host, ['s1'], () => VISION).prompt(CHAT, text('just words'))

    expect(fake.agents.get('s1')?.routes).toEqual([undefined])
  })

  it('reads the setting per prompt, so a change applies to the next turn', async () => {
    const fake = fakeHost()
    const routes = [VISION, { provider: 'other', model: 'newer' }]
    const runner = build(fake.host, ['s1'], () => routes.shift())

    await runner.prompt(CHAT, withImage('one'))
    await runner.prompt(CHAT, withImage('two'))

    expect(fake.agents.get('s1')?.routes).toEqual([VISION, { provider: 'other', model: 'newer' }])
  })
})

describe('SessionRunner — a session that has carried an image', () => {
  it('keeps every later turn on the vision model, however plain its text', async () => {
    // A provider checks the whole request history, so a session whose log
    // holds an image fails on a text-only model forever after.
    const fake = fakeHost()
    const runner = build(fake.host, ['s1'], () => VISION)

    await runner.prompt(CHAT, withImage('why this error?'))
    await runner.prompt(CHAT, text('now fix it'))
    await runner.prompt(CHAT, text('and add a test'))

    expect(fake.agents.get('s1')?.routes).toEqual([VISION, VISION, VISION])
  })

  it('remembers across a restart, since the log outlives the process', async () => {
    const first = fakeHost()
    await build(first.host, ['s1'], () => VISION).prompt(CHAT, withImage('look'))

    const second = fakeHost()
    await build(second.host, ['s9'], () => VISION).prompt(CHAT, text('plain words'))

    expect(second.agents.get('s1')?.routes).toEqual([VISION])
  })

  it('starts clean after /new, so a fresh session is cheap again', async () => {
    const fake = fakeHost()
    const runner = build(fake.host, ['s1', 's2'], () => VISION)

    await runner.prompt(CHAT, withImage('look'))
    await runner.reset(CHAT)
    await runner.prompt(CHAT, text('plain words'))

    expect(fake.agents.get('s2')?.routes).toEqual([undefined])
  })

  it('leaves a conversation that never carried an image alone', async () => {
    const fake = fakeHost()
    const runner = build(fake.host, ['s1'], () => VISION)

    await runner.prompt(CHAT, text('one'))
    await runner.prompt(CHAT, text('two'))

    expect(fake.agents.get('s1')?.routes).toEqual([undefined, undefined])
  })
})
