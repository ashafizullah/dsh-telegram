/**
 * The permission preset a Telegram conversation runs under.
 *
 * A deployment picks one default for everything it runs, and that choice is
 * usually made for the surface the operator sits in front of: the web UI is
 * loopback-only, with a person watching what the agent does. A Telegram bot is
 * not that. It is reachable from anywhere, gated by a list of user ids, and
 * read on a phone — so the same `danger-full-access` that is merely convenient
 * at a desk is a different proposition over a chat app.
 *
 * This lets the two differ. It is deliberately not a second place to author
 * presets: the names come from the deployment's own table, and all this does
 * is choose among them for conversations that arrive over Telegram.
 *
 * It also decides whether the approval buttons work at all. Under a preset
 * whose approval policy is `never` nothing ever asks, so the buttons this
 * plugin registers can never appear — choosing one that asks is what turns
 * them on.
 */

import type { Logger } from '../harness/types.js'
import { SILENT_LOGGER } from '../harness/types.js'

/** The deployment's preset table, narrowed to what this needs. */
export interface PermissionPresetsLike {
  /** Every preset name the deployment defines. */
  readonly names: readonly string[]
  /** Switch one session onto a preset; an unknown name throws. */
  set(session: unknown, name: string): void
}

/** Looking up a live session by id. */
export interface SessionLookup {
  get(sessionId: string): unknown
}

/** Construction options. */
export interface PermissionControlOptions {
  readonly presets?: PermissionPresetsLike
  readonly sessions?: SessionLookup
  /** The preset to use; empty or undefined leaves the deployment default. */
  readonly preset: () => string | undefined
  readonly logger?: Logger
}

export class PermissionControl {
  private readonly logger: Logger
  /** Names already reported as unknown, so one typo is not logged per turn. */
  private readonly complained = new Set<string>()

  constructor(private readonly options: PermissionControlOptions) {
    this.logger = options.logger ?? SILENT_LOGGER
  }

  /** Whether this deployment can be told to use a different preset. */
  get available(): boolean {
    return this.options.presets !== undefined && this.options.sessions !== undefined
  }

  /** Every preset name available, for a message that has to name them. */
  get names(): readonly string[] {
    return this.options.presets?.names ?? []
  }

  /**
   * Put one session on the configured preset.
   *
   * Applied after the session exists rather than at creation: the harness pins
   * an initial permission before publishing, and switching afterwards is the
   * supported path — it is what the web UI's own picker does mid-session.
   *
   * Failure is never fatal. A session that keeps the deployment default is
   * exactly what an unconfigured deployment gets, so a bad name costs a log
   * line rather than the user's message.
   *
   * @param sessionId - the session to switch.
   */
  apply(sessionId: string): void {
    const wanted = this.options.preset()?.trim()
    if (!wanted) return

    const { presets, sessions } = this.options
    if (!presets || !sessions) return

    if (!presets.names.includes(wanted)) {
      if (!this.complained.has(wanted)) {
        this.complained.add(wanted)
        this.logger.warn(
          `[dsh-telegram] unknown permission preset "${wanted}" ` +
            `(known: ${presets.names.join(', ') || 'none'}); keeping the deployment default`,
        )
      }
      return
    }

    const session = sessions.get(sessionId)
    if (session === undefined) {
      this.logger.debug(`[dsh-telegram] session '${sessionId}' is not live; permission unchanged`)
      return
    }

    try {
      presets.set(session, wanted)
    } catch (error) {
      this.logger.warn(`[dsh-telegram] could not apply permission preset "${wanted}"`, error)
    }
  }
}
