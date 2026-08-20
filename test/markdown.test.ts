import { describe, expect, it } from 'vitest'

import { renderMarkdown } from '../src/render/markdown.js'

describe('renderMarkdown — code blocks', () => {
  it('renders a fenced block with its language', () => {
    expect(renderMarkdown('```python\nprint("hi")\n```')).toBe(
      '<pre><code class="language-python">print("hi")</code></pre>',
    )
  })

  it('renders a fenced block without a language', () => {
    expect(renderMarkdown('```\nplain\n```')).toBe('<pre>plain</pre>')
  })

  it('escapes html inside a fenced block', () => {
    expect(renderMarkdown('```\n<div> & </div>\n```')).toBe(
      '<pre>&lt;div&gt; &amp; &lt;/div&gt;</pre>',
    )
  })

  it('leaves markdown inside a fenced block literal', () => {
    expect(renderMarkdown('```\n**not bold**\n```')).toBe('<pre>**not bold**</pre>')
  })

  it('closes an unterminated fence so a mid-stream chunk still parses', () => {
    expect(renderMarkdown('```js\nlet a = 1')).toBe(
      '<pre><code class="language-js">let a = 1</code></pre>',
    )
  })

  it('supports tilde fences', () => {
    expect(renderMarkdown('~~~\ncode\n~~~')).toBe('<pre>code</pre>')
  })
})

describe('renderMarkdown — headings', () => {
  it('renders a heading as bold, since Telegram has no headings', () => {
    expect(renderMarkdown('# Title')).toBe('<b>Title</b>')
  })

  it('renders deeper headings as bold too', () => {
    expect(renderMarkdown('### Sub')).toBe('<b>Sub</b>')
  })

  it('does not treat a hash inside text as a heading', () => {
    expect(renderMarkdown('issue #42 filed')).toBe('issue #42 filed')
  })
})

describe('renderMarkdown — lists', () => {
  it('renders a dash bullet with a real bullet character', () => {
    expect(renderMarkdown('- one\n- two')).toBe('• one\n• two')
  })

  it('renders asterisk bullets without mistaking them for italics', () => {
    expect(renderMarkdown('* one\n* two')).toBe('• one\n• two')
  })

  it('keeps ordered list numbering', () => {
    expect(renderMarkdown('1. first\n2. second')).toBe('1. first\n2. second')
  })

  it('indents nested bullets', () => {
    expect(renderMarkdown('- top\n  - nested')).toBe('• top\n  ◦ nested')
  })

  it('renders inline markup inside a list item', () => {
    expect(renderMarkdown('- **bold** item')).toBe('• <b>bold</b> item')
  })
})

describe('renderMarkdown — quotes and rules', () => {
  it('renders a blockquote', () => {
    expect(renderMarkdown('> quoted')).toBe('<blockquote>quoted</blockquote>')
  })

  it('merges consecutive quote lines into one blockquote', () => {
    expect(renderMarkdown('> a\n> b')).toBe('<blockquote>a\nb</blockquote>')
  })

  it('renders a horizontal rule as a line of dashes', () => {
    expect(renderMarkdown('---')).toBe('──────────')
  })
})

describe('renderMarkdown — tables', () => {
  it('renders a pipe table as aligned preformatted text', () => {
    const table = ['| a | bb |', '| --- | --- |', '| 1 | 2 |'].join('\n')
    expect(renderMarkdown(table)).toBe('<pre>a | bb\n1 | 2</pre>')
  })
})

describe('renderMarkdown — document shape', () => {
  it('keeps blank lines between paragraphs', () => {
    expect(renderMarkdown('one\n\ntwo')).toBe('one\n\ntwo')
  })

  it('collapses more than one blank line to a single gap', () => {
    expect(renderMarkdown('one\n\n\n\ntwo')).toBe('one\n\ntwo')
  })

  it('trims trailing whitespace from the document', () => {
    expect(renderMarkdown('text\n\n\n')).toBe('text')
  })

  it('handles an empty document', () => {
    expect(renderMarkdown('')).toBe('')
  })

  it('renders a realistic mixed answer', () => {
    const md = ['## Result', '', 'Run `pnpm test`:', '', '```sh', 'pnpm test', '```', '', '- **pass**: 12', '- fail: 0'].join('\n')
    expect(renderMarkdown(md)).toBe(
      [
        '<b>Result</b>',
        '',
        'Run <code>pnpm test</code>:',
        '',
        '<pre><code class="language-sh">pnpm test</code></pre>',
        '',
        '• <b>pass</b>: 12',
        '• fail: 0',
      ].join('\n'),
    )
  })
})
