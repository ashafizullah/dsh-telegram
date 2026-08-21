import { describe, expect, it, vi } from 'vitest'

import { createAgentHost } from '../src/harness/host.js'
import type { AgentRegistryLike } from '../src/harness/host.js'
import { buildUserMessage } from '../src/harness/message.js'
import { parseRoute, sameRoute } from '../src/harness/model-selection.js'

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

const message = (content: readonly unknown[]) => ({ content })

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
    agent.followup([{ type: 'text', text: 'do the thing' }])

    expect(fake.bare.get('s1')?.prompts).toEqual([
      { content: [{ type: 'text', text: 'do the thing' }] },
    ])
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
  const TEXT = [{ type: 'text' as const, text: 'hello' }]

  it('builds the documented user-message shape', () => {
    const built = buildUserMessage(TEXT)
    expect(built.role).toBe('user')
    expect(built.content).toEqual(TEXT)
    expect(built.source).toEqual({ kind: 'user' })
  })

  it('carries an image block beside the text, which is how a screenshot arrives', () => {
    const built = buildUserMessage([
      { type: 'text', text: 'why this error?' },
      { type: 'image', attachment: { attachmentId: 'a1' } },
    ])
    expect(built.content.map((block) => block.type)).toEqual(['text', 'image'])
  })

  it('gives every message its own identity', () => {
    expect(buildUserMessage(TEXT).id).not.toBe(buildUserMessage(TEXT).id)
  })

  it('freezes the message, since the harness publishes it as immutable', () => {
    expect(Object.isFrozen(buildUserMessage(TEXT))).toBe(true)
  })

  it('builds the same shape the harness factory would', async () => {
    // A plugin cannot import that factory, so this shape is the contract.
    expect(buildUserMessage(TEXT).content).toEqual(TEXT)
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

describe('parseRoute', () => {
  it('splits provider from model', () => {
    expect(parseRoute('openai/gpt-5')).toEqual({ provider: 'openai', model: 'gpt-5' })
  })

  it('splits on the first separator only, since a model id may contain one', () => {
    // 'openai/gpt-5' on a router-style provider is an ordinary model id.
    expect(parseRoute('router/openai/gpt-5')).toEqual({
      provider: 'router',
      model: 'openai/gpt-5',
    })
  })

  it('ignores surrounding whitespace', () => {
    expect(parseRoute('  openai/gpt-5  ')).toEqual({ provider: 'openai', model: 'gpt-5' })
  })

  it('reads an empty setting as no vision model', () => {
    expect(parseRoute('')).toBeUndefined()
    expect(parseRoute('   ')).toBeUndefined()
    expect(parseRoute(undefined)).toBeUndefined()
  })

  it('refuses a value missing one half', () => {
    expect(parseRoute('openai')).toBeUndefined()
    expect(parseRoute('/gpt-5')).toBeUndefined()
    expect(parseRoute('openai/')).toBeUndefined()
  })
})

describe('sameRoute', () => {
  it('recognises the same model', () => {
    expect(sameRoute({ provider: 'a', model: 'b' }, { provider: 'a', model: 'b' })).toBe(true)
  })

  it('distinguishes a different provider or model', () => {
    expect(sameRoute({ provider: 'a', model: 'b' }, { provider: 'x', model: 'b' })).toBe(false)
    expect(sameRoute({ provider: 'a', model: 'b' }, { provider: 'a', model: 'x' })).toBe(false)
  })

  it('treats two absent overrides as the same', () => {
    expect(sameRoute(undefined, undefined)).toBe(true)
    expect(sameRoute({ provider: 'a', model: 'b' }, undefined)).toBe(false)
  })
})
