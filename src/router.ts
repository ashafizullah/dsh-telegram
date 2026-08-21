/**
 * Routing one incoming Telegram update.
 *
 * Every update arrives here and leaves as exactly one of: a refusal, a
 * command, an answer to a pending prompt, a button press, or a prompt for the
 * agent. The order those are tried in is the whole design:
 *
 * 1. **Access first.** Nothing else runs for a user who is not allowed, so no
 *    unauthorised text ever reaches the agent, not even as a command.
 * 2. **Pending prompts before commands.** If a question is waiting for typed
 *    input, that is what the user is answering — routing it to the agent as a
 *    new prompt would strand the question forever.
 * 3. **Commands before prompts.** Otherwise `/new` would be a message asking
 *    the agent about the word "new".
 *
 * Failures are reported into the chat rather than thrown: an update handler
 * that throws would abort the long-poll loop and take the bot offline.
 */

import { COMMANDS, helpText, parseCommand } from './commands.js'
import { escapeHtml } from './render/escape.js'
import type { AccessPolicy } from './access.js'
import type { ChatTarget } from './interact/surface.js'
import type { TextCapture } from './interact/text-capture.js'
import type { Logger } from './harness/types.js'
import { SILENT_LOGGER } from './harness/types.js'
import type { MediaCollector, PromptPart } from './media/collect.js'
import type { TelegramMessage, TelegramUpdate } from './telegram/types.js'

/** What the router needs to drive a conversation's agent. */
export interface AgentRunner {
  /** Deliver a prompt, starting or resuming the chat's session as needed. */
  prompt(target: ChatTarget, content: readonly PromptPart[]): Promise<void>
  /** Forget the current session so the next prompt opens a fresh one. */
  reset(target: ChatTarget): Promise<void>
  /** Cancel the in-flight turn; resolves to whether anything was running. */
  stop(target: ChatTarget): Promise<boolean>
  /** A short human-readable status line for this conversation. */
  status(target: ChatTarget): Promise<string>
}

/** The bits of the Bot API the router itself uses. */
export interface RouterChat {
  sendMessage(options: { chatId: string; html: string; threadId?: number }): Promise<unknown>
  answerCallbackQuery(id: string, text?: string): Promise<void>
  /**
   * Show that something is happening. Reading an attachment can take a while —
   * a large file, a retried download — and Telegram gives no other sign, so
   * without this the chat sits silent and the bot looks stuck.
   */
  sendChatAction?(chatId: string, action: 'typing' | 'upload_document' | 'upload_photo'): Promise<void>
}

/** Routes callback data to whichever feature owns it. */
export interface CallbackHandler {
  handleCallback(data: string | undefined): boolean
}

/** Construction options. */
export interface UpdateRouterOptions {
  readonly chat: RouterChat
  readonly access: AccessPolicy
  readonly questions: CallbackHandler
  readonly approvals: CallbackHandler
  /** Owns the button that starts a fresh conversation after a stuck turn. */
  readonly recovery?: CallbackHandler
  readonly textCapture: TextCapture
  readonly runner: AgentRunner
  /**
   * Turns a message's attachments into prompt content. Absent leaves the bot
   * text-only, which is what it was before media was wired up.
   */
  readonly media?: MediaCollector
  /** This bot's username, so `/cmd@other_bot` is left alone in groups. */
  readonly botUsername?: string
  /**
   * Strips secrets from anything posted back into a chat. Agent failures are
   * reported to the user verbatim, and an error raised deep in a provider can
   * quote a credential it was given.
   */
  readonly redact?: (text: string) => string
  readonly logger?: Logger
}

export class UpdateRouter {
  private readonly logger: Logger

  constructor(private readonly options: UpdateRouterOptions) {
    this.logger = options.logger ?? SILENT_LOGGER
  }

  /**
   * Handle one update. Never throws: a thrown handler would stop the poll loop.
   *
   * @param update - one raw update from `getUpdates`.
   */
  async handle(update: TelegramUpdate): Promise<void> {
    try {
      if (update.callback_query) return await this.onCallback(update.callback_query)
      const message = update.message ?? update.edited_message
      if (message) return await this.onMessage(message)
    } catch (error) {
      this.logger.error('[dsh-telegram] update handling failed', error)
    }
  }

  /** A button press: acknowledge first, then route it. */
  private async onCallback(query: NonNullable<TelegramUpdate['callback_query']>): Promise<void> {
    // Telegram spins the button until this lands, so acknowledge before any
    // slow work the press unblocks.
    await this.options.chat.answerCallbackQuery(query.id)

    if (this.options.access.check(query.from.id) !== 'allowed') return

    const routed =
      this.options.questions.handleCallback(query.data) ||
      this.options.approvals.handleCallback(query.data) ||
      (this.options.recovery?.handleCallback(query.data) ?? false)

    if (!routed) {
      this.logger.debug('[dsh-telegram] ignoring a stale or unknown button press')
    }
  }

