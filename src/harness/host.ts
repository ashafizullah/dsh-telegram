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
import type { AgentContextLike, MutableSelection } from './model-selection.js'
import { sameRoute } from './model-selection.js'

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

/** What this plugin keeps for an agent it owns. */
interface OwnedAgent {
  readonly handle: HarnessAgentHandle
  /** Mutated to move the next step onto another model; undefined = its own. */
  readonly selection: MutableSelection
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
    setup?: (agentCtx: unknown) => void
  }): Promise<HarnessAgentHandle>
  resume(options: {
    resumeSessionId: string
    agentOptions?: ModelRoute
    setup?: (agentCtx: unknown) => void
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
  /**
   * Installs the mutable model selection into a new agent's scope. Absent
   * leaves every turn on the session's own route.
   */
  readonly installSelection?: (agentCtx: AgentContextLike, selection: MutableSelection) => void
  readonly logger?: Logger
}

/**
 * Build an {@link AgentHost} over the live harness registry.
 *
 * @param options - the registry, the message factory, and a logger.
 */
export function createAgentHost(options: HarnessAgentHostOptions): AgentHost {
  /** Agents this plugin owns, so it can dispose and re-route exactly those. */
  const owned = new Map<string, OwnedAgent>()

  const wrap = (agent: HarnessAgentLike, sessionId: string): RunningAgent => ({
    sessionId,

    followup(content) {
      agent.followup(options.message(content))
    },

    useModel(route) {
      const entry = owned.get(sessionId)
      // A borrowed agent carries no selection of ours; its route is its own.
      if (!entry) return false
      if (sameRoute(entry.selection.current, route)) return true

      entry.selection.current = route
      return true
    },

    cancel(reason: string) {
      agent.cancel(reason)
    },

    async dispose() {
      const entry = owned.get(sessionId)
      owned.delete(sessionId)
      // Only an owner may dispose. A borrowed agent is simply released.
      if (entry) await entry.handle.dispose()
    },
  })

  const adopt = (
    handle: HarnessAgentHandle,
    sessionId: string,
    selection: MutableSelection,
  ): RunningAgent => {
    owned.set(sessionId, { handle, selection })
    return wrap(handle.agent, sessionId)
  }

  /** A fresh selection plus the setup that installs it, for one new agent. */
  const prepareSelection = () => {
    const selection: MutableSelection = { current: undefined }
    const install = options.installSelection
    return {
      selection,
      ...(install
        ? { setup: (agentCtx: unknown) => install(agentCtx as AgentContextLike, selection) }
        : {}),
    }
  }

  return {
    live(sessionId) {
      const owner = owned.get(sessionId)
      if (owner) return wrap(owner.handle.agent, sessionId)

      const bare = options.agents.get(sessionId)
      return bare ? wrap(bare, sessionId) : undefined
    },

    async create(sessionId, cwd) {
      const route = options.selectModel?.()
      const prepared = prepareSelection()
      const handle = await options.agents.create({
        sessionId,
        meta: { cwd },
        ...(route ? { agentOptions: route } : {}),
        ...(prepared.setup ? { setup: prepared.setup } : {}),
      })
      return adopt(handle, sessionId, prepared.selection)
    },

    async resume(sessionId) {
      try {
        // Supplied on resume too, matching the harness's own entry points: a
        // log that already names a selection keeps it, and one that does not
        // — such as a session created before this route existed — is repaired.
        const route = options.selectModel?.()
        const prepared = prepareSelection()
        const handle = await options.agents.resume({
          resumeSessionId: sessionId,
          ...(route ? { agentOptions: route } : {}),
          ...(prepared.setup ? { setup: prepared.setup } : {}),
        })
        return adopt(handle, sessionId, prepared.selection)
      } catch (error) {
        // A pruned, moved, or incompatible log is an ordinary outcome here; the
        // runner starts a fresh conversation rather than failing the message.
        options.logger?.debug(`[dsh-telegram] resume of '${sessionId}' failed`, error)
        return undefined
      }
    },
  }
}
