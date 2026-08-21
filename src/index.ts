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
import { StatusFile, describeError } from './diagnostics.js'
import { SecretRegistry } from './secrets.js'
import { Config } from './config.js'
import { TelegramApprovalAnswerer } from './interact/approvals.js'
import { PendingRegistry } from './interact/pending.js'
import { TelegramQuestionProvider } from './interact/questions.js'
import { telegramSurface } from './interact/surface.js'
import { TextCapture } from './interact/text-capture.js'
import { TurnBridge } from './reply/turn-bridge.js'
import { canStreamTo } from './reply/rich-stream.js'
import { UpdateRouter } from './router.js'
import { BindingStore } from './session/bindings.js'
import { RecoveryOffer } from './session/recovery.js'
import { SessionRunner } from './session/runner.js'
import { TelegramApi, TelegramApiError } from './telegram/api.js'
import { UpdatePoller } from './telegram/poller.js'
import { createAgentHost } from './harness/host.js'
import { MediaCollector } from './media/collect.js'
import { VisionCheck } from './media/vision.js'
import type { ModelCatalog } from './media/vision.js'
import { resolveMessageFactory } from './harness/message.js'
import { parseRoute, resolveSelectionInstaller } from './harness/model-selection.js'
import { installQuestionProvider } from './harness/questions-seam.js'
import type { AgentRegistryLike, ModelRoute } from './harness/host.js'
import type {
  ApprovalOutcome,
  ApprovalRequest,
  Logger,
  SettingsService,
  UserQuestionService,
} from './harness/types.js'
import type { BotUser } from './telegram/types.js'
import type { SessionEvent } from './reply/turn-bridge.js'
import type { TelegramConfig } from './config.js'

export { Config }
export type { TelegramConfig }

/** Cordis plugin name. */
export const name = 'dsh-telegram'

/**
 * Settings namespace this plugin owns. The browser half binds the same string,
 * which is the only thing pairing the two halves together.
 */
export const SETTINGS_NAMESPACE = 'telegram'

/**
 * Hard requirements only. Cordis reads this as a flat list of service names —
 * an object form would be read as services literally named after its keys — so
 * the interactive seams are bound inside `apply` with `ctx.inject()` instead.
 * That is what lets the plugin load on a profile that provides neither.
 */
export const inject = ['agents', 'credentials']

/** The slice of the cordis context this plugin uses. */
interface PluginContext {
  agents: AgentRegistryLike
  credentials: { resolve(ref: unknown): Promise<{ value?: string } | undefined> }
  logger(name: string): Logger
  get(key: string): unknown
  on(name: string, listener: (...args: never[]) => unknown, prepend?: boolean): () => void
  effect(callback: () => (() => void) | Promise<() => void>, label?: string): () => void
  /** Run `callback` once every named service is available; never, if one is not. */
  inject(names: readonly string[], callback: (scope: PluginContext) => void): Disposable
}

/** What `ctx.inject` hands back: a fiber whose disposal unwinds the callback. */
interface Disposable {
  dispose(): unknown
}

/**
 * Load the plugin.
 *
 * @param ctx - the cordis context.
 * @param config - resolved plugin configuration.
 */
