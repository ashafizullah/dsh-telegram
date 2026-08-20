/**
 * Slash commands.
 *
 * Telegram delivers a command as ordinary message text, and in a group it
 * arrives addressed — `/new@my_bot` — because several bots may share the chat.
 * Parsing is therefore a real step rather than a `startsWith`, and a command
 * addressed to a different bot must be ignored rather than executed.
 */

/** A recognised command and the text that followed it. */
export interface ParsedCommand {
  /** Command name, lowercased, without the slash or the bot suffix. */
  readonly name: string
  /** Everything after the command, trimmed; empty when there was nothing. */
  readonly args: string
}

/** Commands the plugin answers, with the one-line help shown by `/help`. */
export const COMMANDS: Readonly<Record<string, string>> = {
  start: 'Show what this bot is and whether you may use it',
  help: 'List the commands',
  claim: 'Take ownership of an unclaimed bot: /claim <code>',
  new: 'Start a fresh conversation, forgetting the current one',
  status: 'Show the session, working directory, and who owns the bot',
  stop: 'Cancel whatever the agent is doing right now',
  whoami: 'Show your Telegram user id',
}

/**
 * Parse a message as a command.
 *
 * @param text - the raw message text.
 * @param botUsername - this bot's username, so `/cmd@other_bot` is ignored.
 * @returns the command, or undefined when the text is not one for us.
 */
export function parseCommand(text: string, botUsername?: string): ParsedCommand | undefined {
  const match = /^\/([a-z0-9_]+)(?:@([a-z0-9_]+))?(?:\s+([\s\S]*))?$/i.exec(text.trim())
  if (!match) return undefined

  const addressed = match[2]
  if (addressed !== undefined && botUsername !== undefined) {
    if (addressed.toLowerCase() !== botUsername.toLowerCase()) return undefined
  }

  const name = (match[1] as string).toLowerCase()
  if (!(name in COMMANDS)) return undefined

  return { name, args: (match[3] ?? '').trim() }
}

/** The `/help` body, rendered as Telegram HTML. */
export function helpText(): string {
  const lines = Object.entries(COMMANDS).map(
    ([name, description]) => `/${name} — ${description}`,
  )
  return `<b>Commands</b>\n${lines.join('\n')}`
}
