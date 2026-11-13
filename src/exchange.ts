import { z } from 'zod'

const TokenSchema = z.object({ token: z.string().min(1) })
const ErrorSchema = z.object({ message: z.string() })

export const EXCHANGE_TIMEOUT_MS = 30_000

export interface ExchangeRequest { sts: string; scope: string; identity: string }

export async function exchange(request: ExchangeRequest, identityToken: string, fetcher: typeof fetch, signal: AbortSignal): Promise<string> {
  const url = new URL('/sts/exchange', request.sts)
  url.searchParams.set('scope', request.scope)
  url.searchParams.set('identity', request.identity)
  const response = await fetcher(url, {
    redirect: 'error',
    headers: { authorization: `Bearer ${identityToken}`, accept: 'application/json' },
    signal: AbortSignal.any([signal, AbortSignal.timeout(EXCHANGE_TIMEOUT_MS)]),
  })
  if (!response.ok) throw new Error(`octo-sts answered ${response.status}: ${await reason(response)}`)
  const parsed = TokenSchema.safeParse(await response.json().catch(() => undefined))
  if (!parsed.success) throw new Error('octo-sts answered without a token')
  return parsed.data.token
}

async function reason(response: Response): Promise<string> {
  const body = await response.json().catch(() => undefined)
  const parsed = ErrorSchema.safeParse(body)
  return parsed.success ? parsed.data.message.slice(0, 200) : response.statusText || 'no reason given'
}
