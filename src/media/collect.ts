/**
 * Fetching a message's media and turning it into prompt content.
 *
 * Downloading is the part that can go wrong in ordinary ways — a file above
 * the bot download limit, a network drop, an image the harness refuses — and
 * none of them should cost the user their message. So every failure becomes a
 * note in the prompt saying what could not be read, and the text the user
 * typed alongside it still reaches the agent.
 */

import type { TelegramMessage } from '../telegram/types.js'
import type { Logger } from '../harness/types.js'
import { SILENT_LOGGER } from '../harness/types.js'

import { describeMedia, isStorableImage } from './intake.js'
import type { VisionCheck } from './vision.js'

/** A durable image reference, as the harness attachment seam returns it. */
export interface ImageRef {
  readonly attachmentId: unknown
  readonly mediaType: string
  readonly bytes: number
  readonly width: number
  readonly height: number
  readonly name?: string
}

/** One piece of a prompt. */
export type PromptPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly attachment: ImageRef }

/** Downloading bytes from Telegram. */
export interface MediaSource {
  getFile(fileId: string): Promise<{ file_path?: string; file_size?: number }>
  downloadFile(filePath: string, signal?: AbortSignal): Promise<Uint8Array>
}

/** The harness attachment seam, narrowed to what this needs. */
export interface AttachmentStore {
  saveImage(input: { data: Uint8Array; mediaType: string; name?: string }): Promise<ImageRef>
}

/** What a message's attachments became, plus anything the user should be told. */
export interface CollectedMedia {
  /** Content for the agent, in the order the model should read it. */
  readonly parts: PromptPart[]
  /**
   * A line for the chat, when something the user sent could not be used. The
   * agent's prompt says so too, but the person who sent it should not have to
   * wait for a reply to learn their screenshot went nowhere.
   */
  readonly notice?: string
}

/** Construction options. */
export interface MediaCollectorOptions {
  readonly source: MediaSource
  /** Absent on a deployment with no attachment seam; images are then declined. */
  readonly attachments?: AttachmentStore
  /**
   * Whether the model can read an image at all. Absent skips the check and
   * lets the provider be the authority, which is the older behaviour.
   */
  readonly vision?: VisionCheck
  /** Refuse anything larger, before downloading it. */
  readonly maxBytes: number
  /** Truncate an inlined text file to this many characters. */
  readonly maxTextChars: number
  readonly logger?: Logger
}

export class MediaCollector {
  private readonly logger: Logger

  constructor(private readonly options: MediaCollectorOptions) {
    this.logger = options.logger ?? SILENT_LOGGER
  }

  /**
   * Turn one message into the parts a prompt is built from.
   *
   * @param message - the incoming message.
   * @param caption - the text the user typed, if any.
   * @returns text and image parts, in the order the model should read them.
   */
  async collect(message: TelegramMessage, caption: string | undefined): Promise<CollectedMedia> {
    const item = describeMedia(message)
    const said = caption?.trim()

    if (!item) {
      return { parts: said ? [{ type: 'text', text: said }] : [] }
    }

    if (item.kind === 'unsupported') {
      const what = item.describedAs ?? 'a file'
      return this.declined(said, `${what}, which cannot be read`, `I can't read ${what}.`)
    }

    if (item.size !== undefined && item.size > this.options.maxBytes) {
      const limit = Math.floor(this.options.maxBytes / 1024 / 1024)
      return this.declined(
        said,
        `a file of ${item.size} bytes, above the size limit`,
        `That file is too large — the limit is ${limit} MB.`,
      )
    }

    if (item.kind === 'image') {
      const refusal = await this.imageRefusal()
      if (refusal) return this.declined(said, refusal.forAgent, refusal.forUser)
    }

    try {
      const bytes = await this.download(item.fileId)

      if (item.kind === 'text') {
        const text = decodeText(bytes, this.options.maxTextChars)
        const name = item.name ?? 'attachment'
        return {
          parts: [
            { type: 'text', text: `${said ? `${said}\n\n` : ''}File \`${name}\`:\n\n${text}` },
          ],
        }
      }

      if (!this.options.attachments) {
        return this.declined(
          said,
          'an image, but this deployment stores none',
          'This deployment cannot store images.',
        )
      }
      if (!isStorableImage(item.mediaType)) {
        const type = item.mediaType ?? 'unknown'
        return this.declined(
          said,
          `an image of type ${type}, which cannot be stored`,
          `Images of type ${type} cannot be stored. PNG, JPEG, WebP and GIF work.`,
        )
      }

      const attachment = await this.options.attachments.saveImage({
        data: bytes,
        mediaType: item.mediaType as string,
        ...(item.name !== undefined ? { name: item.name } : {}),
      })

      // Text first: it is what the user asked, and the image is its subject.
      const parts: PromptPart[] = []
      if (said) parts.push({ type: 'text', text: said })
      parts.push({ type: 'image', attachment })
      return { parts }
    } catch (error) {
      this.logger.warn('[dsh-telegram] could not read an attachment', error)
      const reason = error instanceof Error ? error.message : String(error)
      return this.declined(
        said,
        `a file that could not be read: ${reason}`,
        `That file could not be read: ${reason}`,
      )
    }
  }

  /**
   * Why an image must not be sent on the current route, if it must not.
   *
   * A model with no image input rejects the entire request, so this refusal
   * replaces a failed turn with a sentence naming what would have worked.
   */
  private async imageRefusal(): Promise<{ forAgent: string; forUser: string } | undefined> {
    const vision = this.options.vision
    if (!vision) return undefined
    if ((await vision.verdict()) !== 'no') return undefined

    const model = vision.currentModel() ?? 'the current model'
    const alternatives = await vision.alternatives()
    const suggestion =
      alternatives.length > 0
        ? ` These accept images: ${alternatives.join(', ')}.`
        : ' No configured model accepts images.'

    return {
      forAgent: `an image, which the model ${model} cannot read, so it was left out`,
      forUser: `${model} can't read images.${suggestion} Change it in Settings → Models.`,
    }
  }

  /** Keep the caption, tell the agent what was left out, and tell the user why. */
  private declined(said: string | undefined, forAgent: string, forUser: string): CollectedMedia {
    return {
      parts: [{ type: 'text', text: note(said, `The user sent ${forAgent}.`) }],
      notice: forUser,
    }
  }

  /** Resolve a file id and pull its bytes, refusing anything oversized. */
  private async download(fileId: string): Promise<Uint8Array> {
    const file = await this.options.source.getFile(fileId)
    if (!file.file_path) throw new Error('telegram returned no download path')
    if (file.file_size !== undefined && file.file_size > this.options.maxBytes) {
      throw new Error(`file is ${file.file_size} bytes, above the size limit`)
    }
    return await this.options.source.downloadFile(file.file_path)
  }
}

/** Keep what the user said, and add why their file did not come through. */
function note(said: string | undefined, explanation: string): string {
  return said ? `${said}\n\n(${explanation})` : `(${explanation})`
}

/** Decode file bytes as text, replacing what is not valid UTF-8. */
function decodeText(bytes: Uint8Array, maxChars: number): string {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n\n… (truncated at ${maxChars} characters)`
}
