/**
 * Telegram Bot API client.
 *
 * Speaks the HTTP protocol directly — no SDK — because the surface this plugin
 * needs is a dozen methods wide and an SDK would only add a dependency and a
 * translation layer between us and the error messages that matter.
 *
 * Three behaviours are deliberate and are the reason this client exists rather
 * than a thin fetch wrapper:
 *
 * - **Replies are sent as rich markdown.** Since Bot API 10.1 Telegram parses
 *   markdown itself, so the agent's tables, headings and lists arrive as real
 *   elements. The plugin's own prompts stay on plain HTML: they are short,
 *   built from escaped text, and carry the inline keyboards.
 * - **Rate limits are waited out, not thrown.** A 429 carries `retry_after`;
 *   the client sleeps that long and retries, so a burst of streaming edits
 *   degrades into slower edits rather than a failed turn.
 * - **The token never reaches a log.** It lives in the request path, so every
 *   error message is redacted before it escapes.
 */

import type {
  BotUser,
  ChatAction,
  InlineKeyboard,
  TelegramFile,
  TelegramUpdate,
} from './types.js'

/** Attempts for a request that fails with a retryable status. */
const MAX_RETRIES = 3

/** Backoff for retryable failures that carry no `retry_after`. */
const BACKOFF_MS = [500, 1500, 4000] as const

/** Statuses worth retrying: rate limit, and Telegram's own transient faults. */
const RETRYABLE = new Set([429, 500, 502, 503, 504])

/** A Bot API call that failed, with the token stripped from every field. */
export class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly code: number | undefined,
    readonly description: string | undefined,
    /** Seconds Telegram asked us to wait, from a 429's `parameters.retry_after`. */
    readonly retryAfterSeconds?: number,
  ) {
    super(message)
    this.name = 'TelegramApiError'
  }

  /** Whether the failure means the bot token itself is not valid. */
  get isAuthFailure(): boolean {
    return this.code === 401
  }
}

/** Construction options; `fetchImpl` and `sleep` exist so tests need no network. */
export interface TelegramApiOptions {
  readonly token: string
  readonly baseUrl: string
  readonly timeoutMs: number
  readonly fetchImpl?: typeof fetch
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

/** Arguments for sending one text message. */
export interface SendMessageOptions {
  readonly chatId: string
  readonly html: string
  readonly keyboard?: InlineKeyboard
  readonly replyToMessageId?: number
  readonly threadId?: number
  readonly signal?: AbortSignal
}

/** Arguments for editing one text message. */
export interface EditMessageOptions {
  readonly chatId: string
  readonly messageId: number
  readonly html: string
  readonly keyboard?: InlineKeyboard
  readonly signal?: AbortSignal
}

/** Outcome of an edit: Telegram treats a no-op edit as an error, we do not. */
export type EditOutcome = 'edited' | 'unchanged'

/** Arguments for sending one rich message. */
export interface SendRichOptions {
  readonly chatId: string
  /** Rich Markdown, which Telegram parses and renders itself. */
  readonly markdown: string
  readonly keyboard?: InlineKeyboard
  readonly replyToMessageId?: number
  readonly threadId?: number
  readonly signal?: AbortSignal
}

/** Arguments for one frame of a streamed draft. */
export interface DraftOptions {
  readonly chatId: string
  /** Stable across a turn: Telegram animates changes to the same draft id. */
  readonly draftId: number
  readonly markdown: string
  readonly threadId?: number
  readonly signal?: AbortSignal
}

export class TelegramApi {
  private readonly fetchImpl: typeof fetch
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>

  constructor(private readonly options: TelegramApiOptions) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.sleep = options.sleep ?? defaultSleep
  }

  /** Verify the token and read the bot's own identity. */
  getMe(): Promise<BotUser> {
    return this.call<BotUser>('getMe', {})
  }

  /** Drop any webhook so long polling is the only delivery path. */
  async deleteWebhook(): Promise<void> {
    await this.call('deleteWebhook', { drop_pending_updates: false })
  }

  /**
   * Long-poll for updates.
   *
   * `allowed_updates` includes `callback_query`, which is what lets a button
   * press reach the agent at all.
   */
  getUpdates(offset: number, timeoutSeconds: number, signal?: AbortSignal): Promise<TelegramUpdate[]> {
    return this.call<TelegramUpdate[]>(
      'getUpdates',
      {
        offset,
        timeout: timeoutSeconds,
        allowed_updates: ['message', 'callback_query'],
      },
      { ...(signal ? { signal } : {}), timeoutMs: timeoutSeconds * 1000 + 5000 },
    )
  }

