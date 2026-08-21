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
  /** Cells of the rendered table, ignoring padding and the header rule. */
  function cellsOf(html: string): string[][] {
    return html
      .replace(/^<pre>|<\/pre>$/g, '')
      .split('\n')
      .filter((line) => !/^[─┼]+$/.test(line))
      .map((line) => line.split('|').map((cell) => cell.trim()))
  }

  it('renders a pipe table as aligned preformatted text', () => {
    const table = ['| a | bb |', '| --- | --- |', '| 1 | 2 |'].join('\n')
    expect(renderMarkdown(table)).toContain('<pre>')
    expect(cellsOf(renderMarkdown(table))).toEqual([
      ['a', 'bb'],
      ['1', '2'],
    ])
  })

  it('accepts a single-dash delimiter, which is valid and common', () => {
    // Models emit compact delimiters; requiring two dashes dropped these
    // tables back into flat text.
    const table = ['| a | b |', '| - | - |', '| 1 | 2 |'].join('\n')
    expect(renderMarkdown(table)).toContain('<pre>')
  })

  it('accepts alignment colons', () => {
    const table = ['| a | b |', '|:--|--:|', '| 1 | 2 |'].join('\n')
    expect(renderMarkdown(table)).toContain('<pre>')
  })

  it('accepts a table written without outer pipes', () => {
    const table = ['a | b', '--- | ---', '1 | 2'].join('\n')
    expect(cellsOf(renderMarkdown(table))).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  it('draws a rule under the header, the only cue it names the columns', () => {
    const table = ['| a | b |', '| - | - |', '| 1 | 2 |'].join('\n')
    expect(renderMarkdown(table)).toMatch(/\n[─┼]+\n/)
  })

  it('pads columns so they line up', () => {
    const table = ['| name | n |', '| - | - |', '| long-value | 2 |'].join('\n')
    const rows = renderMarkdown(table)
      .replace(/^<pre>|<\/pre>$/g, '')
      .split('\n')

    // The header rule joins with '┼' rather than '|', at the same width.
    const dataColumns = new Set(rows.filter((row) => row.includes('|')).map((row) => row.indexOf('|')))
    const ruleColumns = new Set(rows.filter((row) => row.includes('┼')).map((row) => row.indexOf('┼')))

    expect(dataColumns.size).toBe(1)
    expect([...ruleColumns]).toEqual([...dataColumns])
  })

  it('resolves inline markup in cells rather than showing its markers', () => {
    const table = ['| cmd | what |', '| - | - |', '| `ls` | **lists** files |'].join('\n')
    const html = renderMarkdown(table)
    expect(html).toContain('ls')
    expect(html).not.toContain('**')
    expect(html).not.toContain('`')
  })

  it('renders a table that follows a paragraph', () => {
    const md = ['Here it is:', '', '| a | b |', '| - | - |', '| 1 | 2 |'].join('\n')
    expect(renderMarkdown(md)).toContain('<pre>')
    expect(renderMarkdown(md)).toContain('Here it is:')
  })

  it('escapes html inside cells', () => {
    const table = ['| tag |', '| - |', '| <script> |'].join('\n')
    expect(renderMarkdown(table)).toContain('&lt;script&gt;')
  })

  it('does not read prose above a thematic break as a table', () => {
    // 'a | b' then '---' is a paragraph and a rule, not a one-column table.
    expect(renderMarkdown('a | b\n---')).not.toContain('<pre>')
  })

  it('does not read a delimiter of the wrong width as a table', () => {
    expect(renderMarkdown('| a | b |\n| - |\n| 1 | 2 |')).not.toContain('<pre>')
  })

  it('ends the table at the first line without a cell divider', () => {
    const md = ['| a | b |', '| - | - |', '| 1 | 2 |', '', 'after the table'].join('\n')
    const html = renderMarkdown(md)
    expect(html).toContain('after the table')
    expect(html.slice(html.indexOf('</pre>'))).toContain('after the table')
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