export function apply(ctx: PluginContext, config: TelegramConfig): void {
  const logger = ctx.logger('dsh-telegram')

  let live = config
  let abort: AbortController | undefined

  // One registry for the plugin's lifetime: the token is registered the moment
  // it is resolved, and every file, log line, and chat message written after
  // that passes through it.
  const secrets = new SecretRegistry()
  const status = new StatusFile(join(dataDirectory(), 'status.json'), secrets.redactor())

  /** (Re)open the connection under the configuration standing right now. */
  const run = () => {
    abort?.abort()
    abort = new AbortController()
    const signal = abort.signal
    void start(ctx, live, logger, signal, status, secrets).catch((error: unknown) => {
      if (signal.aborted) return
      logger.error('[dsh-telegram] failed to start', error)
      void status.publish('failed', { detail: describeError(error) })
    })
  }

  ctx.effect(() => {
    run()
    return () => abort?.abort()
  }, 'dsh-telegram: connection')

  // Registering the namespace is what puts this plugin in front of a
  // configuration UI at all, and it happens even when the plugin is disabled —
  // otherwise the one screen that could re-enable it would have nothing to
  // show.
  //
  // Bound through ctx.inject rather than read with ctx.get: a settings provider
  // that composes after this entry would leave a get() empty, and the page
  // would show an empty namespace forever. A profile with no provider never
  // runs this, and the composed config stays the only source.
  ctx.inject(['settings'], (scope) => {
    const settings = scope.get('settings') as SettingsService | undefined
    if (!settings) return

    scope.effect(() => {
      // A configuration surface that cannot bind must never take the bot
      // offline with it — the connection is the point, the settings page is a
      // convenience — so a failed registration is reported and stepped over.
      let bound
      try {
        bound = settings.register<TelegramConfig>(SETTINGS_NAMESPACE, Config, { base: config })
      } catch (error) {
        logger.error('[dsh-telegram] could not register the settings namespace', error)
        void status.publish('failed', {
          detail: `settings namespace unavailable: ${describeError(error)}`,
        })
        return () => undefined
      }

      // The resolved value may already differ from the composed one — a user
      // document was loaded before this ran — so adopt it before watching.
      // Reconnecting only when it actually differs matters: with no user
      // overrides the resolved value IS the composed one, and reopening then
      // would cost every boot a second connection for nothing.
      const resolved = bound.get()
      if (resolved !== undefined && !sameJson(resolved, live)) {
        live = resolved
        run()
      }

      // Every setting here shapes the connection — the token it opens, who may
      // use it, how replies are streamed — so a change reopens it rather than
      // leaving half the new configuration unapplied until the next boot. The
      // cost is one aborted long poll.
      return bound.watch((next) => {
        live = next
        logger.info('[dsh-telegram] configuration changed; reconnecting')
        run()
      })
    }, 'dsh-telegram: settings namespace')
  })
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
  status: StatusFile,
  secrets: SecretRegistry,
): Promise<void> {
  if (!config.enabled) {
    logger.info('[dsh-telegram] disabled; not connecting')
    await status.publish('idle', { detail: 'disabled in configuration' })
    return
  }

  await status.publish('connecting')

  const token = await resolveToken(ctx, config.tokenRef)
  if (!token) {
    const detail =
      `credential "${config.tokenRef}" is not set. ` +
      'Create a bot with @BotFather and store its token under that reference.'
    logger.warn(`[dsh-telegram] ${detail} The bot is idle.`)
    await status.publish('idle', { detail })
    return
  }

  secrets.protect(token)

  const api = new TelegramApi({
    token,
    baseUrl: config.baseUrl,
    timeoutMs: config.timeoutMs,
  })

  const me = await openConnection(api, config, logger, signal, status)
  if (!me) return

  const home = dataDirectory()
  const bindings = await BindingStore.open(join(home, 'bindings.json'))
  const claimCode = randomUUID().slice(0, 8)
  const claimCodeFile = join(home, 'claim-code.txt')
  const access = await AccessPolicy.open(join(home, 'owner.json'), {
    allowFrom: config.allowFrom,
    claimCode,
    claimCodeFile,
  })
  announceAccess(access, config, claimCode, claimCodeFile, me.username, logger)

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

  const recovery = new RecoveryOffer(
    { surface, pending, targetOf, reset: (target) => runner.reset(target) },
    logger,
  )

  const turns = new TurnBridge({
    chat: api,
    targetOf,
    canDraft: (chat) => canStreamTo(chat.chatId, config.streaming.enabled),
    throttleMs: config.streaming.throttleMs,
    placeholder: config.streaming.placeholder,
    onFailure: (sessionId, failure) => void recovery.offer(sessionId, failure),
    logger,
  })

  // Without the selection seam a turn cannot be moved onto another model, so
  // the vision setting would silently do nothing; say so once instead.
  const installSelection = await resolveSelectionInstaller()
  if (!installSelection && parseRoute(config.media.visionModel)) {
    logger.warn(
      '[dsh-telegram] a vision model is configured, but this harness offers no model-selection seam; ' +
        'image turns will run on the conversation\'s own model',
    )
  }

  const runner = new SessionRunner({
    host: createAgentHost({
      agents: ctx.agents,
      message: await resolveMessageFactory(),
      selectModel: () => selectModel(ctx, logger),
      ...(installSelection ? { installSelection } : {}),
      logger,
    }),
    bindings,
    cwd: config.cwd || process.cwd(),
    visionModel: () => parseRoute(config.media.visionModel),
    logger,
  })

  // The llm service knows which models declare image input; without it the
  // check is skipped and the provider stays the authority.
  const catalog = ctx.get('llm') as ModelCatalog | undefined
  const vision = catalog
    ? new VisionCheck(catalog, () =>
        // The model an image would ACTUALLY run on, not the conversation's
        // default: judging the default would refuse every image the moment a
        // vision model was configured, which is the one case it exists for.
        parseRoute(config.media.visionModel) ?? selectModel(ctx, logger),
      )
    : undefined

  const media = config.media.enabled
    ? new MediaCollector({
        source: api,
        ...(vision ? { vision } : {}),
        // Absent on a deployment with no attachment seam; images are then
        // declined with a reason rather than silently dropped.
        ...(attachmentStore(ctx) ? { attachments: attachmentStore(ctx) as never } : {}),
        maxBytes: config.media.maxBytes,
        maxTextChars: config.media.maxTextChars,
        logger,
      })
    : undefined

  const router = new UpdateRouter({
    chat: api,
    access,
    questions,
    approvals,
    recovery,
    textCapture,
    runner,
    ...(me.username ? { botUsername: me.username } : {}),
    ...(media ? { media } : {}),
    redact: secrets.redactor(),
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
      recovery.dispose()
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
    onConnected: () => {
      logger.info('[dsh-telegram] listening for messages')
      void status.publish('connected', { bot: me.username ?? String(me.id) })
    },
    logger,
  })

  await poller.run(signal)
}

