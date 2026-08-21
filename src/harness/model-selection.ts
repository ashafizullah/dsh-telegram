/**
 * Changing which model a live agent's next step runs on.
 *
 * The harness holds one mutable selection object per agent, installed while
 * the agent is still unpublished, and reads `current` each time it assembles a
 * prompt. Mutating that object is how the web UI's model picker changes a
 * running session's model, and it is what lets a single turn — the one
 * carrying an image — run somewhere its neighbours do not.
 *
 * `current: undefined` means "no override", so the agent falls back to the
 * route it was created with. That is what makes reverting free: there is
 * nothing to restore, only an override to drop.
 *
 * Imported dynamically for the same reason as the message factory: the module
 * belongs to the host, not to this plugin, and pinning it here would mean
 * shipping a version the deployment has no say over.
 */

/** A provider and model an agent's next step should use. */
export interface ModelRoute {
  readonly provider: string
  readonly model: string
}

/** The object the harness reads before each prompt assembly. */
export interface MutableSelection {
  /** The override in force, or undefined to use the agent's own route. */
  current?: ModelRoute | undefined
  /** Written by the harness; the selection it last assembled with. */
  assembled?: unknown
}

/** Installs a selection into an unpublished agent's scope. */
export type SelectionInstaller = (agentCtx: unknown, selection: MutableSelection) => void

/** Shape of the harness module this borrows from. */
interface AgentModule {
  installModelSelection?: (agentCtx: unknown, selection: MutableSelection) => unknown
}

/**
 * Resolve the installer, or undefined when the harness does not offer it.
 *
 * A deployment without it simply cannot switch a live agent's model; the
 * plugin then keeps every turn on the session's own route rather than
 * pretending to have switched.
 */
export async function resolveSelectionInstaller(): Promise<SelectionInstaller | undefined> {
  try {
    // A variable specifier: the module is the host's to provide, so it must
    // not be resolved — or required — at build time.
    const specifier = '@deepseek-ai/dsh-agent'
    const agent = (await import(specifier)) as AgentModule
    const install = agent.installModelSelection
    if (typeof install !== 'function') return undefined
    return (agentCtx, selection) => void install(agentCtx, selection)
  } catch {
    return undefined
  }
}

/** Whether two routes name the same model. */
export function sameRoute(a: ModelRoute | undefined, b: ModelRoute | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  return a.provider === b.provider && a.model === b.model
}

/**
 * Parse a `provider/model` setting.
 *
 * A model id may itself contain slashes — `openai/gpt-5` on a router-style
 * provider is ordinary — so only the first separator divides them.
 *
 * @param value - the configured string; empty means no vision model.
 * @returns the route, or undefined when unset or malformed.
 */
export function parseRoute(value: string | undefined): ModelRoute | undefined {
  const trimmed = value?.trim()
  if (!trimmed) return undefined

  const separator = trimmed.indexOf('/')
  if (separator <= 0 || separator === trimmed.length - 1) return undefined

  return {
    provider: trimmed.slice(0, separator),
    model: trimmed.slice(separator + 1),
  }
}
