/**
 * One harness session per Telegram conversation.
 *
 * The lifecycle has three states and the transitions between them are the
 * whole job: a conversation with no session yet, one whose session is loaded
 * in this process, and one whose session exists only in the durable log
 * because the harness has restarted since.
 *
 * The third case is why `resume` exists and why a failed resume is not fatal.
 * A session log can be pruned, moved, or written by an incompatible version;
 * when it can no longer be loaded, the user gets a fresh conversation and a
 * note, which is far better than a bot that answers every message with the
 * same load error.
 *
 * The agent host is injected rather than reached for directly, so this logic
 * is exercised without a running harness.
 */

import { randomUUID } from 'node:crypto'

import type { ChatTarget } from '../interact/surface.js'
import type { AgentRunner } from '../router.js'
import type { Logger } from '../harness/types.js'
import { SILENT_LOGGER } from '../harness/types.js'

import type { BindingStore } from './bindings.js'

/** A live agent this plugin drives. */
export interface RunningAgent {
  readonly sessionId: string
  /** Queue a user message and wake the driver. */
  followup(text: string): void
  /** Cancel the in-flight turn and any queued work. */
  cancel(reason: string): void
  /** Stop the agent and release its session. */
  dispose(): Promise<void>
}

/** Creating and loading agents — the harness surface, narrowed. */
export interface AgentHost {
  /** The agent for a session if it is already loaded in this process. */
  live(sessionId: string): RunningAgent | undefined
  /** Start a new session and agent under `sessionId`. */
  create(sessionId: string, cwd: string): Promise<RunningAgent>
  /** Load a persisted session; undefined when it can no longer be loaded. */
  resume(sessionId: string): Promise<RunningAgent | undefined>
}

/** Construction options. */
export interface SessionRunnerOptions {
  readonly host: AgentHost
  readonly bindings: BindingStore
  /** Working directory new sessions start in. */
  readonly cwd: string
  /** Session id factory; injected so tests can assert on stable ids. */
  readonly newSessionId?: () => string
  readonly logger?: Logger
}

export class SessionRunner implements AgentRunner {
  private readonly logger: Logger
  private readonly newSessionId: () => string
  /** Serialises work per conversation, so two fast messages cannot both create. */
  private readonly chains = new Map<string, Promise<unknown>>()

  constructor(private readonly options: SessionRunnerOptions) {
    this.logger = options.logger ?? SILENT_LOGGER
    this.newSessionId = options.newSessionId ?? (() => `tg-${randomUUID()}`)
  }

  /**
   * Deliver a prompt, opening or resuming the conversation's session first.
   *
   * @param target - the conversation the prompt came from.
   * @param text - what the user typed.
   */
  async prompt(target: ChatTarget, text: string): Promise<void> {
    await this.serialize(target, async () => {
      const agent = await this.agentFor(target)
      agent.followup(text)
    })
  }

  /**
   * Forget the conversation's session so the next prompt opens a new one.
   *
   * @param target - the conversation to reset.
   */
  async reset(target: ChatTarget): Promise<void> {
    await this.serialize(target, async () => {
      const binding = this.options.bindings.forChat(target)
      if (!binding) return

      const live = this.options.host.live(binding.sessionId)
      if (live) await live.dispose().catch((error: unknown) => {
        this.logger.warn('[dsh-telegram] could not dispose the previous agent', error)
      })

      await this.options.bindings.unbind(target)
    })
  }

  /**
   * Cancel whatever the conversation's agent is doing.
   *
   * @returns whether there was a loaded agent to cancel.
   */
  async stop(target: ChatTarget): Promise<boolean> {
    const binding = this.options.bindings.forChat(target)
    if (!binding) return false

    const live = this.options.host.live(binding.sessionId)
    if (!live) return false

    live.cancel('stopped from Telegram')
    return true
  }

  /**
   * Describe the conversation, as Telegram HTML.
   */
  async status(target: ChatTarget): Promise<string> {
    const binding = this.options.bindings.forChat(target)
    if (!binding) return 'No conversation yet — send a message to start one.'

    const live = this.options.host.live(binding.sessionId) !== undefined
    return [
      `<b>Session</b> <code>${binding.sessionId}</code>`,
      `<b>Working directory</b> <code>${this.options.cwd}</code>`,
      `<b>State</b> ${live ? 'loaded' : 'idle (will resume on your next message)'}`,
      `<b>Since</b> ${new Date(binding.createdAt).toISOString()}`,
    ].join('\n')
  }

  /**
   * The agent for a conversation: loaded, resumed, or freshly created.
   *
   * A binding whose session cannot be resumed is replaced rather than
   * reported: the user's next message should work.
   */
  private async agentFor(target: ChatTarget): Promise<RunningAgent> {
    const binding = this.options.bindings.forChat(target)

    if (binding) {
      const live = this.options.host.live(binding.sessionId)
      if (live) return live

      const resumed = await this.options.host.resume(binding.sessionId).catch((error: unknown) => {
        this.logger.warn(`[dsh-telegram] could not resume '${binding.sessionId}'`, error)
        return undefined
      })
      if (resumed) return resumed

      this.logger.warn(
        `[dsh-telegram] session '${binding.sessionId}' is gone; starting a fresh conversation`,
      )
      await this.options.bindings.unbind(target)
    }

    const sessionId = this.newSessionId()
    const agent = await this.options.host.create(sessionId, this.options.cwd)
    await this.options.bindings.bind(target, sessionId)
    return agent
  }

  /**
   * Run one conversation's work after its previous work.
   *
   * Two messages arriving in the same poll batch would otherwise both see no
   * binding and both create a session, orphaning the first.
   */
  private serialize<T>(target: ChatTarget, task: () => Promise<T>): Promise<T> {
    const key = target.threadId === undefined ? target.chatId : `${target.chatId}#${target.threadId}`
    const previous = this.chains.get(key) ?? Promise.resolve()
    const next = previous.then(task, task)

    this.chains.set(
      key,
      next.then(
        () => undefined,
        () => undefined,
      ),
    )
    return next
  }
}
