/**
 * Streaming one agent turn into a Telegram conversation.
 *
 * The agent produces markdown a token at a time; Telegram accepts whole
 * messages and rate-limits edits. This class sits between them: it accumulates
 * the raw markdown, re-renders it on a throttle, and edits the message in
 * place so the user watches the answer appear.
 *
 * Re-rendering the WHOLE buffer on every flush — rather than appending the new
 * delta — is what makes markdown work while streaming. A delta can arrive
 * mid-construct (`**bo` … `ld**`), and only the complete prefix knows whether
 * that is emphasis yet. The renderer closes whatever is still open, so every
 * intermediate frame is valid HTML.
 *
 * When the answer outgrows one message the stream spills into further
 * messages. Split points are stable because the splitter only looks ahead
 * within one message's budget, so an earlier message is never rewritten once
 * the text has moved past it.
 */

import { renderMarkdown } from '../render/markdown.js'
import { splitHtml } from '../render/split.js'
import type { ChatSurface, ChatTarget } from '../interact/surface.js'
import type { Logger } from '../harness/types.js'
import { SILENT_LOGGER } from '../harness/types.js'

/** Telegram's per-message character cap. */
export const TELEGRAM_MESSAGE_LIMIT = 4096

/** Default gap between edits; Telegram throttles rapid edits to one chat. */
export const DEFAULT_THROTTLE_MS = 1200

/** Construction options. */
export interface ReplyStreamOptions {
  readonly surface: ChatSurface
  readonly target: ChatTarget
  /** Minimum gap between edits. 0 flushes synchronously, which tests rely on. */
  readonly throttleMs?: number
  /** Per-message character cap. */
  readonly limit?: number
  /** First thing the user sees, before any tokens arrive. */
  readonly placeholder?: string
  readonly logger?: Logger
}

export class ReplyStream {
  private readonly surface: ChatSurface
  private readonly target: ChatTarget
  private readonly throttleMs: number
  private readonly limit: number
  private readonly placeholder: string
  private readonly logger: Logger

  /** Raw markdown received so far. */
  private buffer = ''
  /** Message ids in order, one per chunk of the rendered reply. */
  private readonly messageIds: number[] = []
  /** What each message currently displays, so an unchanged edit is skipped. */
  private readonly displayed: string[] = []

  private started = false
  private finished = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private lastFlush = 0
  /** Serialises flushes so two never interleave their sends. */
  private queue: Promise<void> = Promise.resolve()

  constructor(options: ReplyStreamOptions) {
    this.surface = options.surface
    this.target = options.target
    this.throttleMs = options.throttleMs ?? DEFAULT_THROTTLE_MS
    this.limit = options.limit ?? TELEGRAM_MESSAGE_LIMIT
    this.placeholder = options.placeholder ?? '…'
    this.logger = options.logger ?? SILENT_LOGGER
  }

  /** Post the placeholder so the chat shows the agent is working. */
  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    await this.enqueue(async () => {
      const id = await this.surface.send(this.target, this.placeholder)
      this.messageIds.push(id)
      this.displayed.push(this.placeholder)
    })
  }

  /**
   * Add streamed text.
   *
   * @param delta - the new fragment of markdown.
   */
  async append(delta: string): Promise<void> {
    if (this.finished || delta === '') return
    if (!this.started) await this.start()
    this.buffer += delta
    await this.schedule()
  }

  /**
   * Close the stream, delivering everything pending regardless of throttle.
   *
   * @param finalText - authoritative full text, when the caller has one; the
   *   accumulated buffer may be missing deltas still inside the throttle window.
   */
  async finish(finalText?: string): Promise<void> {
    if (this.finished) return
    if (finalText !== undefined) this.buffer = finalText
    if (!this.started && this.buffer === '') return
    if (!this.started) await this.start()

    this.finished = true
    this.clearTimer()
    await this.enqueue(() => this.render(this.buffer))
  }

  /**
   * Close the stream on an error, keeping whatever text had already streamed.
   *
   * @param error - the failure to show under the partial answer.
   */
  async fail(error: unknown): Promise<void> {
    if (this.finished) return
    this.finished = true
    this.clearTimer()

    const reason = error instanceof Error ? error.message : String(error)
    const body = this.buffer === '' ? '' : `${this.buffer}\n\n`
    await this.enqueue(() => this.render(`${body}⚠️ ${reason}`))
  }

  /** Flush now, or arm a timer for the remainder of the throttle window. */
  private async schedule(): Promise<void> {
    if (this.throttleMs === 0) {
      await this.enqueue(() => this.render(this.buffer))
      return
    }

    const due = this.lastFlush + this.throttleMs - Date.now()
    if (due <= 0) {
      this.lastFlush = Date.now()
      await this.enqueue(() => this.render(this.buffer))
      return
    }

    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.lastFlush = Date.now()
      void this.enqueue(() => this.render(this.buffer))
    }, due)
  }

  /**
   * Render the whole buffer and reconcile it against the messages on screen:
   * edit what changed, send what is new, leave the rest alone.
   */
  private async render(markdown: string): Promise<void> {
    const chunks = splitHtml(renderMarkdown(markdown), this.limit)
    if (chunks.length === 0) return

    for (const [index, chunk] of chunks.entries()) {
      if (this.displayed[index] === chunk) continue

      const messageId = this.messageIds[index]
      if (messageId === undefined) {
        const id = await this.surface.send(this.target, chunk)
        this.messageIds[index] = id
      } else {
        await this.surface.edit(this.target, messageId, chunk)
      }
      this.displayed[index] = chunk
    }
  }

  /**
   * Run one send/edit batch after the previous one, containing its failures.
   * A Telegram outage must degrade the reply, never break the agent's turn.
   */
  private enqueue(task: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(task).catch((error: unknown) => {
      this.logger.warn('[dsh-telegram] reply delivery failed', error)
    })
    return this.queue
  }

  /** Disarm a pending flush. */
  private clearTimer(): void {
    if (!this.timer) return
    clearTimeout(this.timer)
    this.timer = undefined
  }
}
