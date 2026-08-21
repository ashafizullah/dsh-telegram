import { describe, expect, it } from 'vitest'

import { formatRoute, listCatalog, matchRoute } from '../src/session/models.js'
import type { CatalogProvider } from '../src/session/models.js'

const CATALOG: CatalogProvider[] = [
  {
    id: 'deepseek-official',
    name: 'DeepSeek',
    models: [{ id: 'deepseek-v4-flash' }, { id: 'deepseek-v4-pro' }],
  },
  { id: 'xiaomi', models: [{ id: 'mimo-v2.5' }, { id: 'deepseek-v4-pro' }] },
]

/** A catalog service, optionally with one provider that cannot be read. */
function catalog(options: { broken?: string; empty?: string } = {}) {
  return {
    listProviders: () => CATALOG.map(({ id, name }) => ({ id, ...(name ? { name } : {}) })),
    async listModels(provider: string) {
      if (provider === options.broken) throw new Error('no api key')
      if (provider === options.empty) return []
      return CATALOG.find((entry) => entry.id === provider)?.models ?? []
    },
  }
}

describe('listCatalog', () => {
  it('lists every configured provider with its models', async () => {
    const listed = await listCatalog(catalog())
    expect(listed.map((entry) => entry.id)).toEqual(['deepseek-official', 'xiaomi'])
  })

  it('skips a provider whose catalog cannot be read', async () => {
    // One bad key should not hide every other model.
    const listed = await listCatalog(catalog({ broken: 'xiaomi' }))
    expect(listed.map((entry) => entry.id)).toEqual(['deepseek-official'])
  })

  it('drops a provider that advertises nothing', async () => {
    const listed = await listCatalog(catalog({ empty: 'xiaomi' }))
    expect(listed.map((entry) => entry.id)).toEqual(['deepseek-official'])
  })
})

describe('matchRoute — what a user types', () => {
  it('takes a fully qualified route', () => {
    expect(matchRoute('xiaomi/mimo-v2.5', CATALOG)).toEqual({
      kind: 'route',
      route: { provider: 'xiaomi', model: 'mimo-v2.5' },
    })
  })

  it('takes a bare model id when only one provider offers it', () => {
    // What anyone types first, and unambiguous often enough to support.
    expect(matchRoute('mimo-v2.5', CATALOG)).toEqual({
      kind: 'route',
      route: { provider: 'xiaomi', model: 'mimo-v2.5' },
    })
  })

  it('matches a bare id regardless of case', () => {
    expect(matchRoute('MiMo-v2.5', CATALOG)).toMatchObject({ kind: 'route' })
  })

  it('refuses to guess when several providers offer the same id', () => {
    const matched = matchRoute('deepseek-v4-pro', CATALOG)
    expect(matched.kind).toBe('ambiguous')
    expect((matched as { candidates: string[] }).candidates).toEqual([
      'deepseek-official/deepseek-v4-pro',
      'xiaomi/deepseek-v4-pro',
    ])
  })

  it('takes a route on a configured provider even when the catalog does not list it', () => {
    // A catalog can lag behind a model the provider actually serves; refusing
    // would make this stricter than the web UI's own picker.
    expect(matchRoute('xiaomi/mimo-v3-preview', CATALOG)).toEqual({
      kind: 'route',
      route: { provider: 'xiaomi', model: 'mimo-v3-preview' },
    })
  })

  it('refuses a provider that is not configured at all', () => {
    expect(matchRoute('openai/gpt-5', CATALOG).kind).toBe('unknown')
  })

  it('refuses a model nobody offers', () => {
    expect(matchRoute('imaginary-model', CATALOG).kind).toBe('unknown')
  })

  it('refuses empty input', () => {
    expect(matchRoute('   ', CATALOG).kind).toBe('unknown')
  })

  it('keeps a model id that contains slashes, as a router-style provider has', () => {
    const routed = matchRoute('xiaomi/openai/gpt-5', CATALOG)
    expect(routed).toEqual({ kind: 'route', route: { provider: 'xiaomi', model: 'openai/gpt-5' } })
  })
})

describe('formatRoute', () => {
  it('renders a route the way it is typed back in', () => {
    expect(formatRoute({ provider: 'xiaomi', model: 'mimo-v2.5' })).toBe('xiaomi/mimo-v2.5')
  })

  it('names the absence of one in words, not as an empty string', () => {
    expect(formatRoute(undefined)).toBe('the deployment default')
  })
})
