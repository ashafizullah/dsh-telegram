/**
 * Driving harness agents.
 *
 * This is the one module that reaches into `ctx.agents`, so the rest of the
 * plugin can be tested without a harness. It translates between the harness's
 * ownership model and the flat {@link RunningAgent} the session runner wants.
 *
 * The distinction that matters is who may tear an agent down. `ctx.agents.get`
 * returns a bare agent that anyone can observe but nobody can dispose;
 * `create`/`resume` return a handle whose disposer is a capability. So handles
 * are kept for the agents this plugin created, and a bare agent found in the
 * registry is borrowed and left alone — disposing something another owner
 * created would pull the session out from under them.
 */

import type { Logger } from './types.js'
import type { AgentHost, RunningAgent } from '../session/runner.js'
import type { MessageFactory } from './message.js'

/** A bare agent from the registry. */
interface HarnessAgentLike {
  readonly id: string
  followup(message: unknown): void
  cancel(cause: string, options?: { keepInbox?: boolean }): void
}

/** An owned agent plus its disposer. */
interface HarnessAgentHandle {
  readonly agent: HarnessAgentLike
  dispose(): Promise<void>
}

/** The model route an agent opens its requests on. */
export interface ModelRoute {
  readonly provider: string
  readonly model: string
}

/** The `ctx.agents` surface this plugin uses. */
export interface AgentRegistryLike {
  get(sessionId: string): HarnessAgentLike | undefined
  create(options: {
    sessionId: string
    meta?: { cwd?: string }
    agentOptions?: ModelRoute
  }): Promise<HarnessAgentHandle>
  resume(options: {
    resumeSessionId: string
    agentOptions?: ModelRoute
  }): Promise<HarnessAgentHandle>
}

/** Construction options. */
export interface HarnessAgentHostOptions {
  readonly agents: AgentRegistryLike
  readonly message: MessageFactory
  /**
   * The deployment's model route, read at creation time rather than captured,
   * so a default changed in Settings reaches the next conversation.
   *
   * An agent created without one has no route to name, and prompt assembly
   * fails the turn on an empty `{{model}}` variable — a failure that surfaces
   * as a broken reply rather than as anything about models.
   */
  readonly selectModel?: () => ModelRoute | undefined
  readonly logger?: Logger
}

/**
 * Build an {@link AgentHost} over the live harness registry.
 *
 * @param options - the registry, the message factory, and a logger.
 */
export function createAgentHost(options: HarnessAgentHostOptions): AgentHost {
  /** Handles for agents this plugin owns, so it can dispose exactly those. */
  const owned = new Map<string, HarnessAgentHandle>()

  const wrap = (agent: HarnessAgentLike, sessionId: string): RunningAgent => ({
    sessionId,

    followup(text: string) {
      agent.followup(options.message(text))
    },

    cancel(reason: string) {
      agent.cancel(reason)
    },

    async dispose() {
      const handle = owned.get(sessionId)
      owned.delete(sessionId)
      // Only an owner may dispose. A borrowed agent is simply released.
      if (handle) await handle.dispose()
    },
  })

  const adopt = (handle: HarnessAgentHandle, sessionId: string): RunningAgent => {
    owned.set(sessionId, handle)
    return wrap(handle.agent, sessionId)
  }

  return {
    live(sessionId) {
      const owner = owned.get(sessionId)
      if (owner) return wrap(owner.agent, sessionId)

      const bare = options.agents.get(sessionId)
      return bare ? wrap(bare, sessionId) : undefined
    },

    async create(sessionId, cwd) {
      const route = options.selectModel?.()
      const handle = await options.agents.create({
        sessionId,
        meta: { cwd },
        ...(route ? { agentOptions: route } : {}),
      })
      return adopt(handle, sessionId)
    },

    async resume(sessionId) {
      try {
        // Supplied on resume too, matching the harness's own entry points: a
        // log that already names a selection keeps it, and one that does not
        // — such as a session created before this route existed — is repaired.
        const route = options.selectModel?.()
        const handle = await options.agents.resume({
          resumeSessionId: sessionId,
          ...(route ? { agentOptions: route } : {}),
        })
        return adopt(handle, sessionId)
      } catch (error) {
        // A pruned, moved, or incompatible log is an ordinary outcome here; the
        // runner starts a fresh conversation rather than failing the message.
        options.logger?.debug(`[dsh-telegram] resume of '${sessionId}' failed`, error)
        return undefined
      }
    },
  }
}
