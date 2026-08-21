/**
 * Reading an image with one model so another can use what it says.
 *
 * A provider inspects the whole request history for images, so an image left
 * in a conversation binds that conversation to a model that can see — for
 * good. That costs more than the picture is usually worth: the conversation
 * loses the model it was chosen for, and the tools configured around it.
 *
 * So the image never enters the conversation. It goes to a throwaway session
 * on the vision model, whose reply — the transcription, the description — is
 * what the conversation receives, as ordinary text. The conversation's history
 * stays free of images, so it keeps its own model and never becomes stuck.
 *
 * The throwaway session is disposed either way. It exists for one turn.
 */

import type { PromptPart } from './collect.js'
import type { ModelRoute } from '../harness/model-selection.js'
import type { Logger } from '../harness/types.js'
import { SILENT_LOGGER } from '../harness/types.js'

/** What the vision model is asked to do with the picture. */
const INSTRUCTION =
  'Read this image for someone who cannot see it. Transcribe every piece of ' +
  'text it contains, exactly, including numbers, dates, names and amounts. ' +
  'Then describe briefly what the image is. Reply with only that — no ' +
  'preamble, no offer of further help.'

/** How long one extraction may take before the conversation moves on without it. */
const DEFAULT_TIMEOUT_MS = 120_000

/** A live agent driven for exactly one turn. */
export interface ExtractionAgent {
  readonly sessionId: string
  followup(content: readonly PromptPart[]): void
  dispose(): Promise<void>
}

/** Creating the throwaway agent the extraction runs on. */
export interface ExtractionHost {
  create(sessionId: string, cwd: string, route: ModelRoute): Promise<ExtractionAgent>
}

/** The session-event shapes an extraction watches for. */
export interface ExtractionEvent {
  readonly type: string
  readonly data?: unknown
}

/** Construction options. */
export interface VisionExtractorOptions {
  readonly host: ExtractionHost
  readonly cwd: string
  /** The model to read with; undefined disables extraction entirely. */
  readonly visionModel: () => ModelRoute | undefined
  readonly newSessionId?: () => string
  readonly timeoutMs?: number
  readonly logger?: Logger
}

/** One extraction waiting on its session. */
interface Pending {
  /** The last thing the model said; the reading, once the turn ends well. */
  text: string
  settle: (text: string | undefined) => void
}

export class VisionExtractor {
  private readonly pending = new Map<string, Pending>()
  private readonly logger: Logger
  private counter = 0

  constructor(private readonly options: VisionExtractorOptions) {
    this.logger = options.logger ?? SILENT_LOGGER
  }

  /** Whether an image can be read at all right now. */
  get available(): boolean {
    return this.options.visionModel() !== undefined
  }

  /**
   * Replace image parts with what a vision model reads in them.
   *
   * @param content - the prompt as the user sent it.
   * @returns the same prompt with each image replaced by its reading, or the
   *   original content when there is nothing to read or no model to read it.
   */
  async resolve(content: readonly PromptPart[]): Promise<PromptPart[]> {
    const images = content.filter((part) => part.type === 'image')
    const route = this.options.visionModel()
    if (images.length === 0 || !route) return [...content]

    const said = content
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)

    const read = await this.read(images, route)
    if (read === undefined) {
      return [
        ...said.map((text) => ({ type: 'text' as const, text })),
        {
          type: 'text' as const,
          text: `(The user sent an image, but it could not be read by ${route.model}.)`,
        },
      ]
    }

    // The user's own words first: the image is what they are asking about.
    return [
      ...said.map((text) => ({ type: 'text' as const, text })),
      { type: 'text' as const, text: `Contents of the image the user sent:\n\n${read}` },
    ]
  }

  /**
   * Consume one session event.
   *
   * @returns whether it belonged to an extraction, so the caller knows not to
   *   treat it as a conversation of its own.
   */
  handle(sessionId: string, event: ExtractionEvent): boolean {
    const entry = this.pending.get(sessionId)
    if (!entry) return false

    if (event.type === 'assistant/message') {
      const message = (
        event.data as { message?: { content?: readonly { type: string; text?: string }[] } }
      )?.message
      const text = (message?.content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('')
        .trim()
      if (text !== '') entry.text = text
    }

    if (event.type === 'turn/end') {
      const reason = (
        event.data as { reason?: { kind?: string; error?: { message?: string } } }
      )?.reason
      if (reason?.kind === 'error') {
        this.logger.warn(
          `[dsh-telegram] the vision model could not read the image: ${
            reason.error?.message ?? 'the turn failed'
          }`,
        )
        entry.settle(undefined)
        return true
      }

      entry.settle(entry.text === '' ? undefined : entry.text)
    }

    return true
  }

  /** Abandon every extraction in flight — the plugin is unloading. */
  dispose(): void {
    for (const entry of [...this.pending.values()]) entry.settle(undefined)
  }

  /** Run one throwaway turn and return what the model said. */
  private async read(
    images: readonly PromptPart[],
    route: ModelRoute,
  ): Promise<string | undefined> {
    const sessionId = this.nextSessionId()

    let agent: ExtractionAgent
    try {
      agent = await this.options.host.create(sessionId, this.options.cwd, route)
    } catch (error) {
      this.logger.warn('[dsh-telegram] could not open a session to read the image', error)
      return undefined
    }

    try {
      const settled = new Promise<string | undefined>((resolve) => {
        const timer = setTimeout(() => {
          this.pending.delete(sessionId)
          this.logger.warn('[dsh-telegram] reading the image timed out')
          resolve(undefined)
        }, this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS)

        this.pending.set(sessionId, {
          text: '',
          settle: (text) => {
            clearTimeout(timer)
            this.pending.delete(sessionId)
            resolve(text)
          },
        })
      })

      agent.followup([{ type: 'text', text: INSTRUCTION }, ...images])
      return await settled
    } finally {
      // One turn is its whole life; leaving it loaded would keep a second
      // model warm for every picture anyone sends.
      await agent.dispose().catch((error: unknown) => {
        this.logger.warn('[dsh-telegram] could not dispose the reading session', error)
      })
    }
  }

  /** A session id no conversation can collide with. */
  private nextSessionId(): string {
    if (this.options.newSessionId) return this.options.newSessionId()
    this.counter += 1
    return `tg-vision-${Date.now()}-${this.counter}`
  }
}