/**
 * Verify the token and take the polling path, retrying until it works.
 *
 * The receive loop already survives a dropped network; startup did not, and
 * that asymmetry is what turns a momentary failure — a rate limit after a
 * quick restart, a DNS blip, a laptop still waking — into a bot that stays
 * silent until someone restarts the harness. Only a rejected token is final:
 * retrying that would hammer Telegram forever with a credential that cannot
 * become valid on its own.
 *
 * @returns the bot's identity, or undefined when the caller aborted.
 */
async function openConnection(
  api: TelegramApi,
  config: TelegramConfig,
  logger: Logger,
  signal: AbortSignal,
  status: StatusFile,
): Promise<BotUser | undefined> {
  for (let attempt = 1; !signal.aborted; attempt += 1) {
    try {
      const me = await api.getMe()

      // getUpdates and webhooks are mutually exclusive; take the polling path.
      await api.deleteWebhook().catch((error: unknown) => {
        logger.warn('[dsh-telegram] could not clear an existing webhook', error)
      })

      logger.info(`[dsh-telegram] connected as @${me.username ?? me.id}`)
      await status.publish('connected', { bot: me.username ?? String(me.id) })
      return me
    } catch (error) {
      if (signal.aborted) return undefined

      if (error instanceof TelegramApiError && error.isAuthFailure) {
        const detail = `the bot token was rejected: ${error.description ?? 'unauthorized'}`
        logger.error(`[dsh-telegram] ${detail}`)
        await status.publish('failed', { detail })
        return undefined
      }

      const delay = Math.min(
        config.reconnect.baseDelayMs * 2 ** Math.min(attempt - 1, 8),
        config.reconnect.maxDelayMs,
      )
      logger.warn(`[dsh-telegram] could not connect; retrying in ${delay}ms`, error)
      await status.publish('connecting', {
        detail: `attempt ${attempt} failed: ${describeError(error)}`,
      })
      await sleep(delay, signal)
    }
  }

  return undefined
}

/** Cancellable pause between connection attempts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
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
  const fiber = ctx.inject(['userQuestions'], (scope) => {
    const service = scope.get('userQuestions') as UserQuestionService | undefined
    if (!service) return

    scope.effect(() => {
      const seam = installQuestionProvider(
        service,
        (previous) => {
          if (previous) provider.setFallback(previous)
          return provider
        },
        logger,
      )
      return () => seam.restore()
    }, 'dsh-telegram: user-questions provider')
  })

  return () => void fiber.dispose()
}

/**
 * Answer the approval waterfall for Telegram sessions.
 *
 * Registered with `prepend` so it is offered the request before the web UI's
 * listener, which claims any pending approval in the session regardless of
 * where the conversation is happening.
 */
function installApprovals(ctx: PluginContext, answerer: TelegramApprovalAnswerer): () => void {
  const fiber = ctx.inject(['approval'], (scope) => {
    scope.on(
      'approval/request',
      (async (request: ApprovalRequest, next: () => Promise<ApprovalOutcome>) => {
        const outcome = await answerer.decide(request)
        return outcome ?? (await next())
      }) as never,
      true,
    )
  })

  return () => void fiber.dispose()
}

/**
 * The deployment's current model route.
 *
 * Read through `ctx.get` at creation time rather than injected: the service is
 * optional in principle, and reading late means a default changed in Settings
 * applies to the next conversation without a reconnect.
 */
function selectModel(ctx: PluginContext, logger: Logger): ModelRoute | undefined {
  const service = ctx.get('agentDefaultModel') as
    | { currentSelection(): ModelRoute | undefined }
    | undefined

  if (!service) {
    logger.warn(
      '[dsh-telegram] no agentDefaultModel service: agents will be created without a model route, ' +
        'and every turn will fail while assembling its prompt',
    )
    return undefined
  }

  try {
    const selection = service.currentSelection()
    if (selection) return { provider: selection.provider, model: selection.model }
  } catch (error) {
    logger.warn('[dsh-telegram] could not read the default model selection', error)
  }

  return undefined
}

/**
 * The harness attachment seam, when this deployment mounts one.
 *
 * Read late rather than injected: a profile without it should still run the
 * bot, declining images with a reason instead of failing to load.
 */
function attachmentStore(ctx: PluginContext): unknown {
  return ctx.get('attachments')
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

/**
 * Deep equality over JSON-shaped configuration.
 *
 * Written out rather than done with `JSON.stringify`, whose answer depends on
 * key order — two resolutions of the same schema need not agree on it, and a
 * false difference here costs a needless reconnection.
 */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, index) => sameJson(item, b[index]))
  }

  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false

  return keys.every((key) => Object.hasOwn(right, key) && sameJson(left[key], right[key]))
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
  claimCodeFile: string,
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
      `Until then it answers nobody. The code changes on every restart, and is\n` +
      `also readable at ${claimCodeFile} in case this log is not.`,
  )
}
