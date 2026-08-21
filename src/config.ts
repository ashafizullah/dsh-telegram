/**
 * Plugin configuration.
 *
 * The bot token is deliberately absent. Configuration carries a *reference* to
 * the credential (`tokenRef`), and the value lives with the harness credential
 * provider — so a profile config stays safe to read, sync, and show in a UI,
 * and rotating the token touches no file here.
 */

import Schema from '@deepseek-ai/schemastery'

/** Default credential reference for the bot token. */
export const DEFAULT_TOKEN_REF = 'TELEGRAM_BOT_TOKEN'

export const Config = Schema.object({
  enabled: Schema.boolean()
    .default(true)
    .description('Whether the Telegram connection starts with the harness.'),

  tokenRef: Schema.string()
    .default(DEFAULT_TOKEN_REF)
    .description('Credential reference holding the bot token — never the token itself.'),

  baseUrl: Schema.string()
    .default('https://api.telegram.org')
    .description('Bot API origin; change it only for a local proxy.'),

  allowFrom: Schema.array(Schema.number())
    .default([])
    .description(
      'Telegram user ids allowed to drive the agent. Leave empty to claim the bot once with /claim.',
    ),

  cwd: Schema.string().description(
    'Working directory new conversations start in. Defaults to the harness working directory.',
  ),

  timeoutMs: Schema.natural().default(30_000).description('Per-request Bot API timeout.'),

  longPollSeconds: Schema.natural()
    .default(25)
    .description('How long Telegram holds an empty poll open.'),

  streaming: Schema.object({
    enabled: Schema.boolean()
      .default(true)
      .description('Edit one message as the answer streams, instead of sending it once at the end.'),
    throttleMs: Schema.natural()
      .default(1200)
      .description('Minimum gap between edits; Telegram rate-limits rapid edits to one chat.'),
    placeholder: Schema.string()
      .default('…')
      .description('Shown while the agent is thinking, before any text arrives.'),
  }),

  media: Schema.object({
    enabled: Schema.boolean()
      .default(true)
      .description('Read images and text files the user sends.'),
    maxBytes: Schema.natural()
      .default(20 * 1024 * 1024)
      .description('Refuse anything larger. Telegram caps bot downloads at 20 MB.'),
    maxTextChars: Schema.natural()
      .default(60_000)
      .description('Truncate an inlined text file to this many characters.'),
    visionModel: Schema.string()
      .default('')
      .description(
        'Model to run a turn on when it carries an image, as provider/model. ' +
          'Empty uses the conversation\'s own model, which must then accept images.',
      ),
  }),

  reconnect: Schema.object({
    baseDelayMs: Schema.natural().default(1000).description('First reconnect delay.'),
    maxDelayMs: Schema.natural().default(30_000).description('Longest reconnect delay.'),
  }),
})

/** Resolved plugin configuration. */
export type TelegramConfig = ReturnType<typeof Config>
