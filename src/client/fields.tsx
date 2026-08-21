/**
 * The small set of controls this page is built from.
 *
 * Written from scratch rather than borrowed: the client bundle purity gate
 * forbids importing another plugin's card chrome as a value, so a plugin
 * shipped outside the harness repository owns its own controls. They are
 * deliberately plain, and they take their colours from the shell's theme
 * variables so the page follows light and dark without knowing which is on.
 */

import type { ReactNode } from 'react'

/** Shell theme tokens, with fallbacks for a shell that does not define them. */
const COLOR = {
  text: 'var(--dsw-alias-label-primary, currentColor)',
  muted: 'var(--dsw-alias-label-secondary, #6b7280)',
  faint: 'var(--dsw-alias-label-tertiary, #9ca3af)',
  border: 'var(--dsw-alias-border-l1, rgba(128,128,128,0.28))',
  borderStrong: 'var(--dsw-alias-border-l2, rgba(128,128,128,0.45))',
  surface: 'var(--dsw-alias-bg-layer-1, transparent)',
  accent: 'var(--dsw-alias-label-primary-bluish, #2563eb)',
  danger: 'var(--dsw-alias-state-error-primary, #dc2626)',
  success: 'var(--dsw-alias-state-success-primary, #16a34a)',
  warn: 'var(--dsw-alias-state-warn-primary, #d97706)',
} as const

/** A titled group of related settings. */
export function Section(props: { title: string; children: ReactNode }) {
  return (
    <section style={{ marginBottom: 28 }}>
      <h3
        style={{
          margin: '0 0 12px',
          fontSize: 13,
          fontWeight: 600,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
          color: COLOR.faint,
        }}
      >
        {props.title}
      </h3>
      <div
        style={{
          border: `1px solid ${COLOR.border}`,
          borderRadius: 10,
          background: COLOR.surface,
          overflow: 'hidden',
        }}
      >
        {props.children}
      </div>
    </section>
  )
}

/** One labelled setting: its control, its explanation, and its override state. */
export function Row(props: {
  label: string
  hint?: string
  /** Marks the value as user-changed and offers a way back to the composed one. */
  overridden?: boolean
  onReset?: () => void
  resetLabel?: string
  overriddenLabel?: string
  children: ReactNode
}) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 16,
        alignItems: 'flex-start',
        padding: '14px 16px',
        borderBottom: `1px solid ${COLOR.border}`,
      }}
    >
      <div style={{ flex: '1 1 auto', minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: COLOR.text, fontSize: 14 }}>
          <span>{props.label}</span>
          {props.overridden ? (
            <span
              style={{
                fontSize: 11,
                padding: '1px 6px',
                borderRadius: 999,
                color: COLOR.accent,
                border: `1px solid ${COLOR.accent}`,
                opacity: 0.85,
              }}
            >
              {props.overriddenLabel ?? 'changed'}
            </span>
          ) : null}
          {props.overridden && props.onReset ? (
            <button type="button" onClick={props.onReset} style={linkButtonStyle}>
              {props.resetLabel ?? 'Reset'}
            </button>
          ) : null}
        </div>
        {props.hint ? (
          <div style={{ marginTop: 4, fontSize: 12, lineHeight: 1.5, color: COLOR.muted }}>
            {props.hint}
          </div>
        ) : null}
      </div>
      <div style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 8 }}>
        {props.children}
      </div>
    </div>
  )
}

/** A single-line text input. */
export function TextInput(props: {
  value: string
  onChange: (value: string) => void
  onCommit?: () => void
  placeholder?: string
  disabled?: boolean
  type?: 'text' | 'password'
  width?: number
  invalid?: boolean
}) {
  return (
    <input
      type={props.type ?? 'text'}
      value={props.value}
      placeholder={props.placeholder ?? ''}
      disabled={props.disabled ?? false}
      onChange={(event) => props.onChange(event.target.value)}
      onBlur={props.onCommit ?? (() => undefined)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') props.onCommit?.()
      }}
      style={{
        width: props.width ?? 220,
        padding: '6px 10px',
        fontSize: 13,
        color: COLOR.text,
        background: 'transparent',
        border: `1px solid ${props.invalid ? COLOR.danger : COLOR.borderStrong}`,
        borderRadius: 6,
        outline: 'none',
        opacity: props.disabled ? 0.5 : 1,
      }}
    />
  )
}

/** A numeric input that only reports whole, finite values. */
export function NumberInput(props: {
  value: number
  onCommit: (value: number) => void
  disabled?: boolean
  min?: number
}) {
  return (
    <input
      type="number"
      defaultValue={String(props.value)}
      disabled={props.disabled ?? false}
      min={props.min ?? 0}
      key={props.value}
      onBlur={(event) => {
        const next = Number(event.target.value)
        if (Number.isFinite(next) && Number.isInteger(next) && next >= (props.min ?? 0)) {
          if (next !== props.value) props.onCommit(next)
        }
      }}
      style={{
        width: 110,
        padding: '6px 10px',
        fontSize: 13,
        color: COLOR.text,
        background: 'transparent',
        border: `1px solid ${COLOR.borderStrong}`,
        borderRadius: 6,
        outline: 'none',
        opacity: props.disabled ? 0.5 : 1,
      }}
    />
  )
}

/** An on/off switch. */
export function Toggle(props: { checked: boolean; onChange: (next: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      disabled={props.disabled ?? false}
      onClick={() => props.onChange(!props.checked)}
      style={{
        width: 40,
        height: 22,
        padding: 2,
        borderRadius: 999,
        border: `1px solid ${COLOR.borderStrong}`,
        background: props.checked ? COLOR.accent : 'transparent',
        cursor: props.disabled ? 'default' : 'pointer',
        opacity: props.disabled ? 0.5 : 1,
        transition: 'background 120ms ease',
      }}
    >
      <span
        style={{
          display: 'block',
          width: 16,
          height: 16,
          borderRadius: '50%',
          background: props.checked ? '#fff' : COLOR.faint,
          transform: props.checked ? 'translateX(18px)' : 'translateX(0)',
          transition: 'transform 120ms ease',
        }}
      />
    </button>
  )
}

/** A push button for an action that is not a preference. */
export function Button(props: {
  children: ReactNode
  onClick: () => void
  disabled?: boolean
  tone?: 'default' | 'danger'
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled ?? false}
      style={{
        padding: '6px 12px',
        fontSize: 13,
        color: props.tone === 'danger' ? COLOR.danger : COLOR.text,
        background: 'transparent',
        border: `1px solid ${props.tone === 'danger' ? COLOR.danger : COLOR.borderStrong}`,
        borderRadius: 6,
        cursor: props.disabled ? 'default' : 'pointer',
        opacity: props.disabled ? 0.45 : 1,
      }}
    >
      {props.children}
    </button>
  )
}

/** A short status line: a fact about the world rather than a setting. */
export function Note(props: { tone: 'info' | 'good' | 'warn' | 'bad'; children: ReactNode }) {
  const color =
    props.tone === 'good'
      ? COLOR.success
      : props.tone === 'warn'
        ? COLOR.warn
        : props.tone === 'bad'
          ? COLOR.danger
          : COLOR.muted

  return <div style={{ fontSize: 12, lineHeight: 1.6, color }}>{props.children}</div>
}

export { COLOR }

/** Shared style for the inline reset affordance. */
const linkButtonStyle = {
  padding: 0,
  fontSize: 11,
  color: COLOR.muted,
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  textDecoration: 'underline',
} as const
