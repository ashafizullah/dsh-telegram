/**
 * Block-level markdown → Telegram HTML.
 *
 * Telegram's HTML mode has no headings, no lists, no tables and no nesting of
 * block elements. So the job here is not "render markdown" but "decide what
 * each block should LOOK like once those features are gone": headings become
 * bold lines, bullets become real bullet characters, and a table becomes
 * aligned preformatted text — which is the only way a table stays readable in
 * a chat bubble.
 *
 * Like the inline parser, every construct closes itself at end of input, so a
 * mid-stream prefix renders as valid HTML.
 */

import { escapeHtml } from './escape.js'
import { renderInline } from './inline.js'
import { htmlToPlain } from './plain.js'

/** Bullet glyphs by nesting depth; deeper levels reuse the last one. */
const BULLETS = ['•', '◦', '▪'] as const

/** Width of the rule drawn for a markdown thematic break. */
const RULE_WIDTH = 10

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)/
const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/
const RULE = /^\s{0,3}([-*_])\s*(?:\1\s*){2,}$/
const QUOTE = /^\s{0,3}>\s?(.*)$/
const BULLET = /^(\s*)[-*+]\s+(.*)$/
const ORDERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/
/** One delimiter cell: dashes, optionally anchored by alignment colons. */
const TABLE_DIVIDER_CELL = /^:?-+:?$/

/**
 * Render a markdown document as Telegram HTML.
 *
 * @param markdown - the agent's markdown, possibly a truncated stream prefix.
 * @returns Telegram-HTML safe to send with `parse_mode: "HTML"`.
 */
export function renderMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const blocks: string[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index] as string

    const fence = FENCE.exec(line)
    if (fence) {
      const block = readFence(lines, index, fence[1] as string, fence[2] ?? '')
      blocks.push(block.html)
      index = block.next
      continue
    }

    if (isTableStart(lines, index)) {
      const table = readTable(lines, index)
      blocks.push(table.html)
      index = table.next
      continue
    }

    if (QUOTE.test(line)) {
      const quote = readQuote(lines, index)
      blocks.push(quote.html)
      index = quote.next
      continue
    }

    blocks.push(renderLine(line))
    index += 1
  }

  return tidy(blocks.join('\n'))
}

/** One block's HTML plus the line index to continue from. */
interface Block {
  readonly html: string
  readonly next: number
}

/**
 * Read a fenced code block. Content is verbatim: escaped, never inline-parsed.
 * An unterminated fence consumes the rest of the document, which is exactly
 * what a stream that stopped inside a code block should produce.
 */
function readFence(lines: readonly string[], start: number, fence: string, language: string): Block {
  const char = fence[0] as string
  const body: string[] = []
  let index = start + 1

  while (index < lines.length) {
    const line = lines[index] as string
    const closing = new RegExp(`^\\s{0,3}${char === '`' ? '`' : '~'}{${fence.length},}\\s*$`)
    if (closing.test(line)) {
      index += 1
      break
    }
    body.push(line)
    index += 1
  }

  const code = escapeHtml(body.join('\n'))
  const html = language
    ? `<pre><code class="language-${escapeHtml(language)}">${code}</code></pre>`
    : `<pre>${code}</pre>`

  return { html, next: index }
}

/**
 * Whether a table starts at `start`.
 *
 * GFM's own rule, rather than a shape guess: a header row, then a delimiter
 * row of the same width whose every cell is dashes with optional alignment
 * colons. Both rows must contain a pipe, which is what keeps ordinary prose
 * followed by a thematic break from reading as a table.
 *
 * Outer pipes are optional and a single dash is a valid delimiter — both are
 * ordinary in model output, and requiring otherwise silently dropped tables
 * back into flat text.
 */
function isTableStart(lines: readonly string[], start: number): boolean {
  const header = lines[start]
  const divider = lines[start + 1]
  if (header === undefined || divider === undefined) return false
  if (!isTableRow(header) || !isTableRow(divider)) return false

  const cells = splitRow(divider)
  if (cells.length !== splitRow(header).length) return false

  return cells.every((cell) => TABLE_DIVIDER_CELL.test(cell))
}

