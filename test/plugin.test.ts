import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Config, apply } from '../src/index.js'

/**
 * A stand-in Bot API over real HTTP, so the plugin exercises its actual fetch
 * path, JSON encoding, and long-poll loop rather than a mocked client.
 */
function botApiServer() {
  const calls: { method: string; body: Record<string, unknown> }[] = []
  const updates: unknown[][] = []

  const server: Server = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => (raw += chunk))
    request.on('end', () => {
      const method = (request.url ?? '').split('/').pop() ?? ''
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
      calls.push({ method, body })

      const result =
        method === 'getMe'
          ? { id: 1, is_bot: true, username: 'test_bot' }
          : method === 'getUpdates'
            ? (updates.shift() ?? [])
            : method === 'sendMessage'
              ? { message_id: calls.length }
              : true

      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, result }))
    })
  })

  return {
    server,
    calls,
    queueUpdates: (batch: unknown[]) => void updates.push(batch),
    listen: () =>
      new Promise<number>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const address = server.address()
          resolve(typeof address === 'object' && address ? address.port : 0)
        })
      }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    of: (method: string) => calls.filter((call) => call.method === method),
  }
}

/** A cordis-shaped context carrying just the seams the plugin binds to. */
function fakeContext() {
  const prompts: string[] = []
  const created: string[] = []
  const services = new Map<string, unknown>()
  const listeners = new Map<string, unknown[]>()
  let disposeEffect: (() => void) | undefined

  const agents = {
    get: () => undefined,
    async create({ sessionId }: { sessionId: string }) {
      created.push(sessionId)
      return {
        agent: {
          id: sessionId,
          followup: (message: { content?: { text?: string }[] }) =>
            void prompts.push(message.content?.[0]?.text ?? ''),
          cancel: () => undefined,
        },
        dispose: async () => undefined,
      }
    },
    async resume() {
      throw new Error('nothing persisted')
    },
  }

  const watchers: ((next: unknown, prev: unknown) => void)[] = []
  let registered: { namespace: string; value: unknown } | undefined

  const settings = {
    register(namespace: string, _schema: unknown, options?: { base?: unknown }) {
      registered = { namespace, value: options?.base }
      return {
        get: () => registered?.value,
        watch(callback: (next: unknown, prev: unknown) => void) {
          watchers.push(callback)
          return () => undefined
        },
        update: async () => undefined,
      }
    },
  }

  const ctx: Record<string, unknown> = {
    agents,
    credentials: { resolve: async () => ({ value: '123456:TEST-TOKEN' }) },
    logger: () => ({
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    }),
    get: (key: string) => services.get(key),
    on(name: string, listener: unknown) {
      listeners.set(name, [...(listeners.get(name) ?? []), listener])
      return () => undefined
    },
    effect(callback: () => () => void) {
      disposeEffect = callback()
      return () => disposeEffect?.()
    },
    inject(names: readonly string[], callback: (scope: unknown) => void) {
      // Cordis runs the callback only once every named service exists, and
      // hands it a scope of its own whose effects unwind with it.
      if (names.every((service) => services.has(service))) {
        callback({ ...ctx, effect: (run: () => unknown) => void run() })
      }
      return { dispose: () => undefined }
    },
  }

  return {
    ctx,
    prompts,
    created,
    listeners,
    provide: (key: string, value: unknown) => services.set(key, value),
    stop: () => disposeEffect?.(),
    /** Install the settings seam, as a profile with a provider would. */
    withSettings: () => services.set('settings', settings),
    registration: () => registered,
    /** Push a committed settings change, as the real seam would. */
    commit: (next: unknown) => {
      if (registered) registered = { ...registered, value: next }
      for (const watcher of watchers) watcher(next, undefined)
    },
  }
}

const textUpdate = (id: number, text: string) => ({
  update_id: id,
  message: {
    message_id: id,
    chat: { id: 500, type: 'private' },
    from: { id: 7 },
    text,
  },
})

let bot: ReturnType<typeof botApiServer>
let port: number
let home: string

beforeEach(async () => {
  bot = botApiServer()
  port = await bot.listen()
  home = await mkdtemp(join(tmpdir(), 'dsh-telegram-plugin-'))
  process.env.DSH_HOME = home
})

afterEach(async () => {
  await bot.close()
  delete process.env.DSH_HOME
})

/** Config pointed at the stub server, with access already granted to user 7. */
function config(overrides: Record<string, unknown> = {}) {
  return Config({
    baseUrl: `http://127.0.0.1:${port}`,
    allowFrom: [7],
    cwd: home,
    longPollSeconds: 1,
    streaming: { throttleMs: 0 },
    ...overrides,
  })
}

describe('apply — connecting', () => {
  it('verifies the token and clears any webhook before polling', async () => {
    const harness = fakeContext()
    apply(harness.ctx as never, config())

    await vi.waitFor(() => expect(bot.of('getUpdates').length).toBeGreaterThan(0))
    harness.stop()

    expect(bot.of('getMe')).toHaveLength(1)
    expect(bot.of('deleteWebhook')).toHaveLength(1)
  })

  it('subscribes to callback_query, which is what makes buttons work', async () => {
    const harness = fakeContext()
    apply(harness.ctx as never, config())

    await vi.waitFor(() => expect(bot.of('getUpdates').length).toBeGreaterThan(0))
    harness.stop()

    expect(bot.of('getUpdates')[0]?.body.allowed_updates).toEqual(['message', 'callback_query'])
  })

  it('does nothing at all when disabled', async () => {
    const harness = fakeContext()
    apply(harness.ctx as never, config({ enabled: false }))

    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(bot.calls).toHaveLength(0)
    harness.stop()
  })

  it('stays idle without a token instead of failing to load', async () => {
    const harness = fakeContext()
    harness.ctx.credentials = { resolve: async () => undefined }

    apply(harness.ctx as never, config())
    await new Promise((resolve) => setTimeout(resolve, 150))

    expect(bot.calls).toHaveLength(0)
    harness.stop()
  })
})

