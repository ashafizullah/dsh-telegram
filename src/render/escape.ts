/**
 * HTML escaping for the Telegram Bot API `parse_mode: "HTML"` surface.
 *
 * Telegram's HTML mode is not a browser: it recognises a fixed tag whitelist
 * and treats everything else as text. Only `&`, `<` and `>` can start markup,
 * so those are the only three characters that must be escaped in text content.
 * Quotes are left intact — escaping them would only make the message noisier
 * in the rare case a client renders the entity literally.
 */

/** Escape text content so Telegram reads it as text, never as markup. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Escape a value destined for a double-quoted attribute (only `href` here).
 * The quote must go too, or a crafted URL could close the attribute early.
 */
export function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/"/g, '&quot;')
}
