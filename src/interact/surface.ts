/**
 * The narrow chat surface the interactive prompts are written against.
 *
 * Questions and approvals only ever need to put a message in a chat and later
 * change it. Depending on that instead of the full Bot API client keeps those
 * modules testable with a few lines of stub, and keeps Telegram's request
 * shapes in one place.
 */

import type { TelegramApi } from '../telegram/api.js'
import type { InlineKeyboard } from '../telegram/types.js'

/** Where a prompt is delivered. */
export interface ChatTarget {
  readonly chatId: string
  readonly threadId?: number
}

/** Post and revise messages in a chat. */
export interface ChatSurface {
  /** Post a message; resolves to its id so it can be revised later. */
  send(target: ChatTarget, html: string, keyboard?: InlineKeyboard): Promise<number>
  /** Revise a message in place. Passing an empty keyboard retires the buttons. */
  edit(target: ChatTarget, messageId: number, html: string, keyboard?: InlineKeyboard): Promise<void>
}

/** Bind a {@link ChatSurface} to the live Bot API client. */
export function telegramSurface(api: TelegramApi): ChatSurface {
  return {
    async send(target, html, keyboard) {
      const sent = await api.sendMessage({
        chatId: target.chatId,
        html,
        ...(keyboard ? { keyboard } : {}),
        ...(target.threadId !== undefined ? { threadId: target.threadId } : {}),
      })
      return sent.messageId
    },

    async edit(target, messageId, html, keyboard) {
      await api.editMessageText({
        chatId: target.chatId,
        messageId,
        html,
        ...(keyboard ? { keyboard } : {}),
      })
    },
  }
}