describe('apply — end to end', () => {
  it('turns an incoming message into a prompt for a new session', async () => {
    const harness = fakeContext()
    bot.queueUpdates([textUpdate(1, 'run the tests')])

    apply(harness.ctx as never, config())
    await vi.waitFor(() => expect(harness.prompts).toEqual(['run the tests']))
    harness.stop()

    expect(harness.created).toHaveLength(1)
  })

  it('answers a command in the chat without touching the agent', async () => {
    const harness = fakeContext()
    bot.queueUpdates([textUpdate(1, '/help')])

    apply(harness.ctx as never, config())
    await vi.waitFor(() => expect(bot.of('sendMessage').length).toBeGreaterThan(0))
    harness.stop()

    expect(bot.of('sendMessage')[0]?.body.text).toContain('/new')
    expect(harness.prompts).toHaveLength(0)
  })

  it('refuses a message from a user who is not allowed', async () => {
    const harness = fakeContext()
    bot.queueUpdates([
      { ...textUpdate(1, 'do it'), message: { ...textUpdate(1, 'do it').message, from: { id: 99 } } },
    ])

    apply(harness.ctx as never, config())
    await vi.waitFor(() => expect(bot.of('sendMessage').length).toBeGreaterThan(0))
    harness.stop()

    expect(harness.prompts).toHaveLength(0)
    expect(bot.of('sendMessage')[0]?.body.text).toContain('not allowed')
  })

  it('subscribes to the session feed so replies can stream out', async () => {
    const harness = fakeContext()
    apply(harness.ctx as never, config())

    await vi.waitFor(() => expect(harness.listeners.has('session/event')).toBe(true))
    harness.stop()
  })
})

describe('apply — interactive seams', () => {
  it('registers a user-questions provider when the seam exists', async () => {
    const harness = fakeContext()
    const service: { provider?: unknown; registerProvider: (p: unknown) => () => void } = {
      provider: undefined,
      registerProvider(provider) {
        service.provider = provider
        return () => void (service.provider = undefined)
      },
    }
    harness.provide('userQuestions', service)

    apply(harness.ctx as never, config())
    await vi.waitFor(() => expect(service.provider).toBeDefined())
    harness.stop()
  })

  it('answers the approval waterfall when the seam exists', async () => {
    const harness = fakeContext()
    harness.provide('approval', {})

    apply(harness.ctx as never, config())
    await vi.waitFor(() => expect(harness.listeners.has('approval/request')).toBe(true))
    harness.stop()
  })

  it('loads fine on a profile that provides neither seam', async () => {
    const harness = fakeContext()
    bot.queueUpdates([textUpdate(1, 'still works')])

    apply(harness.ctx as never, config())
    await vi.waitFor(() => expect(harness.prompts).toEqual(['still works']))
    harness.stop()
  })
})


describe('apply — settings namespace', () => {
  it('registers its namespace so a configuration UI has something to bind', async () => {
    const harness = fakeContext()
    harness.withSettings()

    apply(harness.ctx as never, config())
    await vi.waitFor(() => expect(bot.of('getMe').length).toBeGreaterThan(0))
    harness.stop()

    expect(harness.registration()?.namespace).toBe('telegram')
  })

  it('registers even while disabled, or nothing could ever re-enable it', async () => {
    const harness = fakeContext()
    harness.withSettings()

    apply(harness.ctx as never, config({ enabled: false }))
    await new Promise((resolve) => setTimeout(resolve, 100))
    harness.stop()

    expect(harness.registration()?.namespace).toBe('telegram')
    expect(bot.calls).toHaveLength(0)
  })

  it('prefers the resolved settings value over the composed config', async () => {
    const harness = fakeContext()
    harness.withSettings()

    // The composed config says enabled; the resolved settings value says not.
    apply(harness.ctx as never, config())
    await vi.waitFor(() => expect(bot.of('getMe').length).toBe(1))

    harness.commit({ ...config({ enabled: false }) })
    await new Promise((resolve) => setTimeout(resolve, 150))
    const after = bot.of('getMe').length
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(bot.of('getMe')).toHaveLength(after)
    harness.stop()
  })

  it('reconnects when the configuration changes, without a restart', async () => {
    const harness = fakeContext()
    harness.withSettings()

    apply(harness.ctx as never, config())
    await vi.waitFor(() => expect(bot.of('getMe').length).toBe(1))

    harness.commit(config({ streaming: { throttleMs: 50 } }))
    await vi.waitFor(() => expect(bot.of('getMe').length).toBe(2))

    harness.stop()
  })

  it('opens exactly one connection at boot, not one per configuration source', async () => {
    const harness = fakeContext()
    harness.withSettings()

    apply(harness.ctx as never, config())
    await vi.waitFor(() => expect(bot.of('getUpdates').length).toBeGreaterThan(0))
    await new Promise((resolve) => setTimeout(resolve, 150))
    harness.stop()

    // Adopting a resolved value equal to the composed one must not reconnect.
    expect(bot.of('getMe')).toHaveLength(1)
  })

  it('runs on a profile with no settings provider at all', async () => {
    const harness = fakeContext()
    bot.queueUpdates([textUpdate(1, 'no settings here')])

    apply(harness.ctx as never, config())
    await vi.waitFor(() => expect(harness.prompts).toEqual(['no settings here']))
    harness.stop()
  })
})
