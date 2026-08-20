/**
 * Telegram HTML → plain text.
 *
 * Used only on the fallback path: if Telegram ever rejects our entities, the
 * message is re-sent without `parse_mode` rather than dropped. A user reading
 * slightly plainer text is a far better outcome than a silent gap in the
 * conversation.
 */

/** Entities the renderer can produce, plus the few Telegram may echo back. */
const ENTITIES: Readonly<Record<string, string>> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
}

/**
 * Strip Telegram HTML down to readable text.
 *
 * @param html - rendered Telegram HTML.
 * @returns the same content with tags removed and entities decoded.
 */
export function htmlToPlain(html: string): string {
  return html
    .replace(/<\/(?:p|div|blockquote|pre)>/g, '\n')
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&[a-z#0-9]+;/gi, (entity) => ENTITIES[entity.toLowerCase()] ?? entity)
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
