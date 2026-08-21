/**
 * Getting what the user sent into what the agent can read.
 *
 * Three kinds arrive and only two can go anywhere useful:
 *
 * - **Images** reach the model. The harness attachment seam accepts PNG,
 *   JPEG, WebP and GIF, commits the bytes durably, and hands back a reference
 *   the session log can carry — which is why a screenshot works at all.
 * - **Text documents** — a log, a stack trace, a source file — have no seam,
 *   but they do not need one: their content is text, so it is read and placed
 *   in the prompt where the model already looks.
 * - **Voice, audio and video** have neither. The harness explicitly defers
 *   them, so the honest answer is to say so rather than to accept the message
 *   and silently drop what it carried.
 *
 * Telegram sends an uncompressed image as a *document*, so kind is decided by
 * media type rather than by which field it arrived in.
 */

import type { TelegramMessage } from '../telegram/types.js'

/** Media types the harness attachment seam accepts. */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** Media types worth reading as text, beyond anything named `text/*`. */
const TEXT_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/x-yaml',
  'application/yaml',
  'application/javascript',
  'application/typescript',
  'application/sql',
  'application/toml',
])

/** Extensions that are text regardless of the type Telegram guessed. */
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'log', 'json', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'kt',
  'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'swift', 'sh', 'bash', 'zsh', 'sql',
  'html', 'css', 'scss', 'xml', 'csv', 'diff', 'patch', 'lock',
])

/** One file a message carries, and what can be done with it. */
export interface MediaItem {
  /** Telegram's handle for the bytes. */
  readonly fileId: string
  /** What this plugin can do with it. */
  readonly kind: 'image' | 'text' | 'unsupported'
  /** Media type, where Telegram supplied one. */
  readonly mediaType?: string
  /** File name, where one was sent. */
  readonly name?: string
  /** Size in bytes, where Telegram reported it. */
  readonly size?: number
  /** For `unsupported`, what it was — so the refusal can name it. */
  readonly describedAs?: string
}

/**
 * Identify the media a message carries.
 *
 * @param message - the incoming Telegram message.
 * @returns the item, or undefined for a message carrying none.
 */
export function describeMedia(message: TelegramMessage): MediaItem | undefined {
  if (message.photo && message.photo.length > 0) {
    // Telegram sends several sizes; the last is the largest, and the largest
    // is the one worth showing a model.
    const largest = message.photo[message.photo.length - 1]
    if (!largest) return undefined
    return {
      fileId: largest.file_id,
      kind: 'image',
      mediaType: 'image/jpeg',
      ...(largest.file_size !== undefined ? { size: largest.file_size } : {}),
    }
  }

  if (message.document) {
    const { file_id: fileId, file_name: name, mime_type: mediaType } = message.document
    return {
      fileId,
      kind: documentKind(mediaType, name),
      ...(mediaType !== undefined ? { mediaType } : {}),
      ...(name !== undefined ? { name } : {}),
      describedAs: mediaType ?? 'file',
    }
  }

  if (message.voice) {
    return { fileId: message.voice.file_id, kind: 'unsupported', describedAs: 'a voice note' }
  }
  if (message.audio) {
    return { fileId: message.audio.file_id, kind: 'unsupported', describedAs: 'an audio file' }
  }
  if (message.video) {
    return { fileId: message.video.file_id, kind: 'unsupported', describedAs: 'a video' }
  }

  return undefined
}

/** Whether a document is an image, readable text, or neither. */
function documentKind(mediaType: string | undefined, name: string | undefined): MediaItem['kind'] {
  if (mediaType && IMAGE_TYPES.has(mediaType)) return 'image'
  if (mediaType && (mediaType.startsWith('text/') || TEXT_TYPES.has(mediaType))) return 'text'

  // Telegram often guesses application/octet-stream for source files, so the
  // extension is the better signal when the type says nothing useful.
  const extension = name?.split('.').pop()?.toLowerCase()
  if (extension && TEXT_EXTENSIONS.has(extension)) return 'text'

  return 'unsupported'
}

/**
 * Whether the harness can store this image.
 *
 * @param mediaType - the type Telegram reported.
 */
export function isStorableImage(mediaType: string | undefined): boolean {
  return mediaType !== undefined && IMAGE_TYPES.has(mediaType)
}
