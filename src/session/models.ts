/**
 * Choosing which model a Telegram conversation talks to.
 *
 * The web UI has a model picker; a phone had nothing, so every conversation
 * ran on whatever the deployment happened to default to. That is the wrong
 * place to be stuck: the reason to reach for a bot from a phone is often that
 * the question is small and a cheaper model would do, or that it is hard and a
 * better one is worth the wait.
 *
 * The choice is per conversation and durable, so it survives `/new` and a
 * restart. It is applied per turn rather than at session creation, because the
 * harness reads a mutable selection while assembling each step — which is what
 * lets a model change take effect on the very next message.
 */

import type { ModelRoute } from '../harness/model-selection.js'
import { parseRoute } from '../harness/model-selection.js'

/** One model a provider advertises. */
export interface CatalogModel {
  readonly id: string
  readonly name?: string
}

/** One configured provider and what it offers. */
export interface CatalogProvider {
  readonly id: string
  readonly name?: string
  readonly models: readonly CatalogModel[]
}

/** The `ctx.llm` surface this needs. */
export interface ProviderCatalog {
  listProviders(): readonly { id: string; name?: string }[]
  listModels(provider: string): Promise<readonly CatalogModel[]>
}

/**
 * Every configured provider with its models, for a message that lists them.
 *
 * A provider whose catalog cannot be read is skipped rather than failing the
 * listing: one misconfigured key should not hide every other model.
 *
 * @param catalog - the harness llm service.
 */
export async function listCatalog(catalog: ProviderCatalog): Promise<CatalogProvider[]> {
  const providers = catalog.listProviders()

  const groups = await Promise.all(
    providers.map(async (provider) => {
      try {
        const models = await catalog.listModels(provider.id)
        return { id: provider.id, ...(provider.name ? { name: provider.name } : {}), models }
      } catch {
        return undefined
      }
    }),
  )

  return groups.filter((group): group is CatalogProvider => group !== undefined && group.models.length > 0)
}

/**
 * Find the route a user's words name.
 *
 * Accepts the full `provider/model`, and a bare model id when exactly one
 * provider offers it — which is what anyone types first, and is unambiguous
 * often enough to be worth supporting. A bare id offered by several providers
 * is reported as ambiguous rather than guessed at.
 *
 * @param input - what followed `/model`.
 * @param providers - the configured catalog.
 */
export function matchRoute(
  input: string,
  providers: readonly CatalogProvider[],
):
  | { readonly kind: 'route'; readonly route: ModelRoute }
  | { readonly kind: 'ambiguous'; readonly candidates: readonly string[] }
  | { readonly kind: 'unknown' } {
  const wanted = input.trim()
  if (wanted === '') return { kind: 'unknown' }

  const qualified = parseRoute(wanted)
  if (qualified) {
    const provider = providers.find((entry) => entry.id === qualified.provider)
    const known = provider?.models.some((model) => model.id === qualified.model)
    // An unlisted route is still taken when its provider is configured: a
    // catalog can lag behind a model the provider actually serves, and
    // refusing would make this stricter than the web UI's own picker.
    if (provider) return { kind: 'route', route: qualified }
    if (known) return { kind: 'route', route: qualified }
  }

  const matches = providers.flatMap((provider) =>
    provider.models
      .filter((model) => model.id.toLowerCase() === wanted.toLowerCase())
      .map((model) => `${provider.id}/${model.id}`),
  )

  if (matches.length === 1) {
    const route = parseRoute(matches[0] as string)
    if (route) return { kind: 'route', route }
  }
  if (matches.length > 1) return { kind: 'ambiguous', candidates: matches }

  return { kind: 'unknown' }
}

/** Render a route the way it is typed back in. */
export function formatRoute(route: ModelRoute | undefined): string {
  return route === undefined ? 'the deployment default' : `${route.provider}/${route.model}`
}
