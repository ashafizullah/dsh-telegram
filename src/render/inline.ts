/**
 * Inline markdown → Telegram HTML.
 *
 * A small recursive-descent parser rather than a regex pass, for one reason
 * that matters here: the agent's text arrives as a STREAM, so this renderer is
 * called on prefixes of a document that stop mid-word, mid-emphasis, and
 * mid-code-span. A regex pass drops or unbalances those. This parser instead
 * treats an unterminated marker as an element that runs to the end of the
 * input and closes it, so every string it is ever handed — complete or not —
 * produces balanced HTML that Telegram accepts.
 */

import { escapeAttribute, escapeHtml } from './escape.js'

/** URL schemes Telegram may open on the user's behalf. Everything else is dropped. */
const SAFE_SCHEMES = ['http:', 'https:', 'tg:', 'mailto:'] as const

/** Emphasis markers, longest first so `**` is never read as two `*`. */
const EMPHASIS: readonly EmphasisMarker[] = [
  { marker: '~~', tags: ['s'] },
  { marker: '||', tags: ['tg-spoiler'] },
  { marker: '***', tags: ['b', 'i'] },
  { marker: '___', tags: ['b', 'i'] },
  { marker: '**', tags: ['b'] },
  { marker: '__', tags: ['b'] },
  { marker: '*', tags: ['i'] },
  { marker: '_', tags: ['i'] },
]

interface EmphasisMarker {
  /** The literal delimiter run. */
  readonly marker: string
  /** Tags wrapped outermost-first around the delimited content. */
  readonly tags: readonly string[]
}

/**
 * Render one line (or run) of inline markdown as Telegram HTML.
 *
 * @param text - inline markdown, possibly a truncated stream prefix.
 * @returns balanced Telegram-HTML; never contains an unclosed tag.
 */
export function renderInline(text: string): string {
  let out = ''
  let index = 0

  while (index < text.length) {
    const rest = text.slice(index)

    if (rest.startsWith('\\') && rest.length > 1) {
      out += escapeHtml(rest[1] as string)
      index += 2
      continue
    }

    if (rest.startsWith('`')) {
      const span = readCodeSpan(rest)
      out += span.html
      index += span.length
      continue
    }

    const link = readLink(rest)
    if (link) {
      out += link.html
      index += link.length
      continue
    }

    const emphasis = readEmphasis(text, index)
    if (emphasis) {
      out += emphasis.html
      index += emphasis.length
      continue
    }

    out += escapeHtml(text[index] as string)
    index += 1
  }

  return out
}

/** Parsed inline construct: its HTML and how much of the input it consumed. */
interface Consumed {
  readonly html: string
  readonly length: number
}

/**
 * Read a backtick code span. Markdown inside a code span is literal, so the
 * content is escaped and never re-parsed. An unterminated span runs to the end
 * of the input — the streaming case.
 */
