/**
 * dsh-telegram — a Telegram front end for DeepSeek Harness.
 *
 * Two things this plugin does that a plain channel bridge does not:
 *
 * 1. **The agent's markdown arrives as markdown.** Replies are rendered to
 *    Telegram HTML and sent with `parse_mode`, so bold is bold and a code
 *    block is a code block — including while the answer is still streaming.
 * 2. **Questions and approvals can be answered from the chat.** The plugin
 *    registers a `ctx.userQuestions` provider and answers the
 *    `approval/request` waterfall, so `ask_user_question` and a tool that
 *    needs consent both become buttons in Telegram instead of a stall that
 *    only a browser can clear.
 *
 * Everything here is wiring. The behaviour lives in the modules below, each
 * testable without a harness; this file is the single place that touches the
 * live `ctx`.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { AccessPolicy } from './access.js'
import { Config } from './config.js'
import { TelegramApprovalAnswerer } from './interact/approvals.js'
import { PendingRegistry } from './interact/pending.js'
import { TelegramQuestionProvider } from './interact/questions.js'
import { telegramSurface } from './interact/surface.js'
import { TextCapture } from './interact/text-capture.js'
import { TurnBridge } from './reply/turn-bridge.js'
import { UpdateRouter } from './router.js'
import { BindingStore } from './session/bindings.js'
import { SessionRunner } from './session/runner.js'
import { TelegramApi } from './telegram/api.js'
import { UpdatePoller } from './telegram/poller.js'
import { createAgentHost } from './harness/host.js'
import { resolveMessageFactory } from './harness/message.js'
import { installQuestionProvider } from './harness/questions-seam.js'
import type { AgentRegistryLike } from './harness/host.js'
import type {
  ApprovalOutcome,
  ApprovalRequest,
  Logger,
  UserQuestionService,
} from './harness/types.js'
import type { SessionEvent } from './reply/turn-bridge.js'
import type { TelegramConfig } from './config.js'

export { Config }
export type { TelegramConfig }

/** Cordis plugin name. */
export const name = 'dsh-telegram'

/**
 * `agents` and `credentials` are required — without them there is no agent to
 * drive and no token to drive it with. The interactive seams are optional so
 * the plugin still runs on a profile that does not load them.
 */
export const inject = {
  required: ['agents', 'credentials'],
  optional: ['userQuestions', 'approval', 'settings'],
}

/** The slice of the cordis context this plugin uses. */
interface PluginContext {
  agents: AgentRegistryLike
  credentials: { resolve(ref: unknown): Promise<{ value?: string } | undefined> }
  userQuestions?: UserQuestionService
  approval?: unknown
  logger(name: string): Logger
  get(key: string): unknown
  on(name: string, listener: (...args: never[]) => unknown, prepend?: boolean): () => void
  effect(callback: () => (() => void) | Promise<() => void>, label?: string): () => void
}

/**
 * Load the plugin.
 *
 * @param ctx - the cordis context.
 * @param config - resolved plugin configuration.
 */
export function apply(ctx: PluginContext, config: TelegramConfig): void {
  if (!config.enabled) return

  const logger = ctx.logger('dsh-telegram')

  ctx.effect(() => {
    const abort = new AbortController()
    void start(ctx, config, logger, abort.signal).catch((error: unknown) => {
      logger.error('[dsh-telegram] failed to start', error)
    })
    return () => abort.abort()
  }, 'dsh-telegram: connection')
}

/**
 * Bring the whole plugin up: resolve the token, wire the pieces, and poll.
 *
 * An unconfigured token is not an error — a profile may carry this plugin
 * without a bot yet. It logs how to configure one and stays idle.
 */
