/**
 * Turning the harness's session-event feed into a live Telegram reply.
 *
 * The harness publishes a durable log — `turn/start`, a run of
 * `assistant/chunk` deltas, `assistant/message`, `turn/end` — and every
 * consumer reads the same feed. This bridge subscribes for Telegram-bound
 * sessions only and drives one {@link ReplyStream} per open turn.
 *
 * Only visible model text is forwarded. Reasoning deltas and tool-call deltas
 * stay out of the chat: the first is the model thinking aloud, the second is
 * an argument fragment, and neither is an answer to the person waiting.
 *
 * `assistant/message` is treated as authoritative over the accumulated deltas.
 * A turn cancelled mid-stream still emits it with `interrupted: true`, and it
 * is the only place the finished text is guaranteed complete.
 */

import type { ChatTarget } from '../interact/surface.js'
import type { ChatSurface } from '../interact/surface.js'
import type { Logger } from '../harness/types.js'
import { SILENT_LOGGER } from '../harness/types.js'

import { ReplyStream } from './streamer.js'

/** The session-event shapes this bridge reads. */
export type SessionEvent =
  | { readonly type: 'turn/start'; readonly data: { readonly turn: number } }
  | {
      readonly type: 'assistant/chunk'
      readonly data: {
        readonly turn: number
        readonly chunk: { readonly type: string; readonly text?: string }
      }
    }
  | {
      readonly type: 'assistant/message'
      readonly data: {
        readonly turn: number
        readonly message: { readonly content?: readonly { type: string; text?: string }[] }
      }
    }
  | { readonly type: 'turn/end'; readonly data: { readonly turn: number } }
  | { readonly type: string; readonly data?: unknown }

/** Construction options. */
export interface TurnBridgeOptions {
  readonly surface: ChatSurface
  /** Resolve a session id to its chat, or undefined when it is not a Telegram one. */
  readonly targetOf: (sessionId: string) => ChatTarget | undefined
  readonly throttleMs?: number
  readonly placeholder?: string
  readonly logger?: Logger
}

/** One turn being streamed. */
interface ActiveTurn {
  readonly turn: number
  readonly stream: ReplyStream
  /** Authoritative text from `assistant/message`, when it has arrived. */
  finalText?: string
}

export class TurnBridge {
  private readonly active = new Map<string, ActiveTurn>()
  private readonly logger: Logger

  constructor(private readonly options: TurnBridgeOptions) {
    this.logger = options.logger ?? SILENT_LOGGER
  }

  /**
   * Consume one session event.
   *
   * @param sessionId - the session the event belongs to.
   * @param event - the event from the harness feed.
   */
  async handle(sessionId: string, event: SessionEvent): Promise<void> {
    try {
      switch (event.type) {
        case 'turn/start':
          return await this.onTurnStart(sessionId, event as { data: { turn: number } })
        case 'assistant/chunk':
          return await this.onChunk(sessionId, event as never)
        case 'assistant/message':
          return this.onMessage(sessionId, event as never)
        case 'turn/end':
          return await this.onTurnEnd(sessionId, event as { data: { turn: number } })
        default:
          return
      }
    } catch (error) {
      this.logger.warn('[dsh-telegram] failed to stream a turn', error)
    }
  }

  /** Whether a turn is currently streaming for a session. */
  isStreaming(sessionId: string): boolean {
    return this.active.has(sessionId)
  }

  /** Close every open stream — the plugin is unloading mid-turn. */
  async dispose(): Promise<void> {
    const streams = [...this.active.values()]
    this.active.clear()
    await Promise.all(streams.map((entry) => entry.stream.finish().catch(() => undefined)))
  }

  /** Open a reply for a turn in a Telegram-bound session. */
  private async onTurnStart(sessionId: string, event: { data: { turn: number } }): Promise<void> {
    const target = this.options.targetOf(sessionId)
    if (!target) return

    // A previous turn that never closed would otherwise leak its stream.
    await this.closeActive(sessionId)

    const stream = new ReplyStream({
      surface: this.options.surface,
      target,
      ...(this.options.throttleMs !== undefined ? { throttleMs: this.options.throttleMs } : {}),
      ...(this.options.placeholder !== undefined ? { placeholder: this.options.placeholder } : {}),
      logger: this.logger,
    })

    this.active.set(sessionId, { turn: event.data.turn, stream })
    await stream.start()
  }

  /** Forward one visible text delta. */
  private async onChunk(
    sessionId: string,
    event: { data: { turn: number; chunk: { type: string; text?: string } } },
  ): Promise<void> {
    const entry = this.active.get(sessionId)
    if (!entry || entry.turn !== event.data.turn) return
    if (event.data.chunk.type !== 'text-delta') return

    await entry.stream.append(event.data.chunk.text ?? '')
  }

  /** Record the authoritative text for the turn. */
  private onMessage(
    sessionId: string,
    event: { data: { turn: number; message: { content?: readonly { type: string; text?: string }[] } } },
  ): void {
    const entry = this.active.get(sessionId)
    if (!entry || entry.turn !== event.data.turn) return

    const text = (event.data.message.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('')

    if (text !== '') entry.finalText = text
  }

  /** Deliver the finished reply. */
  private async onTurnEnd(sessionId: string, event: { data: { turn: number } }): Promise<void> {
    const entry = this.active.get(sessionId)
    if (!entry || entry.turn !== event.data.turn) return

    this.active.delete(sessionId)
    await entry.stream.finish(entry.finalText)
  }

  /** Finish a stream left open by a turn that never ended. */
  private async closeActive(sessionId: string): Promise<void> {
    const entry = this.active.get(sessionId)
    if (!entry) return

    this.active.delete(sessionId)
    await entry.stream.finish(entry.finalText).catch(() => undefined)
  }
}
