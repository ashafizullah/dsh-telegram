/**
 * The slice of the Telegram Bot API this plugin actually speaks.
 *
 * Deliberately partial: every field here is one the adapter reads, so an
 * upstream schema change surfaces as a type error at the exact use site rather
 * than as a silently-undefined value deep in the pipeline.
 */

/** A button in an inline keyboard. */
export interface InlineButton {
  /** Label shown on the button. */
  readonly text: string
  /** Opaque payload echoed back in the callback query (Telegram caps it at 64 bytes). */
  readonly callbackData: string
}

/** Rows of inline buttons; each inner array is one row. */
export type InlineKeyboard = readonly (readonly InlineButton[])[]

/** The bot's own account, as returned by `getMe`. */
export interface BotUser {
  readonly id: number
  readonly is_bot: boolean
  readonly first_name?: string
  readonly username?: string
}

/** A Telegram chat. */
export interface TelegramChat {
  readonly id: number
  readonly type: 'private' | 'group' | 'supergroup' | 'channel'
  readonly title?: string
  readonly username?: string
}

/** A Telegram user. */
export interface TelegramUser {
  readonly id: number
  readonly is_bot?: boolean
  readonly first_name?: string
  readonly username?: string
}

/** An incoming message. */
export interface TelegramMessage {
  readonly message_id: number
  readonly date?: number
  readonly chat: TelegramChat
  readonly from?: TelegramUser
  readonly text?: string
  readonly caption?: string
  readonly message_thread_id?: number
  readonly reply_to_message?: { readonly message_id: number }
  /**
   * Every size Telegram generated, smallest first. The dimensions matter: the
   * largest is routinely bigger than the harness will store.
   */
  readonly photo?: readonly {
    readonly file_id: string
    readonly file_size?: number
    readonly width?: number
    readonly height?: number
  }[]
  readonly document?: {
    readonly file_id: string
    readonly file_name?: string
    readonly mime_type?: string
  }
  readonly voice?: { readonly file_id: string; readonly duration?: number }
  readonly audio?: { readonly file_id: string; readonly mime_type?: string }
  readonly video?: { readonly file_id: string; readonly mime_type?: string }
}

/**
 * A button press. This is the update type the existing channel plugin never
 * subscribes to, and the reason questions cannot be answered from Telegram.
 */
export interface TelegramCallbackQuery {
  readonly id: string
  readonly from: TelegramUser
  readonly data?: string
  readonly message?: TelegramMessage
}

/** One entry from `getUpdates`. */
export interface TelegramUpdate {
  readonly update_id: number
  readonly message?: TelegramMessage
  readonly edited_message?: TelegramMessage
  readonly callback_query?: TelegramCallbackQuery
}

/** File metadata from `getFile`. */
export interface TelegramFile {
  readonly file_id: string
  readonly file_size?: number
  readonly file_path?: string
}

/** Chat actions the adapter uses as a progress indicator. */
export type ChatAction = 'typing' | 'upload_document' | 'upload_photo'
