/**
 * Building the user message the agent's inbox accepts.
 *
 * `agent.followup()` takes an identified, frozen `UserMessage`, and the
 * harness's own factory (`createUserMessage` in `@deepseek-ai/dsh-llm`) is the
 * only thing that should decide what "identified and frozen" means — it may
 * gain validation or a different id scheme in any release.
 *
 * That package is provided by the harness at runtime, not by this plugin, so
 * it is imported dynamically rather than depended on at build time. Pinning a
 * version here would mean shipping types for a package the host already owns,
 * and mismatching it on every harness upgrade.
 *
 * The fallback exists so the plugin still loads against a harness that moved
 * the factory: the shape it produces is the documented one.
 */

import { randomUUID } from 'node:crypto'

/** One block of model-visible content. */
export type ContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly attachment: unknown }

/** The message shape `agent.followup()` accepts. */
export interface UserMessageLike {
  readonly id: string
  readonly role: 'user'
  readonly content: readonly ContentBlock[]
  readonly source: { readonly kind: 'user' }
}

/**
 * Builds one user message from content blocks.
 *
 * Blocks rather than a string because a prompt may carry an image: the model
 * sees `{ type: 'image', attachment }` beside the text, which is how a
 * screenshot becomes something it can actually look at.
 */
export type MessageFactory = (content: readonly ContentBlock[]) => UserMessageLike

/** Shape of the harness module we borrow the factory from. */
interface LlmModule {
  createUserMessage?: (input: unknown) => unknown
}

/**
 * Resolve the message factory, preferring the harness's own.
 *
 * @returns a factory that turns prompt text into a user message.
 */
export async function resolveMessageFactory(): Promise<MessageFactory> {
  try {
    // A variable specifier: the module is the host's to provide, so it must
    // not be resolved — or required — at build time.
    const specifier = '@deepseek-ai/dsh-llm'
    const llm = (await import(specifier)) as LlmModule
    const create = llm.createUserMessage
    if (typeof create === 'function') {
      return (content) =>
        create({
          content: [...content],
          source: { kind: 'user' },
        }) as UserMessageLike
    }
  } catch {
    // The harness did not provide it; the documented shape below still works.
  }

  return fallbackMessage
}

/** The documented user-message shape, built without the harness factory. */
export function fallbackMessage(content: readonly ContentBlock[]): UserMessageLike {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze(content.map((block) => Object.freeze({ ...block }))),
    source: Object.freeze({ kind: 'user' as const }),
  })
}