/** A line participates in a table when it carries at least one cell divider. */
function isTableRow(line: string): boolean {
  return line.includes('|')
}

/**
 * Read a pipe table and lay it out as aligned preformatted text. Telegram has
 * no table element, and a plain-text table without alignment is unreadable —
 * `<pre>` is the only block that preserves the columns.
 */
function readTable(lines: readonly string[], start: number): Block {
  const rows: string[][] = []
  let index = start

  while (index < lines.length && isTableRow(lines[index] as string)) {
    // The delimiter row carries no content; it becomes the rule drawn below.
    if (index !== start + 1) rows.push(splitRow(lines[index] as string).map(plainCell))
    index += 1
  }

  const widths: number[] = []
  for (const row of rows) {
    row.forEach((cell, column) => {
      widths[column] = Math.max(widths[column] ?? 0, cell.length)
    })
  }

  const render = (row: readonly string[]) =>
    row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join(' | ').trimEnd()

  const [header, ...body] = rows
  const lines_: string[] = []
  if (header) {
    lines_.push(render(header))
    // Without a rule the header is just another row, and a table read in a
    // chat bubble has no other cue that its first line names the columns.
    lines_.push(widths.map((width) => '─'.repeat(width)).join('─┼─'))
  }
  for (const row of body) lines_.push(render(row))

  return { html: `<pre>${escapeHtml(lines_.join('\n'))}</pre>`, next: index }
}

/** Split one row into trimmed cells, dropping the optional edge pipes. */
function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

/**
 * Cell text with its inline markdown resolved away.
 *
 * A preformatted block cannot carry nested formatting, so leaving the markers
 * in place shows the reader `**lists**` where the model meant emphasis. Running
 * the existing inline renderer and stripping the tags back off reuses one
 * tested parser instead of a second, weaker one.
 */
function plainCell(cell: string): string {
  return htmlToPlain(renderInline(cell))
}

/**
 * Read consecutive `>` lines as one blockquote. Telegram does not nest block
 * elements, so nested quote markers collapse into the same quote.
 */
function readQuote(lines: readonly string[], start: number): Block {
  const body: string[] = []
  let index = start

  while (index < lines.length) {
    const match = QUOTE.exec(lines[index] as string)
    if (!match) break
    body.push(renderInline(stripQuoteMarkers(match[1] as string)))
    index += 1
  }

  return { html: `<blockquote>${body.join('\n')}</blockquote>`, next: index }
}

/** Remove any further `>` markers from a nested quote line. */
function stripQuoteMarkers(text: string): string {
  let stripped = text
  let match = QUOTE.exec(stripped)
  while (match) {
    stripped = match[1] as string
    match = QUOTE.exec(stripped)
  }
  return stripped
}

/** Render one ordinary line: heading, rule, list item, or plain inline text. */
function renderLine(line: string): string {
  if (line.trim() === '') return ''

  const rule = RULE.exec(line)
  if (rule) return '─'.repeat(RULE_WIDTH)

  const heading = HEADING.exec(line)
  if (heading) return `<b>${renderInline((heading[2] as string).trim())}</b>`

  const bullet = BULLET.exec(line)
  if (bullet) {
    const depth = Math.floor((bullet[1] as string).replace(/\t/g, '  ').length / 2)
    const glyph = BULLETS[Math.min(depth, BULLETS.length - 1)] as string
    return `${'  '.repeat(depth)}${glyph} ${renderInline(bullet[2] as string)}`
  }

  const ordered = ORDERED.exec(line)
  if (ordered) {
    const depth = Math.floor((ordered[1] as string).replace(/\t/g, '  ').length / 2)
    return `${'  '.repeat(depth)}${ordered[2]}. ${renderInline(ordered[3] as string)}`
  }

  return renderInline(line)
}

/** Collapse runs of blank lines to a single gap and trim the document edges. */
function tidy(html: string): string {
  return html.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\s+$/, '')
}