function readCodeSpan(rest: string): Consumed {
  const fence = /^`+/.exec(rest)?.[0] as string
  const closer = findRun(rest, fence, fence.length)

  const raw = closer === -1 ? rest.slice(fence.length) : rest.slice(fence.length, closer)
  const length = closer === -1 ? rest.length : closer + fence.length

  return { html: `<code>${escapeHtml(trimOneSpace(raw))}</code>`, length }
}

/**
 * Read `[text](href)` or `![alt](src)`. An image becomes a link to its source:
 * Telegram cannot inline an image inside a text message, and a bare alt string
 * loses the address entirely.
 */
function readLink(rest: string): Consumed | undefined {
  const isImage = rest.startsWith('![')
  const open = isImage ? 2 : 1
  if (!rest.startsWith(isImage ? '![' : '[')) return undefined

  const labelEnd = findClosing(rest, open, '[', ']')
  if (labelEnd === -1 || rest[labelEnd + 1] !== '(') return undefined

  const hrefEnd = findClosing(rest, labelEnd + 2, '(', ')')
  if (hrefEnd === -1) return undefined

  const label = renderInline(rest.slice(open, labelEnd))
  const href = rest.slice(labelEnd + 2, hrefEnd).trim()
  const length = hrefEnd + 1

  if (!isSafeHref(href)) return { html: label, length }
  return { html: `<a href="${escapeAttribute(href)}">${label}</a>`, length }
}

/**
 * Read an emphasis run starting at `index`, if one opens there. Content is
 * parsed recursively so `*a **b** c*` nests correctly. An unterminated run
 * wraps everything that follows — the streaming case again.
 */
function readEmphasis(text: string, index: number): Consumed | undefined {
  const rest = text.slice(index)

  for (const { marker, tags } of EMPHASIS) {
    if (!rest.startsWith(marker)) continue
    if (!opensAt(text, index, marker)) continue

    const closer = findCloser(rest, marker)
    const inner = closer === -1 ? rest.slice(marker.length) : rest.slice(marker.length, closer)
    if (inner.length === 0) continue

    const length = closer === -1 ? rest.length : closer + marker.length
    const open = tags.map((tag) => `<${tag}>`).join('')
    const close = [...tags].reverse().map((tag) => `</${tag}>`).join('')

    return { html: `${open}${renderInline(inner)}${close}`, length }
  }

  return undefined
}

/**
 * Whether a delimiter run at `index` may OPEN emphasis. Two rules keep prose
 * intact: a marker followed by whitespace is arithmetic or a stray character
 * (`2 * 3`), and an underscore run touching a word character belongs to an
 * identifier (`snake_case_name`).
 */
function opensAt(text: string, index: number, marker: string): boolean {
  const after = text[index + marker.length]
  if (after === undefined || /\s/.test(after)) return false

  if (marker.startsWith('_')) {
    const before = text[index - 1]
    if (before !== undefined && /[\w]/.test(before)) return false
  }

  if (marker.startsWith('*') || marker.startsWith('_')) {
    // A longer run of the same character is a different marker entirely.
    const run = runLengthAt(text, index, marker[0] as string)
    if (run !== marker.length) return false
  }

  return true
}

/**
 * Index of the delimiter run that CLOSES `marker`, or -1 when the run is
 * unterminated. Escapes and code spans are skipped so a delimiter quoted
 * inside `` `code` `` never closes emphasis around it.
 */
function findCloser(rest: string, marker: string): number {
  const char = marker[0] as string

  for (let i = marker.length; i < rest.length; i += 1) {
    if (rest[i] === '\\') {
      i += 1
      continue
    }

    if (rest[i] === '`') {
      const fence = /^`+/.exec(rest.slice(i))?.[0] as string
      const end = findRun(rest.slice(i), fence, fence.length)
      if (end === -1) return -1
      i += end + fence.length - 1
      continue
    }

    if (rest[i] !== char) continue
    if (runLengthAt(rest, i, char) !== marker.length) {
      i += runLengthAt(rest, i, char) - 1
      continue
    }

    const before = rest[i - 1]
    if (before !== undefined && /\s/.test(before)) continue

    if (char === '_') {
      const after = rest[i + marker.length]
      if (after !== undefined && /[\w]/.test(after)) continue
    }

    return i
  }

  return -1
}

/** Length of the run of `char` starting at `index`. */
function runLengthAt(text: string, index: number, char: string): number {
  let length = 0
  while (text[index + length] === char) length += 1
  return length
}

/** Index of the next run of exactly `fence`, searching from `from`; -1 if absent. */
function findRun(text: string, fence: string, from: number): number {
  const char = fence[0] as string

  for (let i = from; i < text.length; i += 1) {
    if (text[i] !== char) continue
    const run = runLengthAt(text, i, char)
    if (run === fence.length) return i
    i += run - 1
  }

  return -1
}

/** Index of the bracket closing the one at `from - 1`, honouring nesting; -1 if absent. */
function findClosing(text: string, from: number, open: string, close: string): number {
  let depth = 1

  for (let i = from; i < text.length; i += 1) {
    if (text[i] === '\\') {
      i += 1
      continue
    }
    if (text[i] === open) depth += 1
    else if (text[i] === close) {
      depth -= 1
      if (depth === 0) return i
    }
  }

  return -1
}

/** CommonMark's code-span rule: one padding space on both sides is not content. */
function trimOneSpace(raw: string): string {
  if (raw.length > 1 && raw.startsWith(' ') && raw.endsWith(' ')) return raw.slice(1, -1)
  return raw
}

/** Whether a link target is one Telegram should be allowed to open. */
function isSafeHref(href: string): boolean {
  try {
    const scheme = new URL(href).protocol
    return SAFE_SCHEMES.some((allowed) => allowed === scheme)
  } catch {
    return false
  }
}
