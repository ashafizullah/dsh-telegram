import { describe, expect, it, vi } from 'vitest'

import { TelegramApi, TelegramApiError } from '../src/telegram/api.js'

const TOKEN = '123456:SUPER-SECRET-TOKEN'

/** Build an api whose transport is a scripted queue of Bot API envelopes. */
function apiWith(responses: unknown[]): { api: TelegramApi; calls: Call[] } {
  const calls: Call[] = []
  const queue = [...responses]

  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body as string) : undefined })
    const next = queue.shift() ?? { ok: true, result: true }
    const status = typeof next === 'object' && next !== null && 'status' in next
      ? (next as { status: number }).status
      : 200
    return {
      ok: status < 400,
      status,
      text: async () => JSON.stringify(next),
      headers: new Map(),
    } as unknown as Response
  }) as unknown as typeof fetch

  const api = new TelegramApi({
    token: TOKEN,
    baseUrl: 'https://api.telegram.org',
    timeoutMs: 1000,
    fetchImpl,
    sleep: async () => undefined,
  })

  return { api, calls }
}

interface Call {
  url: string
  body?: Record<string, unknown>
}

describe('TelegramApi — request shape', () => {
  it('puts the token in the path and the method in the last segment', async () => {
    const { api, calls } = apiWith([{ ok: true, result: { id: 1, is_bot: true } }])
    await api.getMe()
    expect(calls[0]?.url).toBe(`https://api.telegram.org/bot${TOKEN}/getMe`)
  })

  it('asks for callback_query updates, which is what makes buttons work', async () => {
    const { api, calls } = apiWith([{ ok: true, result: [] }])
    await api.getUpdates(0, 25)
    expect(calls[0]?.body?.allowed_updates).toEqual(['message', 'callback_query'])
  })

  it('sends the acknowledged offset so Telegram stops redelivering', async () => {
    const { api, calls } = apiWith([{ ok: true, result: [] }])
    await api.getUpdates(42, 25)
    expect(calls[0]?.body?.offset).toBe(42)
  })
})

describe('TelegramApi — html messages', () => {
  it('sends text with parse_mode HTML', async () => {
    const { api, calls } = apiWith([{ ok: true, result: { message_id: 7 } }])
    await api.sendMessage({ chatId: '1', html: '<b>hi</b>' })
    expect(calls[0]?.body?.parse_mode).toBe('HTML')
    expect(calls[0]?.body?.text).toBe('<b>hi</b>')
  })

  it('returns the new message id', async () => {
    const { api } = apiWith([{ ok: true, result: { message_id: 7 } }])
    await expect(api.sendMessage({ chatId: '1', html: 'hi' })).resolves.toEqual({ messageId: 7 })
  })

  it('attaches an inline keyboard when buttons are given', async () => {
    const { api, calls } = apiWith([{ ok: true, result: { message_id: 7 } }])
    await api.sendMessage({
      chatId: '1',
      html: 'pick',
      keyboard: [[{ text: 'Yes', callbackData: 'a' }]],
    })
    expect(calls[0]?.body?.reply_markup).toEqual({
      inline_keyboard: [[{ text: 'Yes', callback_data: 'a' }]],
    })
  })

  it('retries as plain text when Telegram rejects the entities', async () => {
    const { api, calls } = apiWith([
      { status: 400, ok: false, error_code: 400, description: "Bad Request: can't parse entities" },
      { ok: true, result: { message_id: 8 } },
    ])
    await api.sendMessage({ chatId: '1', html: '<b>broken' })
    expect(calls).toHaveLength(2)
    expect(calls[1]?.body?.parse_mode).toBeUndefined()
    expect(calls[1]?.body?.text).toBe('broken')
  })
})

describe('TelegramApi — editing', () => {
  it('reports an unchanged edit as not-modified instead of throwing', async () => {
    const { api } = apiWith([
      {
        status: 400,
        ok: false,
        error_code: 400,
        description: 'Bad Request: message is not modified',
      },
    ])
    await expect(api.editMessageText({ chatId: '1', messageId: 2, html: 'same' })).resolves.toBe(
      'unchanged',
    )
  })

  it('reports a successful edit', async () => {
    const { api } = apiWith([{ ok: true, result: { message_id: 2 } }])
    await expect(api.editMessageText({ chatId: '1', messageId: 2, html: 'new' })).resolves.toBe(
      'edited',
    )
  })

  it('clears a keyboard by sending an empty markup', async () => {
    const { api, calls } = apiWith([{ ok: true, result: true }])
    await api.editMessageReplyMarkup({ chatId: '1', messageId: 2, keyboard: [] })
    expect(calls[0]?.body?.reply_markup).toEqual({ inline_keyboard: [] })
  })
})

describe('TelegramApi — resilience', () => {
  it('waits out a 429 and retries', async () => {
    const sleep = vi.fn(async () => undefined)
    const calls: Call[] = []
    const queue: unknown[] = [
      { status: 429, ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 3 } },
      { ok: true, result: { message_id: 9 } },
    ]
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: init.body ? JSON.parse(init.body as string) : undefined })
      const next = queue.shift()
      const status = (next as { status?: number }).status ?? 200
      return { ok: status < 400, status, text: async () => JSON.stringify(next) } as unknown as Response
    }) as unknown as typeof fetch

    const api = new TelegramApi({ token: TOKEN, baseUrl: 'https://api.telegram.org', timeoutMs: 1000, fetchImpl, sleep })
    await expect(api.sendMessage({ chatId: '1', html: 'hi' })).resolves.toEqual({ messageId: 9 })
    expect(sleep).toHaveBeenCalledWith(3000, undefined)
    expect(calls).toHaveLength(2)
  })

  it('throws an auth error for a rejected token', async () => {
    const { api } = apiWith([
      { status: 401, ok: false, error_code: 401, description: 'Unauthorized' },
    ])
    await expect(api.getMe()).rejects.toThrow(TelegramApiError)
  })

  it('redacts the token when a network error quotes the request url', async () => {
    // undici puts the full url in its error message, which is the real leak path.
    const fetchImpl = (async (url: string) => {
      throw new Error(`connect ECONNREFUSED for ${url}`)
    }) as unknown as typeof fetch
    const api = new TelegramApi({ token: TOKEN, baseUrl: 'https://api.telegram.org', timeoutMs: 10, fetchImpl, sleep: async () => undefined })
    const error = await api.getMe().catch((e: unknown) => e)
    expect(String(error)).not.toContain(TOKEN)
    expect(String(error)).toContain('<redacted>')
  })
})
