import { describe, expect, it } from 'vitest'

import { splitHtml } from '../src/render/split.js'

/** Strip tags so a chunk set can be compared against the original text. */
function textOf(html: string): string {
  return html.replace(/<[^>]+>/g, '')
}

/** Every tag opened in a chunk must close inside that same chunk. */
function isBalanced(html: string): boolean {
  const stack: string[] = []
  for (const tag of html.matchAll(/<(\/?)([a-z-]+)(?: [^>]*)?>/g)) {
    if (tag[1] === '/') {
      if (stack.pop() !== tag[2]) return false
    } else {
      stack.push(tag[2] as string)
    }
  }
  return stack.length === 0
}

describe('splitHtml — when nothing needs splitting', () => {
  it('returns a short message as a single chunk', () => {
    expect(splitHtml('hello', 100)).toEqual(['hello'])
  })

  it('returns nothing for empty input', () => {
    expect(splitHtml('', 100)).toEqual([])
  })

  it('returns nothing for whitespace-only input', () => {
    expect(splitHtml('   \n  ', 100)).toEqual([])
  })

  it('keeps a message exactly at the limit whole', () => {
    const text = 'x'.repeat(50)
    expect(splitHtml(text, 50)).toEqual([text])
  })
})

describe('splitHtml — boundaries', () => {
  it('prefers to split on a blank line', () => {
    const html = `${'a'.repeat(30)}\n\n${'b'.repeat(30)}`
    expect(splitHtml(html, 40)).toEqual(['a'.repeat(30), 'b'.repeat(30)])
  })

  it('falls back to a line break when there is no blank line', () => {
    const html = `${'a'.repeat(30)}\n${'b'.repeat(30)}`
    expect(splitHtml(html, 40)).toEqual(['a'.repeat(30), 'b'.repeat(30)])
  })

  it('falls back to a space when there is no line break', () => {
    const html = `${'a'.repeat(30)} ${'b'.repeat(30)}`
    expect(splitHtml(html, 40)).toEqual(['a'.repeat(30), 'b'.repeat(30)])
  })

  it('hard-splits a single unbroken run that cannot fit', () => {
    const chunks = splitHtml('x'.repeat(100), 40)
    expect(chunks.every((chunk) => chunk.length <= 40)).toBe(true)
    expect(chunks.join('')).toBe('x'.repeat(100))
  })

  it('never exceeds the limit', () => {
    const html = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n')
    for (const chunk of splitHtml(html, 100)) expect(chunk.length).toBeLessThanOrEqual(100)
  })

  it('preserves all text across chunks', () => {
    const html = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n')
    const joined = splitHtml(html, 60).join('\n')
    expect(textOf(joined).replace(/\s+/g, ' ')).toBe(textOf(html).replace(/\s+/g, ' '))
  })
})

describe('splitHtml — tag safety', () => {
  it('never splits in the middle of a tag', () => {
    const html = `${'a'.repeat(35)}<b>${'c'.repeat(35)}</b>`
    for (const chunk of splitHtml(html, 40)) expect(chunk).not.toMatch(/<[^>]*$/)
  })

  it('closes an open tag at the chunk end and reopens it in the next chunk', () => {
    const html = `<b>${'a'.repeat(30)}\n${'b'.repeat(30)}</b>`
    const chunks = splitHtml(html, 45)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(isBalanced(chunk)).toBe(true)
    expect(chunks[1]).toMatch(/^<b>/)
  })

  it('reopens a pre block with its language class intact', () => {
    const code = Array.from({ length: 20 }, (_, i) => `const x${i} = ${i}`).join('\n')
    const html = `<pre><code class="language-js">${code}</code></pre>`
    const chunks = splitHtml(html, 120)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(isBalanced(chunk)).toBe(true)
    expect(chunks[1]).toContain('<code class="language-js">')
  })

  it('keeps every chunk balanced for deeply nested markup', () => {
    const html = `<blockquote><b><i>${'word '.repeat(80)}</i></b></blockquote>`
    for (const chunk of splitHtml(html, 100)) expect(isBalanced(chunk)).toBe(true)
  })

  it('never splits inside an html entity', () => {
    const html = `${'a'.repeat(38)}&amp;${'b'.repeat(38)}`
    for (const chunk of splitHtml(html, 40)) {
      expect(chunk).not.toMatch(/&[a-z]*$/)
      expect(chunk).not.toMatch(/^[a-z]*;/)
    }
  })
})
