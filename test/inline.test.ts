import { describe, expect, it } from 'vitest'

import { renderInline } from '../src/render/inline.js'

describe('renderInline — emphasis', () => {
  it('renders ** as bold', () => {
    expect(renderInline('a **bold** b')).toBe('a <b>bold</b> b')
  })

  it('renders __ as bold', () => {
    expect(renderInline('a __bold__ b')).toBe('a <b>bold</b> b')
  })

  it('renders single * as italic', () => {
    expect(renderInline('a *it* b')).toBe('a <i>it</i> b')
  })

  it('renders single _ as italic', () => {
    expect(renderInline('a _it_ b')).toBe('a <i>it</i> b')
  })

  it('renders ~~ as strikethrough', () => {
    expect(renderInline('a ~~gone~~ b')).toBe('a <s>gone</s> b')
  })

  it('renders || as spoiler', () => {
    expect(renderInline('a ||secret|| b')).toBe('a <tg-spoiler>secret</tg-spoiler> b')
  })

  it('nests bold inside italic', () => {
    expect(renderInline('*a **b** c*')).toBe('<i>a <b>b</b> c</i>')
  })

  it('does not treat intra-word underscores as emphasis', () => {
    expect(renderInline('snake_case_name')).toBe('snake_case_name')
  })

  it('does not treat a lone asterisk as emphasis', () => {
    expect(renderInline('2 * 3 = 6')).toBe('2 * 3 = 6')
  })
})

describe('renderInline — code spans', () => {
  it('renders backticks as code', () => {
    expect(renderInline('run `npm test` now')).toBe('run <code>npm test</code> now')
  })

  it('escapes html inside code', () => {
    expect(renderInline('`a < b && c > d`')).toBe('<code>a &lt; b &amp;&amp; c &gt; d</code>')
  })

  it('suppresses markdown inside code spans', () => {
    expect(renderInline('`**not bold**`')).toBe('<code>**not bold**</code>')
  })

  it('supports double-backtick spans containing a backtick', () => {
    expect(renderInline('`` a ` b ``')).toBe('<code>a ` b</code>')
  })
})

describe('renderInline — links', () => {
  it('renders a markdown link', () => {
    expect(renderInline('see [docs](https://x.dev)')).toBe('see <a href="https://x.dev">docs</a>')
  })

  it('escapes the href', () => {
    expect(renderInline('[q](https://x.dev/?a=1&b=2)')).toBe(
      '<a href="https://x.dev/?a=1&amp;b=2">q</a>',
    )
  })

  it('renders emphasis inside link text', () => {
    expect(renderInline('[**bold**](https://x.dev)')).toBe(
      '<a href="https://x.dev"><b>bold</b></a>',
    )
  })

  it('renders an image as a link to its source', () => {
    expect(renderInline('![alt text](https://x.dev/i.png)')).toBe(
      '<a href="https://x.dev/i.png">alt text</a>',
    )
  })

  it('drops javascript: hrefs but keeps the text', () => {
    expect(renderInline('[click](javascript:alert(1))')).toBe('click')
  })

  it('leaves a bare url alone for Telegram to autolink', () => {
    expect(renderInline('go to https://x.dev now')).toBe('go to https://x.dev now')
  })
})

describe('renderInline — escaping and safety', () => {
  it('escapes html in plain text', () => {
    expect(renderInline('use <script> tags')).toBe('use &lt;script&gt; tags')
  })

  it('honours backslash escapes', () => {
    expect(renderInline('literal \\*stars\\*')).toBe('literal *stars*')
  })

  it('auto-closes an unterminated bold run so streaming output stays valid', () => {
    expect(renderInline('a **bold')).toBe('a <b>bold</b>')
  })

  it('auto-closes an unterminated code span', () => {
    expect(renderInline('a `code')).toBe('a <code>code</code>')
  })

  it('never emits an unbalanced tag for arbitrary marker soup', () => {
    const out = renderInline('**a *b `c ~~d ||e [f](g')
    expect(countTag(out, 'b')).toBe(0)
    expect(countTag(out, 'i')).toBe(0)
    expect(countTag(out, 'code')).toBe(0)
  })
})

/** Difference between opening and closing tags of one name; 0 means balanced. */
function countTag(html: string, tag: string): number {
  const open = html.match(new RegExp(`<${tag}(?: [^>]*)?>`, 'g'))?.length ?? 0
  const close = html.match(new RegExp(`</${tag}>`, 'g'))?.length ?? 0
  return open - close
}
