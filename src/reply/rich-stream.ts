/**
 * Streaming one agent turn as a rich message.
 *
 * The agent writes markdown, and since Bot API 10.1 Telegram parses markdown
 * itself — tables, headings, ordered and task lists, fenced code, footnotes,
 * math — so the reply is forwarded almost verbatim rather than approximated
 * in HTML. The message cap rises from 4096 to 32768 characters with it.
 *
 * Telegram offers two ways to show a reply as it is written, and they are not
 * interchangeable:
 *
 * - **Private chats** get `sendRichMessageDraft`: an ephemeral preview that
 *   animates between frames carrying the same draft id. It expires after 30
 *   seconds and is never persisted, so the turn must end with a real send.
 * - **Groups have no draft API at all.** There, a placeholder is posted at
 *   once and replaced with the finished reply, so the room still sees that the
 *   bot is working without a mechanism that does not exist for it.
 *
 * The expiry is the subtle part: a turn that spends two minutes in a tool call
 * emits no text, so without a heartbeat the preview would vanish and the user
 * would think the bot had died.
 */

import type { ChatTarget } from '../interact/surface.js'
import type { Logger } from '../harness/types.js'
import { SILENT_LOGGER } from '../harness/types.js'

import { splitMarkdown } from './split-markdown.js'

/** Telegram's rich-message character cap. */
export const RICH_MESSAGE_LIMIT = 32_768

/** Default gap between frames; Telegram throttles rapid updates to one chat. */
export const DEFAULT_THROTTLE_MS = 1200

/**
 * How often to re-send an unchanged draft.
 *
 * Comfortably inside the 30-second expiry, so a long silent tool call cannot
 * let the preview lapse.
 */
const HEARTBEAT_MS = 20_000

/** The Bot API surface a reply needs. */
export interface RichChat {
  sendRichMessage(options: {
    chatId: string
    markdown: string
    threadId?: number
  }): Promise<{ messageId: number }>
  sendRichMessageDraft(options: {
    chatId: string
    draftId: number
    markdown: string
    threadId?: number
  }): Promise<void>
  sendMessage(options: { chatId: string; html: string; threadId?: number }): Promise<{ messageId: number }>
  editRichMessage(options: {
    chatId: string
    messageId: number
    markdown: string
  }): Promise<unknown>
}

/** Construction options. */
export interface RichReplyOptions {
  readonly chat: RichChat
  readonly target: ChatTarget
  /** Private chats stream through drafts; groups have no draft API. */
  readonly canDraft: boolean
  /** Stable for the turn: Telegram animates frames sharing a draft id. */
  readonly draftId: number
  readonly throttleMs?: number
  readonly limit?: number
  readonly placeholder?: string
  readonly logger?: Logger
  /** Injected so a test never waits on a real timer. */
  readonly heartbeatMs?: number
}

export class RichReplyStream {
  private readonly chat: RichChat
  private readonly target: ChatTarget
  private readonly throttleMs: number
  private readonly limit: number
  private readonly placeholder: string
  private readonly heartbeatMs: number
  private readonly logger: Logger

  /** Raw markdown received so far. */
  private buffer = ''
  /** What the last frame showed, so an unchanged frame is skipped. */
  private shown = ''
  /** The group placeholder awaiting its finished reply. */
  private placeholderId: number | undefined

