import { describe, expect, it, vi } from 'vitest'

import { createAgentHost } from '../src/harness/host.js'
import type { AgentRegistryLike } from '../src/harness/host.js'
import { fallbackMessage, resolveMessageFactory } from '../src/harness/message.js'

/** A registry standing in for ctx.agents, tracking who disposed what. */
function fakeRegistry() {
  const bare = new Map<string, { id: string; prompts: unknown[]; cancels: string[] }>()
  const disposed: string[] = []
  let resumeFails = false

  const make = (id: string) => {
    const agent = {
      id,
      prompts: [] as unknown[],
      cancels: [] as string[],
      followup(message: unknown) {
        agent.prompts.push(message)
      },
      cancel(cause: string) {
        agent.cancels.push(cause)
      },
    }
    bare.set(id, agent)
    return agent
  }

  const routes: (unknown | undefined)[] = []

  const registry: AgentRegistryLike = {
    get: (sessionId) => bare.get(sessionId),
    async create({ sessionId, agentOptions }) {
      routes.push(agentOptions)
      const agent = make(sessionId)
      return {
        agent,
        dispose: async () => void disposed.push(sessionId),
      }
    },
    async resume({ resumeSessionId, agentOptions }) {
      routes.push(agentOptions)
      if (resumeFails) throw new Error('session log is gone')
      const agent = make(resumeSessionId)
      return {
        agent,
        dispose: async () => void disposed.push(resumeSessionId),
      }
    },
  }

  return { registry, bare, disposed, routes, failResume: () => void (resumeFails = true), make }
}

const message = (text: string) => ({ text })

function build(registry: AgentRegistryLike, selectModel?: () => { provider: string; model: string } | undefined) {
  return createAgentHost({
    agents: registry,
    message: message as never,
    ...(selectModel ? { selectModel } : {}),
  })
}

const ROUTE = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }

describe('createAgentHost — creating', () => {
  it('creates a session under the requested id and cwd', async () => {
    const fake = fakeRegistry()
    const create = vi.spyOn(fake.registry, 'create')

    await build(fake.registry).create('s1', '/work')
    expect(create).toHaveBeenCalledWith({ sessionId: 's1', meta: { cwd: '/work' } })
  })

  it('sends a prompt through the message factory', async () => {
    const fake = fakeRegistry()
    const agent = await build(fake.registry).create('s1', '/work')
    agent.followup('do the thing')

    expect(fake.bare.get('s1')?.prompts).toEqual([{ text: 'do the thing' }])
  })

  it('passes a cancellation cause through', async () => {
    const fake = fakeRegistry()
    const agent = await build(fake.registry).create('s1', '/work')
    agent.cancel('stopped from Telegram')

    expect(fake.bare.get('s1')?.cancels).toEqual(['stopped from Telegram'])
  })
})

describe('createAgentHost — ownership', () => {
  it('disposes an agent it created', async () => {
    const fake = fakeRegistry()
    const host = build(fake.registry)
    const agent = await host.create('s1', '/work')

    await agent.dispose()
    expect(fake.disposed).toEqual(['s1'])
  })

  it('never disposes an agent another owner created', async () => {
    const fake = fakeRegistry()
    fake.make('borrowed')

    const agent = build(fake.registry).live('borrowed')
    await agent?.dispose()

    expect(fake.disposed).toEqual([])
  })

  it('disposes an owned agent only once', async () => {
    const fake = fakeRegistry()
    const host = build(fake.registry)
    const agent = await host.create('s1', '/work')

    await agent.dispose()
    await agent.dispose()
    expect(fake.disposed).toEqual(['s1'])
  })
})

describe('createAgentHost — finding a live agent', () => {
  it('finds an agent it created', async () => {
    const fake = fakeRegistry()
    const host = build(fake.registry)
    await host.create('s1', '/work')

    expect(host.live('s1')?.sessionId).toBe('s1')
  })

  it('finds a bare agent from the registry', () => {
    const fake = fakeRegistry()
    fake.make('elsewhere')
    expect(build(fake.registry).live('elsewhere')?.sessionId).toBe('elsewhere')
  })

  it('reports nothing for a session that is not loaded', () => {
    const fake = fakeRegistry()
    expect(build(fake.registry).live('cold')).toBeUndefined()
  })
})

describe('createAgentHost — resuming', () => {
  it('resumes a persisted session', async () => {
    const fake = fakeRegistry()
    const agent = await build(fake.registry).resume('s1')
    expect(agent?.sessionId).toBe('s1')
  })

  it('reports a failed resume rather than throwing', async () => {
    const fake = fakeRegistry()
    fake.failResume()
    await expect(build(fake.registry).resume('s1')).resolves.toBeUndefined()
  })

  it('owns what it resumed, so it may dispose it', async () => {
    const fake = fakeRegistry()
    const agent = await build(fake.registry).resume('s1')
    await agent?.dispose()
    expect(fake.disposed).toEqual(['s1'])
  })
})

describe('message factory', () => {
  it('builds the documented user-message shape', () => {
    const built = fallbackMessage('hello')
    expect(built.role).toBe('user')
    expect(built.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(built.source).toEqual({ kind: 'user' })
  })

  it('gives every message its own identity', () => {
    expect(fallbackMessage('a').id).not.toBe(fallbackMessage('b').id)
  })

  it('freezes the message, since the harness publishes it as immutable', () => {
    expect(Object.isFrozen(fallbackMessage('hello'))).toBe(true)
  })

  it('falls back cleanly when the harness module is absent', async () => {
    // Nothing provides @deepseek-ai/dsh-llm here, which is the case this guards.
    const factory = await resolveMessageFactory()
    expect(factory('hi').content).toEqual([{ type: 'text', text: 'hi' }])
  })
})


describe('createAgentHost — the model route', () => {
  it('gives a new agent a route, without which every turn fails to assemble', async () => {
    const fake = fakeRegistry()
    await build(fake.registry, () => ROUTE).create('s1', '/work')
    expect(fake.routes[0]).toEqual(ROUTE)
  })

  it('gives a resumed agent one too, repairing a session created without', async () => {
    const fake = fakeRegistry()
    await build(fake.registry, () => ROUTE).resume('s1')
    expect(fake.routes[0]).toEqual(ROUTE)
  })

  it('reads the route per agent, so a changed default reaches the next one', async () => {
    const fake = fakeRegistry()
    const routes = [ROUTE, { provider: 'other', model: 'newer' }]
    const host = build(fake.registry, () => routes.shift())

    await host.create('s1', '/work')
    await host.create('s2', '/work')

    expect(fake.routes[0]).toEqual(ROUTE)
    expect(fake.routes[1]).toEqual({ provider: 'other', model: 'newer' })
  })

  it('omits the option entirely when no route is available', async () => {
    const fake = fakeRegistry()
    await build(fake.registry, () => undefined).create('s1', '/work')
    expect(fake.routes[0]).toBeUndefined()
  })

  it('still creates agents on a deployment with no default-model service', async () => {
    const fake = fakeRegistry()
    const agent = await build(fake.registry).create('s1', '/work')
    expect(agent.sessionId).toBe('s1')
  })
})
