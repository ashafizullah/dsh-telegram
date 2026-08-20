/**
 * Split rendered Telegram HTML into sendable chunks.
 *
 * The Bot API caps a message at 4096 characters and rejects the whole message
 * when its entities do not parse. A naive slice at 4096 breaks both rules at
 * once: it can land inside `<cod|e>`, inside `&am|p;`, or between `<b>` and
 * `</b>`, and Telegram answers 400 for the entire send.
 *
 * So the split walks the markup instead of the string: it tracks which tags
 * are open at every position, cuts only at a safe boundary, closes what is
 * open at the cut, and reopens the same tags — attributes included, so a code
 * block keeps its language — at the start of the next chunk.
 */

/** Tag names that carry no content and so are never reopened. */
const VOID_TAGS = new Set(['br'])

/** Cut points in descending order of how natural the seam looks. */
const BOUNDARIES = ['\n\n', '\n', ' '] as const

/** How far back from the limit a nicer boundary is still worth taking. */
const BOUNDARY_SEARCH_RATIO = 0.4

/**
 * Split Telegram HTML into chunks that each parse on their own.
 *
 * @param html - rendered Telegram HTML.
 * @param limit - maximum characters per chunk (4096 for the Bot API).
 * @returns chunks in order; empty when the input holds no visible content.
 */
export function splitHtml(html: string, limit: number): string[] {
  const trimmed = html.trim()
  if (trimmed === '') return []
  if (trimmed.length <= limit) return [trimmed]

  const chunks: string[] = []
  let open: OpenTag[] = []
  let cursor = 0

  while (cursor < trimmed.length) {
    const prefix = open.map((tag) => tag.raw).join('')
    const chunk = fitChunk(trimmed, cursor, open, prefix, limit)

    chunks.push(`${prefix}${chunk.body}${closingTags(chunk.open)}`)
    open = chunk.open
    cursor = skipSeparator(trimmed, chunk.cut)
  }

  return chunks
}

/** A tag that is currently open, kept with its raw text so it can be reopened. */
interface OpenTag {
  readonly name: string
  readonly raw: string
}

/** One chunk's body, the cut it ended at, and the tags left open after it. */
interface FittedChunk {
  readonly body: string
  readonly cut: number
  readonly open: OpenTag[]
}

/**
 * Choose the largest body that still fits once its own closing tags are added.
 *
 * The closing cost is not known before the body is chosen — a body may open
 * more tags than it closes — so the budget is an estimate that is verified and
 * retried. Shrinking rather than guessing keeps the hard guarantee that no
 * chunk exceeds the limit, which is the one thing Telegram will not forgive.
 */
function fitChunk(
  html: string,
  cursor: number,
  open: readonly OpenTag[],
  prefix: string,
  limit: number,
): FittedChunk {
  let budget = limit - prefix.length - closingLength(open)

  for (;;) {
    const cut = findCut(html, cursor, budget)
    const body = html.slice(cursor, cut)
    const next = applyTags(open, body)
    const total = prefix.length + body.length + closingLength(next)

    if (total <= limit || cut <= cursor + 1) return { body, cut, open: next }
    budget -= total - limit
  }
}

/**
 * Index to cut at: the latest safe boundary within `budget`, falling back to a
 * hard cut when a single unbroken run is longer than a whole chunk.
 */
function findCut(html: string, from: number, budget: number): number {
  const hardEnd = Math.min(from + Math.max(budget, 1), html.length)
  if (hardEnd >= html.length) return html.length

  const floor = from + Math.floor(Math.max(budget, 1) * BOUNDARY_SEARCH_RATIO)

  for (const boundary of BOUNDARIES) {
    const at = html.lastIndexOf(boundary, hardEnd - boundary.length)
    if (at >= floor && safeAt(html, at)) return at
  }

  let cut = hardEnd
  while (cut > from + 1 && !safeAt(html, cut)) cut -= 1
  return cut
}

/**
 * Whether `index` sits between characters rather than inside a tag or an
 * entity — the two runs that must never be broken.
 */
function safeAt(html: string, index: number): boolean {
  const before = html.lastIndexOf('<', index - 1)
  if (before !== -1 && html.indexOf('>', before) >= index) return false

  const entity = html.lastIndexOf('&', index - 1)
  if (entity !== -1 && index - entity <= 10) {
    const end = html.indexOf(';', entity)
    if (end >= index && !/\s/.test(html.slice(entity, index))) return false
  }

  return true
}

/** Fold the tags contained in `body` onto the open-tag stack. */
function applyTags(open: readonly OpenTag[], body: string): OpenTag[] {
  const stack = [...open]

  for (const match of body.matchAll(/<(\/?)([a-z-]+)((?:\s[^>]*)?)>/g)) {
    const name = match[2] as string
    if (VOID_TAGS.has(name)) continue

    if (match[1] === '/') {
      const at = stack.map((tag) => tag.name).lastIndexOf(name)
      if (at !== -1) stack.splice(at, 1)
    } else {
      stack.push({ name, raw: match[0] })
    }
  }

  return stack
}

/** Closing tags for everything currently open, innermost first. */
function closingTags(open: readonly OpenTag[]): string {
  return [...open].reverse().map((tag) => `</${tag.name}>`).join('')
}

/** Character cost of closing everything currently open. */
function closingLength(open: readonly OpenTag[]): number {
  return closingTags(open).length
}

/** Skip the whitespace a chunk was cut on, so it is not repeated at the seam. */
function skipSeparator(html: string, cut: number): number {
  let index = cut
  while (index < html.length && (html[index] === '\n' || html[index] === ' ')) index += 1
  return index
}
