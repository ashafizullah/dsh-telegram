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
import { addressesBot, isGroupChat, stripMention } from './telegram/addressing.js'
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
}

/**
 * The conversation's working directory, and how to change it.
 *
 * Narrowed to what the router needs so `/cd` is testable without a filesystem:
 * `inspect` is the only call that touches disk.
 */
export interface WorkspaceControl {
  /** The directory this conversation's next session will open in. */
  current(target: ChatTarget): string
  /** Work out which directory an argument names; undefined when it names none. */
  resolve(input: string, current: string): string | undefined
  /** What is actually at that path. */
  inspect(directory: string): Promise<'directory' | 'file' | 'missing' | 'denied'>
  /** Remember it for this conversation. */
  set(target: ChatTarget, directory: string): Promise<void>
}

/** Shows that a conversation is being worked on, until released. */
export interface TypingHold {
  hold(target: ChatTarget): () => void
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
  /**
   * Keeps Telegram's own indicator alive while the bot works. Absent simply
   * leaves the chat quiet until the reply arrives.
   */
  readonly typing?: TypingHold
  /** Absent leaves every conversation in the configured directory. */
  readonly workspace?: WorkspaceControl
  readonly textCapture: TextCapture
  readonly runner: AgentRunner
  /**
   * Turns a message's attachments into prompt content. Absent leaves the bot
   * text-only, which is what it was before media was wired up.
   */
  readonly media?: MediaCollector
  /**
   * This bot's own user id, so a reply to something it said is recognised as
   * addressing it. A group conversation continues that way rather than by
   * @mentioning the bot on every line.
   */
  readonly botId?: number
  /**
   * Whether a group message must address the bot to be answered. Off makes the
   * bot answer every allowlisted message in the room, which is the older
   * behaviour and rarely what anyone wants.
   */
  readonly requireAddressing?: boolean
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

    const raw = message.text ?? message.caption
    const decision = this.options.access.check(userId)

    if (decision !== 'allowed') return await this.onUnauthorized(target, userId, raw, decision)

    // Asked after access and before anything else: a group is a room where
    // people talk to each other, and a bot that answers every line is one
    // nobody keeps around. Silence is the whole response — a message that was
    // not for us deserves no reply, not even a refusal.
    if (this.options.requireAddressing && !addressesBot(message, this.options.botUsername, this.options.botId)) {
      return
    }

    // The @mention is addressing, not content. Left in, every prompt from a
    // group would open with the bot's own name, which the model reads as part
    // of the question.
    const text =
      raw !== undefined && isGroupChat(message)
        ? stripMention(raw, this.options.botUsername) || undefined
        : raw

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

    // Held across the whole of it. Downloading a large file, retrying one that
    // failed, and reading an image on a vision model all outlast Telegram's
    // five-second action several times over, and none of them show anything in
    // the chat while they run.
    const release = this.options.typing?.hold(target)
    try {
      const collected = await this.options.media.collect(message, text)
      // Said first: the user should not have to wait for a reply to learn that
      // what they attached went nowhere.
      if (collected.notice) await this.say(target, escapeHtml(collected.notice))
      await this.runPrompt(target, collected.parts)
    } finally {
      release?.()
    }
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

      case 'cd':
        return await this.onChangeDirectory(target, args)

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
    // A prompt is not instant even without attachments: it may wait behind the
    // conversation's previous message, and an image in it is read before the
    // conversation ever sees it.
    const release = this.options.typing?.hold(target)
    try {
      await this.options.runner.prompt(target, content)
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error)
      const reason = this.options.redact?.(raw) ?? raw
      this.logger.error('[dsh-telegram] prompt failed', error)
      await this.say(target, `⚠️ ${escapeHtml(reason)}`)
    } finally {
      release?.()
    }
  }

  /**
   * Show or change the conversation's working directory.
   *
   * Changing it necessarily starts a fresh conversation: the sandbox derives
   * its writable root from the session's cwd, and that root is fixed when the
   * session opens. Rather than fail a move the user reasonably expects to
   * work, the reset is done for them and said out loud.
   *
   * @param target - the conversation.
   * @param args - what followed `/cd`; empty means "tell me where I am".
   */
  private async onChangeDirectory(target: ChatTarget, args: string): Promise<void> {
    const workspace = this.options.workspace
    const current = workspace?.current(target)

    if (!workspace || current === undefined) {
      return await this.say(target, 'This deployment does not allow changing directory.')
    }

    if (args.trim() === '') {
      return await this.say(
        target,
        `📁 <code>${escapeHtml(current)}</code>\n\nChange it with <code>/cd ~/projects/app</code>.`,
      )
    }

    const wanted = workspace.resolve(args, current)
    if (wanted === undefined) {
      return await this.say(target, 'Give me a directory: <code>/cd ~/projects/app</code>')
    }

    if (wanted === current) {
      return await this.say(target, `Already in <code>${escapeHtml(wanted)}</code>.`)
    }

    const verdict = await workspace.inspect(wanted)
    if (verdict !== 'directory') {
      const why =
        verdict === 'file'
          ? 'that is a file, not a directory'
          : verdict === 'denied'
            ? 'it cannot be read'
            : 'no such directory'
      return await this.say(target, `⚠️ Cannot use <code>${escapeHtml(wanted)}</code> — ${why}.`)
    }

    try {
      await workspace.set(target, wanted)
    } catch (error) {
      this.logger.error('[dsh-telegram] could not record the working directory', error)
      return await this.say(target, '⚠️ The directory could not be saved.')
    }

    // After the directory is recorded, so a failed reset still leaves the
    // choice in place for the next message rather than losing it silently.
    await this.options.runner.reset(target)
    return await this.say(
      target,
      `📁 Now working in <code>${escapeHtml(wanted)}</code>.\n\n` +
        '🆕 Started a fresh conversation — a session keeps the directory it opened in.',
    )
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
