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
import type { PromptPart } from '../media/collect.js'
import type { ModelRoute } from '../harness/model-selection.js'
import type { AgentRunner } from '../router.js'
import type { Logger } from '../harness/types.js'
import { SILENT_LOGGER } from '../harness/types.js'

import type { BindingStore } from './bindings.js'

/** Whether a prompt carries an image, which changes a conversation for good. */
function carriesImage(content: readonly PromptPart[]): boolean {
  return content.some((part) => part.type === 'image')
}

/** A live agent this plugin drives. */
export interface RunningAgent {
  readonly sessionId: string
  /** Queue a user message and wake the driver. */
  followup(content: readonly PromptPart[]): void
  /**
   * Route the next step onto another model, or back to the agent's own.
   *
   * @param route - the override, or undefined to drop it.
   * @returns whether the agent accepts an override at all; a borrowed agent,
   *   or a harness that offers no selection seam, does not.
   */
  useModel(route: ModelRoute | undefined): boolean
  /** Cancel the in-flight turn and any queued work. */
  cancel(reason: string): void
  /** Stop the agent and release its session. */
  dispose(): Promise<void>
}

/** Creating and loading agents — the harness surface, narrowed. */
export interface AgentHost {
  /** The agent for a session if it is already loaded in this process. */
  live(sessionId: string): RunningAgent | undefined
  /**
   * Start a new session and agent under `sessionId`.
   *
   * @param route - forces the model rather than taking the deployment's
   *   default. Used by the throwaway session an image is read in, which has to
   *   run somewhere that can see.
   */
  create(sessionId: string, cwd: string, route?: ModelRoute): Promise<RunningAgent>
  /** Load a persisted session; undefined when it can no longer be loaded. */
  resume(sessionId: string): Promise<RunningAgent | undefined>
}

/** Something that can replace an image in a prompt with what it says. */
export interface PromptResolver {
  /** Whether reading is possible at all right now. */
  readonly available: boolean
  resolve(content: readonly PromptPart[]): Promise<PromptPart[]>
}

/** Construction options. */
export interface SessionRunnerOptions {
  readonly host: AgentHost
  readonly bindings: BindingStore
  /** Working directory new sessions start in. */
  readonly cwd: string
  /** Session id factory; injected so tests can assert on stable ids. */
  readonly newSessionId?: () => string
  /**
   * Reads an image with a vision model so the conversation receives text.
   *
   * This is what keeps a conversation on its own model: a provider inspects
   * the whole request history, so an image that reaches the conversation binds
   * it to a model that can see for as long as it lives.
   */
  readonly extractor?: PromptResolver
  /**
   * The model a conversation must move to when an image did reach it.
   *
   * Only the fallback: reached when there is no extractor, or when reading the
   * image failed and the picture itself had to go through. Read late so a
   * change in Settings applies to the next such turn.
   */
  readonly visionRoute?: () => ModelRoute | undefined
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
  async prompt(target: ChatTarget, content: readonly PromptPart[]): Promise<void> {
    if (content.length === 0) return

    // Resolved before the conversation's agent is touched at all, and outside
    // the serialisation: reading an image takes a model call, and holding the
    // conversation's queue for it would stall every later message behind it.
    const resolved = await this.resolve(content)
    if (resolved.length === 0) return

    await this.serialize(target, async () => {
      const agent = await this.agentFor(target)

      // Only reached when an image survived resolution. Set before the prompt:
      // the harness reads the selection while assembling each step, so the
      // override must be in place by the time the turn runs.
      agent.useModel(this.routeFor(target, resolved))

      // Recorded BEFORE the turn runs, because from this point the session's
      // log carries an image and every later turn must be routed for it.
      if (carriesImage(resolved)) await this.options.bindings.markImages(target)

      agent.followup(resolved)
    })
  }

  /**
   * Turn images into text, where there is anything able to do it.
   *
   * A failure here is not the turn's failure: the picture simply goes through
   * as it is, and the conversation moves to a model that can see it.
   */
  private async resolve(content: readonly PromptPart[]): Promise<PromptPart[]> {
    const extractor = this.options.extractor
    if (!extractor?.available || !carriesImage(content)) return [...content]

    try {
      return await extractor.resolve(content)
    } catch (error) {
      this.logger.warn('[dsh-telegram] could not read an image; sending it as it is', error)
      return [...content]
    }
  }

  /**
   * Which model this conversation's next step must run on.
   *
   * Not a per-turn choice, though it looks like one. A provider checks the
   * WHOLE request history for images, so once a session's log carries one,
   * every later turn — however plain its own text — fails on a model that
   * cannot see. The override therefore sticks to the conversation from the
   * first image until it is reset with `/new`.
   */
  private routeFor(target: ChatTarget, content: readonly PromptPart[]): ModelRoute | undefined {
    const carried = this.options.bindings.forChat(target)?.hasImages === true
    if (!carriesImage(content) && !carried) return undefined
    return this.options.visionRoute?.()
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