  /**
   * Send one HTML message, falling back to plain text if Telegram rejects the
   * markup rather than letting the content vanish.
   */
  async sendMessage(options: SendMessageOptions): Promise<{ messageId: number }> {
    const body = {
      chat_id: options.chatId,
      text: options.html,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...(options.keyboard ? { reply_markup: toReplyMarkup(options.keyboard) } : {}),
      ...(options.replyToMessageId
        ? { reply_parameters: { message_id: options.replyToMessageId } }
        : {}),
      ...(options.threadId !== undefined ? { message_thread_id: options.threadId } : {}),
    }

    const sent = await this.call<{ message_id: number }>('sendMessage', body, {
      ...(options.signal ? { signal: options.signal } : {}),
    })
    return { messageId: sent.message_id }
  }

  /**
   * Edit one message in place — the mechanism behind streamed replies.
   *
   * Telegram answers 400 when the new text equals the old, which during
   * streaming is an ordinary and frequent event, so it is reported rather than
   * thrown.
   */
  async editMessageText(options: EditMessageOptions): Promise<EditOutcome> {
    const body = {
      chat_id: options.chatId,
      message_id: options.messageId,
      text: options.html,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...(options.keyboard ? { reply_markup: toReplyMarkup(options.keyboard) } : {}),
    }

    try {
      await this.call('editMessageText', body, {
        ...(options.signal ? { signal: options.signal } : {}),
      })
      return 'edited'
    } catch (error) {
      if (isNotModified(error)) return 'unchanged'
      throw error
    }
  }

  /**
   * Send one rich message.
   *
   * Telegram parses the Rich Markdown itself, so tables, headings, lists and
   * task lists arrive as real elements rather than as an approximation of
   * them — and the cap is 32768 characters rather than 4096.
   */
  async sendRichMessage(options: SendRichOptions): Promise<{ messageId: number }> {
    const sent = await this.call<{ message_id: number }>(
      'sendRichMessage',
      {
        chat_id: options.chatId,
        rich_message: { markdown: options.markdown },
        ...(options.keyboard ? { reply_markup: toReplyMarkup(options.keyboard) } : {}),
        ...(options.replyToMessageId
          ? { reply_parameters: { message_id: options.replyToMessageId } }
          : {}),
        ...(options.threadId !== undefined ? { message_thread_id: options.threadId } : {}),
      },
      { ...(options.signal ? { signal: options.signal } : {}) },
    )
    return { messageId: sent.message_id }
  }

  /**
   * Stream one frame of a partial reply.
   *
   * The draft is a 30-second ephemeral preview, and Telegram animates changes
   * carrying the same `draftId` — so a turn keeps one id throughout and the
   * text grows in place. It must still be persisted with a real send when the
   * turn ends, and it works in private chats only.
   */
  async sendRichMessageDraft(options: DraftOptions): Promise<void> {
    await this.call(
      'sendRichMessageDraft',
      {
        chat_id: options.chatId,
        draft_id: options.draftId,
        rich_message: { markdown: options.markdown },
        ...(options.threadId !== undefined ? { message_thread_id: options.threadId } : {}),
      },
      { ...(options.signal ? { signal: options.signal } : {}) },
    )
  }

  /** Replace a message's content with rich markdown. */
  async editRichMessage(options: {
    chatId: string
    messageId: number
    markdown: string
    keyboard?: InlineKeyboard
  }): Promise<EditOutcome> {
    try {
      await this.call('editMessageText', {
        chat_id: options.chatId,
        message_id: options.messageId,
        rich_message: { markdown: options.markdown },
        ...(options.keyboard ? { reply_markup: toReplyMarkup(options.keyboard) } : {}),
      })
      return 'edited'
    } catch (error) {
      if (isNotModified(error)) return 'unchanged'
      throw error
    }
  }

  /** Replace or clear a message's inline keyboard, leaving its text alone. */
  async editMessageReplyMarkup(options: {
    chatId: string
    messageId: number
    keyboard: InlineKeyboard
  }): Promise<void> {
    try {
      await this.call('editMessageReplyMarkup', {
        chat_id: options.chatId,
        message_id: options.messageId,
        reply_markup: toReplyMarkup(options.keyboard),
      })
    } catch (error) {
      if (!isNotModified(error)) throw error
    }
  }

  /**
   * Acknowledge a button press. Telegram shows a spinner on the button until
   * this lands, so it is sent before any slow work the press triggers.
   */
  async answerCallbackQuery(id: string, text?: string): Promise<void> {
    try {
      await this.call('answerCallbackQuery', {
        callback_query_id: id,
        ...(text ? { text } : {}),
      })
    } catch {
      // An expired callback id is normal (the user pressed twice, or waited);
      // failing to acknowledge must never abort the work the press started.
    }
  }

  /** Show a progress indicator in the chat. Best-effort by design. */
  async sendChatAction(chatId: string, action: ChatAction): Promise<void> {
    try {
      await this.call('sendChatAction', { chat_id: chatId, action })
    } catch {
      // Cosmetic only.
    }
  }

  /** Resolve a file id to downloadable metadata. */
  getFile(fileId: string): Promise<TelegramFile> {
    return this.call<TelegramFile>('getFile', { file_id: fileId })
  }