  private started = false
  private finished = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private heartbeat: ReturnType<typeof setInterval> | undefined
  private lastFrame = 0
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly options: RichReplyOptions) {
    this.chat = options.chat
    this.target = options.target
    this.throttleMs = options.throttleMs ?? DEFAULT_THROTTLE_MS
    this.limit = options.limit ?? RICH_MESSAGE_LIMIT
    this.placeholder = options.placeholder ?? '…'
    this.heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS
    this.logger = options.logger ?? SILENT_LOGGER
  }

  /** Show that the agent is working, by whichever mechanism this chat has. */
  async start(): Promise<void> {
    if (this.started) return
    this.started = true

    await this.enqueue(async () => {
      if (this.options.canDraft) {
        await this.draft(this.placeholder)
        this.armHeartbeat()
        return
      }

      // No draft API in a group: a real message stands in until the reply
      // replaces it, so the room is not left waiting on silence.
      const sent = await this.chat.sendMessage({
        chatId: this.target.chatId,
        html: this.placeholder,
        ...(this.target.threadId !== undefined ? { threadId: this.target.threadId } : {}),
      })
      this.placeholderId = sent.messageId
    })
  }

  /**
   * Add streamed markdown.
   *
   * @param delta - the new fragment.
   */
  async append(delta: string): Promise<void> {
    if (this.finished || delta === '') return
    if (!this.started) await this.start()
    this.buffer += delta

    // Only a draft can show progress; a group waits for the finished reply.
    if (this.options.canDraft) await this.schedule()
  }

  /**
   * Close the turn, persisting the reply.
   *
   * @param finalText - authoritative full text when the caller has one.
   */
  async finish(finalText?: string): Promise<void> {
    if (this.finished) return
    if (finalText !== undefined) this.buffer = finalText
    if (!this.started && this.buffer === '') return
    if (!this.started) await this.start()

    this.finished = true
    this.stopTimers()
    await this.enqueue(() => this.persist(this.buffer))
  }

  /**
   * Close the turn on an error, keeping whatever text had already streamed.
   *
   * @param error - the failure to show under the partial answer.
   */
  async fail(error: unknown): Promise<void> {
    if (this.finished) return
    this.finished = true
    this.stopTimers()

    const reason = error instanceof Error ? error.message : String(error)
    const body = this.buffer === '' ? '' : `${this.buffer}\n\n`
    await this.enqueue(() => this.persist(`${body}⚠️ ${reason}`))
  }

  /** Write the finished reply where it will survive the draft's expiry. */
  private async persist(markdown: string): Promise<void> {
    const chunks = splitMarkdown(markdown, this.limit)
    if (chunks.length === 0) return

    const [first, ...rest] = chunks as [string, ...string[]]

    if (this.placeholderId !== undefined) {
      await this.chat.editRichMessage({
        chatId: this.target.chatId,
        messageId: this.placeholderId,
        markdown: first,
      })
    } else {
      await this.send(first)
    }

    for (const chunk of rest) await this.send(chunk)
  }

  /** Post one finished chunk. */
  private async send(markdown: string): Promise<void> {
    await this.chat.sendRichMessage({
      chatId: this.target.chatId,
      markdown,
      ...(this.target.threadId !== undefined ? { threadId: this.target.threadId } : {}),
    })
  }

  /** Show one draft frame, remembering it so the heartbeat can repeat it. */
  private async draft(markdown: string): Promise<void> {
    // A draft cannot exceed the message cap either; the tail is what the user
    // is watching, and the whole text lands when the turn is persisted.
    const frame = markdown.length > this.limit ? markdown.slice(-this.limit) : markdown

    await this.chat.sendRichMessageDraft({
      chatId: this.target.chatId,
      draftId: this.options.draftId,
      markdown: frame,
      ...(this.target.threadId !== undefined ? { threadId: this.target.threadId } : {}),
    })
    this.shown = frame
  }

  /** Flush now, or arm a timer for the rest of the throttle window. */
  private async schedule(): Promise<void> {
    if (this.throttleMs === 0) return await this.enqueue(() => this.frame())

    const due = this.lastFrame + this.throttleMs - Date.now()
    if (due <= 0) {
      this.lastFrame = Date.now()
      return await this.enqueue(() => this.frame())
    }

    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.lastFrame = Date.now()
      void this.enqueue(() => this.frame())
    }, due)
  }

  /** Send the current buffer as a draft frame, if it moved. */
  private async frame(): Promise<void> {
    if (this.finished || this.buffer === '' || this.buffer === this.shown) return
    await this.draft(this.buffer)
  }

  /**
   * Keep the preview alive through a silent stretch.
   *
   * A draft lapses 30 seconds after its last frame, and a turn can spend far
   * longer inside one tool call without emitting a character.
   */
  private armHeartbeat(): void {
    if (this.heartbeat || this.heartbeatMs <= 0) return
    this.heartbeat = setInterval(() => {
      if (this.finished) return
      void this.enqueue(() => this.draft(this.buffer === '' ? this.placeholder : this.shown))
    }, this.heartbeatMs)
  }

  /** Run one send after the previous one, containing its failures. */
  private enqueue(task: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(task).catch((error: unknown) => {
      this.logger.warn('[dsh-telegram] reply delivery failed', error)
    })
    return this.queue
  }

  /** Disarm the throttle and the heartbeat. */
  private stopTimers(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = undefined
  }
}