async function start(
  ctx: PluginContext,
  config: TelegramConfig,
  logger: Logger,
  signal: AbortSignal,
): Promise<void> {
  const token = await resolveToken(ctx, config.tokenRef)
  if (!token) {
    logger.warn(
      `[dsh-telegram] credential "${config.tokenRef}" is not set; the bot is idle. ` +
        `Create one with @BotFather and store it under that reference.`,
    )
    return
  }

  const api = new TelegramApi({
    token,
    baseUrl: config.baseUrl,
    timeoutMs: config.timeoutMs,
  })

  const me = await api.getMe()
  logger.info(`[dsh-telegram] connected as @${me.username ?? me.id}`)

  // getUpdates and webhooks are mutually exclusive; take the polling path.
  await api.deleteWebhook().catch((error: unknown) => {
    logger.warn('[dsh-telegram] could not clear an existing webhook', error)
  })

  const home = dataDirectory()
  const bindings = await BindingStore.open(join(home, 'bindings.json'))
  const claimCode = randomUUID().slice(0, 8)
  const access = await AccessPolicy.open(join(home, 'owner.json'), {
    allowFrom: config.allowFrom,
    claimCode,
  })
  announceAccess(access, config, claimCode, me.username, logger)

  const surface = telegramSurface(api)
  const pending = new PendingRegistry<unknown>()
  const textCapture = new TextCapture()
  const targetOf = (sessionId: string) => bindings.forSession(sessionId)

  const questions = new TelegramQuestionProvider({
    surface,
    pending,
    targetOf,
    readText: (target, abortSignal) => textCapture.next(target, abortSignal),
  })

  const approvals = new TelegramApprovalAnswerer({ surface, pending, targetOf })

  const turns = new TurnBridge({
    surface,
    targetOf,
    ...(config.streaming.enabled ? { throttleMs: config.streaming.throttleMs } : {}),
    placeholder: config.streaming.placeholder,
    logger,
  })

  const runner = new SessionRunner({
    host: createAgentHost({
      agents: ctx.agents,
      message: await resolveMessageFactory(),
      logger,
    }),
    bindings,
    cwd: config.cwd || process.cwd(),
    logger,
  })

  const router = new UpdateRouter({
    chat: api,
    access,
    questions,
    approvals,
    textCapture,
    runner,
    ...(me.username ? { botUsername: me.username } : {}),
    logger,
  })

  const teardown = [
    subscribeToTurns(ctx, turns),
    installQuestions(ctx, questions, logger),
    installApprovals(ctx, approvals),
  ]

  signal.addEventListener(
    'abort',
    () => {
      for (const dispose of teardown) dispose()
      pending.dispose()
      textCapture.dispose()
      void turns.dispose()
    },
    { once: true },
  )

  const poller = new UpdatePoller({
    source: api,
    onUpdate: (update) => router.handle(update),
    longPollSeconds: config.longPollSeconds,
    baseDelayMs: config.reconnect.baseDelayMs,
    maxDelayMs: config.reconnect.maxDelayMs,
    onConnected: () => logger.info('[dsh-telegram] listening for messages'),
    logger,
  })

  await poller.run(signal)
}

/** Stream every Telegram-bound session's turns into its chat. */
function subscribeToTurns(ctx: PluginContext, turns: TurnBridge): () => void {
  return ctx.on('session/event', ((session: { id: string }, event: SessionEvent) => {
    void turns.handle(String(session.id), event)
  }) as never)
}

/**
 * Install the questions provider, chaining any incumbent. Absent on a profile
 * that does not load the seam, in which case questions simply stay a web-only
 * feature rather than breaking the plugin.
 */
function installQuestions(
  ctx: PluginContext,
  provider: TelegramQuestionProvider,
  logger: Logger,
): () => void {
  const service = ctx.userQuestions ?? (ctx.get('userQuestions') as UserQuestionService | undefined)
  if (!service) {
    logger.warn('[dsh-telegram] ctx.userQuestions is absent; questions cannot be answered here')
    return () => undefined
  }

  const seam = installQuestionProvider(
    service,
    (previous) => {
      if (previous) provider.setFallback(previous)
      return provider
    },
    logger,
  )

  return () => seam.restore()
}

/**
 * Answer the approval waterfall for Telegram sessions.
 *
 * Registered with `prepend` so it is offered the request before the web UI's
 * listener, which claims any pending approval in the session regardless of
 * where the conversation is happening.
 */
function installApprovals(ctx: PluginContext, answerer: TelegramApprovalAnswerer): () => void {
  if (ctx.get('approval') === undefined) return () => undefined

  return ctx.on(
    'approval/request',
    (async (request: ApprovalRequest, next: () => Promise<ApprovalOutcome>) => {
      const outcome = await answerer.decide(request)
      return outcome ?? (await next())
    }) as never,
    true,
  )
}

/** Resolve the bot token through the harness credential seam. */
async function resolveToken(ctx: PluginContext, ref: string): Promise<string | undefined> {
  try {
    const resolved = await ctx.credentials.resolve(ref)
    const value = resolved?.value
    return value && value !== '' ? value : undefined
  } catch {
    return undefined
  }
}

/** Where this plugin keeps its bindings and ownership record. */
function dataDirectory(): string {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'dsh-telegram')
}

/**
 * Tell the operator, on their own console, how to reach the bot. The claim
 * code is printed here and nowhere else — it must never travel over Telegram,
 * because anyone who can read it can take the bot.
 */
function announceAccess(
  access: AccessPolicy,
  config: TelegramConfig,
  claimCode: string,
  username: string | undefined,
  logger: Logger,
): void {
  if (config.allowFrom.length > 0) {
    logger.info(`[dsh-telegram] allowing ${config.allowFrom.length} configured user id(s)`)
    return
  }

  const owner = access.owner()
  if (owner !== undefined) {
    logger.info(`[dsh-telegram] owned by Telegram user ${owner}`)
    return
  }

  const handle = username ? `@${username}` : 'your bot'
  logger.warn(
    `[dsh-telegram] this bot has no owner yet. Message ${handle} with:\n\n    /claim ${claimCode}\n\n` +
      `Until then it answers nobody. The code changes on every restart.`,
  )
}