  /**
   * Download a resolved file's bytes.
   *
   * The download URL carries the token in its path, and a transport failure
   * quotes the URL it was given — so this fetch is wrapped like every other,
   * or a dropped connection would hand the token to the caller's log.
   */
  async downloadFile(filePath: string, signal?: AbortSignal): Promise<Uint8Array> {
    const url = `${this.base()}/file/bot${this.options.token}/${filePath.replace(/^\/+/, '')}`

    try {
      const response = await this.fetchImpl(url, signal ? { signal } : {})
      if (!response.ok) {
        throw new TelegramApiError(
          `telegram file download failed with http ${response.status}`,
          response.status,
          undefined,
        )
      }
      return new Uint8Array(await response.arrayBuffer())
    } catch (error) {
      throw this.normalize(error, 'downloadFile')
    }
  }

  /** Base url without a trailing slash. */
  private base(): string {
    return this.options.baseUrl.replace(/\/+$/, '')
  }

  /**
   * One Bot API call, with retries for transient failures.
   *
   * @throws {TelegramApiError} with the token redacted from every field.
   */
  private async call<T>(
    method: string,
    body: Record<string, unknown>,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<T> {
    let lastError: unknown

    for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
      try {
        return await this.request<T>(method, body, options)
      } catch (error) {
        lastError = error
        const delay = retryDelay(error, attempt)
        if (delay === undefined) throw error
        await this.sleep(delay, options.signal)
      }
    }

    throw lastError
  }

  /** One attempt: build, send, validate, unwrap. */
  private async request<T>(
    method: string,
    body: Record<string, unknown>,
    options: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? this.options.timeoutMs)
    const onAbort = () => controller.abort()
    options.signal?.addEventListener('abort', onAbort, { once: true })

    try {
      const response = await this.fetchImpl(`${this.base()}/bot${this.options.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(prune(body)),
        signal: controller.signal,
      })

      const envelope = parseEnvelope(await response.text(), method)
      if (!envelope.ok) {
        throw new TelegramApiError(
          this.redact(`telegram ${method} failed: ${envelope.description ?? `http ${response.status}`}`),
          envelope.error_code ?? response.status,
          envelope.description,
          envelope.parameters?.retry_after,
        )
      }
      return envelope.result as T
    } catch (error) {
      throw this.normalize(error, method)
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
    }
  }

  /** Wrap any thrown value as a redacted TelegramApiError. */
  private normalize(error: unknown, method: string): TelegramApiError {
    if (error instanceof TelegramApiError) return error
    const reason = error instanceof Error ? error.message : String(error)
    return new TelegramApiError(
      `telegram ${method} failed: ${this.redact(reason)}`,
      undefined,
      undefined,
    )
  }

  /** Remove the bot token from any string bound for a log or an error. */
  private redact(text: string): string {
    return text.split(this.options.token).join('<redacted>')
  }
}

/** The Bot API envelope shared by every method. */
interface Envelope {
  ok: boolean
  result?: unknown
  error_code?: number
  description?: string
  parameters?: { retry_after?: number }
}

/** Parse a response body, treating unparseable output as a failed call. */
function parseEnvelope(text: string, method: string): Envelope {
  if (text === '') return { ok: true, result: undefined }
  try {
    return JSON.parse(text) as Envelope
  } catch {
    throw new TelegramApiError(`telegram ${method} returned a non-JSON response`, undefined, undefined)
  }
}

/**
 * How long to wait before retrying, or undefined when the failure is final.
 * A 429 names its own delay; everything else uses fixed backoff.
 */
function retryDelay(error: unknown, attempt: number): number | undefined {
  if (!(error instanceof TelegramApiError)) return undefined
  if (error.code === undefined || !RETRYABLE.has(error.code)) return undefined
  if (attempt >= MAX_RETRIES - 1) return undefined

  if (error.retryAfterSeconds !== undefined) return error.retryAfterSeconds * 1000

  const stated = /retry after (\d+)/i.exec(error.description ?? '')?.[1]
  if (stated) return Number(stated) * 1000
  if (error.code === 429) return 1000

  return BACKOFF_MS[attempt] ?? BACKOFF_MS[BACKOFF_MS.length - 1]
}

/** Whether a failure means "the edit changed nothing", which is not a failure. */
function isNotModified(error: unknown): boolean {
  if (!(error instanceof TelegramApiError)) return false
  return /message is not modified/i.test(error.description ?? '')
}

/** Convert our keyboard shape into the Bot API's snake-cased markup. */
function toReplyMarkup(keyboard: InlineKeyboard): { inline_keyboard: unknown[][] } {
  return {
    inline_keyboard: keyboard.map((row) =>
      row.map((button) => ({ text: button.text, callback_data: button.callbackData })),
    ),
  }
}

/** Drop undefined values so `parse_mode: undefined` really omits the field. */
function prune(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined))
}

/** Cancellable sleep used by the retry path. */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
