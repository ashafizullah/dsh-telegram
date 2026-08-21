import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import { FILL, TEXT, Toggle } from '../src/client/fields.js'

/**
 * A React element is a plain object, so a component's rendered style can be
 * read by calling it — no DOM, no renderer. That is enough to catch the class
 * of bug these tests exist for: a control that looks right in one theme and
 * disappears in the other.
 */
function styleOf(element: unknown): Record<string, unknown> {
  return (element as { props: { style: Record<string, unknown> } }).props.style
}

/** The knob is the switch's only child. */
function knobStyle(element: unknown): Record<string, unknown> {
  const children = (element as { props: { children: unknown } }).props.children
  return styleOf(children)
}

describe('Toggle — the track', () => {
  it('paints a real fill when on', () => {
    const track = styleOf(Toggle({ checked: true, onChange: () => undefined }))
    expect(track.background).toBe(FILL.brand)
  })

  it('paints a real fill when off, so the knob never floats on the page', () => {
    const track = styleOf(Toggle({ checked: false, onChange: () => undefined }))
    expect(track.background).toBe(FILL.neutral)
  })

  it('looks different on than off', () => {
    const on = styleOf(Toggle({ checked: true, onChange: () => undefined }))
    const off = styleOf(Toggle({ checked: false, onChange: () => undefined }))
    expect(on.background).not.toBe(off.background)
  })

  it('never paints itself with a foreground token', () => {
    // A `label-` token is near-white in the dark theme: the exact bug this
    // guards. On plus a white knob produced a blank white pill.
    for (const checked of [true, false]) {
      const track = styleOf(Toggle({ checked, onChange: () => undefined }))
      expect(String(track.background)).not.toContain('label-')
    }
  })

  it('measures its own box, so the knob travel is exact', () => {
    const track = styleOf(Toggle({ checked: true, onChange: () => undefined }))
    expect(track.boxSizing).toBe('border-box')

    const width = Number(track.width)
    const padding = Number(track.padding)
    // border-box counts the border too, so the content box is narrower still.
    const border = Number(String(track.border).replace(/[^0-9.].*$/, ''))
    const content = width - border * 2 - padding * 2

    const knob = knobStyle(Toggle({ checked: true, onChange: () => undefined }))
    const travel = Number(String(knob.transform).replace(/[^0-9.-]/g, ''))

    // Content box width minus knob width: the knob lands flush at both ends.
    expect(travel).toBe(content - Number(knob.width))
  })
})

describe('Toggle — the knob', () => {
  it('carries an edge, so it stays visible on a pale track', () => {
    const knob = knobStyle(Toggle({ checked: true, onChange: () => undefined }))
    expect(knob.border).toBeTruthy()
  })

  it('sits at the start when off and travels when on', () => {
    const off = knobStyle(Toggle({ checked: false, onChange: () => undefined }))
    const on = knobStyle(Toggle({ checked: true, onChange: () => undefined }))
    expect(off.transform).toBe('translateX(0)')
    expect(on.transform).not.toBe('translateX(0)')
  })

  it('keeps its edge inside its own box, so it is not oversized', () => {
    const knob = knobStyle(Toggle({ checked: true, onChange: () => undefined }))
    expect(knob.boxSizing).toBe('border-box')
  })
})

describe('Toggle — accessibility', () => {
  it('reports its state to assistive technology', () => {
    const element = Toggle({ checked: true, onChange: () => undefined }) as {
      props: Record<string, unknown>
    }
    expect(element.props.role).toBe('switch')
    expect(element.props['aria-checked']).toBe(true)
  })
})

describe('theme tokens', () => {
  it('keeps foreground and fill tokens apart', () => {
    for (const token of Object.values(TEXT)) expect(token).toContain('label-')
    for (const token of Object.values(FILL)) expect(token).not.toContain('label-')
  })

  it('paints no surface anywhere in the page with a foreground token', async () => {
    // The whole class of bug, caught across every control at once.
    const sources = await Promise.all(
      ['src/client/fields.tsx', 'src/client/panel.tsx'].map((file) => readFile(file, 'utf8')),
    )

    for (const source of sources) {
      for (const match of source.matchAll(/background(?:Color)?:\s*([^\n,]+)/g)) {
        expect(match[1], `background bound to a foreground token: ${match[1]}`).not.toContain(
          'label-',
        )
      }
    }
  })

  it('gives every token a fallback, for a shell that defines none', () => {
    for (const token of [...Object.values(TEXT), ...Object.values(FILL)]) {
      expect(token, token).toMatch(/^var\(--dsw-[a-z0-9-]+,\s*.+\)$/)
    }
  })
})