  /** An incoming message: access, pending prompt, command, then prompt. */
  private async onMessage(message: TelegramMessage): Promise<void> {
    const target = targetOf(message)
    const userId = message.from?.id
    if (userId === undefined) return

    const text = message.text ?? message.caption
    const decision = this.options.access.check(userId)

    if (decision !== 'allowed') return await this.onUnauthorized(target, userId, text, decision)

    const carriesMedia = hasMedia(message)

    // A waiting question wants typed words, and a command is never a file, so
    // both checks look at plain text only.
    if (text !== undefined && !carriesMedia) {
      if (this.options.textCapture.deliver(target, text)) return

      const command = parseCommand(text, this.options.botUsername)
      if (command) return await this.onCommand(target, userId, command.name, command.args)
    }

    if (!carriesMedia) {
      if (text === undefined) {
        return await this.say(target, 'I can read text, images, and text files.')
      }
      return await this.runPrompt(target, [{ type: 'text', text }])
    }

    if (!this.options.media) {
      return await this.say(target, 'This bot is not set up to read attachments.')
    }

    // Reading can take seconds, or longer if a download has to be retried.
    void this.options.chat.sendChatAction?.(target.chatId, 'typing')

    const collected = await this.options.media.collect(message, text)
    // Said first: the user should not have to wait for a reply to learn that
    // what they attached went nowhere.
    if (collected.notice) await this.say(target, escapeHtml(collected.notice))
    await this.runPrompt(target, collected.parts)
  }

  /**
   * A user who may not drive the agent. An unclaimed bot still accepts
   * `/claim`, because that is the only way it ever becomes usable.
   */
  private async onUnauthorized(
    target: ChatTarget,
    userId: number,
    text: string | undefined,
    decision: 'denied' | 'unclaimed',
  ): Promise<void> {
    const command = text === undefined ? undefined : parseCommand(text, this.options.botUsername)

    if (decision === 'unclaimed' && command?.name === 'claim') {
      const claimed = await this.options.access.claim(userId, command.args)
      return await this.say(
        target,
        claimed
          ? '✅ Claimed. This bot now answers to you alone.'
          : '❌ That claim code is not right.',
      )
    }

    if (decision === 'unclaimed') {
      return await this.say(
        target,
        'This bot has no owner yet.\nRun <code>/claim &lt;code&gt;</code> with the code printed in the harness console.',
      )
    }

    this.logger.warn(`[dsh-telegram] refused a message from user ${userId}`)
    await this.say(target, '⛔ You are not allowed to use this bot.')
  }

  /** Run one command. */
  private async onCommand(
    target: ChatTarget,
    userId: number,
    name: string,
    args: string,
  ): Promise<void> {
    switch (name) {
      case 'start':
        return await this.say(
          target,
          `👋 Connected to DeepSeek Harness.\nSend a message to talk to the agent.\n\n${helpText()}`,
        )

      case 'help':
        return await this.say(target, helpText())

      case 'claim':
        return await this.say(target, 'This bot is already claimed.')

      case 'whoami':
        return await this.say(target, `Your Telegram user id is <code>${userId}</code>.`)

      case 'new':
        await this.options.runner.reset(target)
        return await this.say(target, '🆕 Started a fresh conversation.')

      case 'stop': {
        const stopped = await this.options.runner.stop(target)
        return await this.say(target, stopped ? '🛑 Stopped.' : 'Nothing was running.')
      }

      case 'status':
        return await this.say(target, await this.options.runner.status(target))

      default:
        // Unreachable: parseCommand only returns names present in COMMANDS.
        return await this.say(target, `Unknown command. Try ${Object.keys(COMMANDS).join(', ')}.`)
    }
  }

  /** Hand a prompt to the agent, reporting a failure into the chat. */
  private async runPrompt(target: ChatTarget, content: readonly PromptPart[]): Promise<void> {
    try {
      await this.options.runner.prompt(target, content)
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error)
      const reason = this.options.redact?.(raw) ?? raw
      this.logger.error('[dsh-telegram] prompt failed', error)
      await this.say(target, `⚠️ ${escapeHtml(reason)}`)
    }
  }

  /** Send one plain notice into a conversation, swallowing delivery failures. */
  private async say(target: ChatTarget, html: string): Promise<void> {
    try {
      await this.options.chat.sendMessage({
        chatId: target.chatId,
        html,
        ...(target.threadId !== undefined ? { threadId: target.threadId } : {}),
      })
    } catch (error) {
      this.logger.warn('[dsh-telegram] could not deliver a notice', error)
    }
  }
}

/** Whether a message carries anything beyond its text. */
function hasMedia(message: TelegramMessage): boolean {
  return Boolean(
    message.photo || message.document || message.voice || message.audio || message.video,
  )
}

/** The conversation a message belongs to. */
function targetOf(message: TelegramMessage): ChatTarget {
  return {
    chatId: String(message.chat.id),
    ...(message.message_thread_id !== undefined ? { threadId: message.message_thread_id } : {}),
  }
}
