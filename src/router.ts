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
import type { TelegramMessage, TelegramUpdate } from './telegram/types.js'

/** What the router needs to drive a conversation's agent. */
export interface AgentRunner {
  /** Deliver a prompt, starting or resuming the chat's session as needed. */
  prompt(target: ChatTarget, text: string): Promise<void>
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
  readonly textCapture: TextCapture
  readonly runner: AgentRunner
  /** This bot's username, so `/cmd@other_bot` is left alone in groups. */
  readonly botUsername?: string
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
      this.options.approvals.handleCallback(query.data)

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

    if (text === undefined) {
      return await this.say(target, 'I can only read text messages for now.')
    }

    if (this.options.textCapture.deliver(target, text)) return

    const command = parseCommand(text, this.options.botUsername)
    if (command) return await this.onCommand(target, userId, command.name, command.args)

    await this.runPrompt(target, text)
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
  private async runPrompt(target: ChatTarget, text: string): Promise<void> {
    try {
      await this.options.runner.prompt(target, text)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
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

/** The conversation a message belongs to. */
function targetOf(message: TelegramMessage): ChatTarget {
  return {
    chatId: String(message.chat.id),
    ...(message.message_thread_id !== undefined ? { threadId: message.message_thread_id } : {}),
  }
}
