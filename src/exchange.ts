import { z } from 'zod'

const TokenSchema = z.object({ token: z.string().min(1) })
const ErrorSchema = z.object({ message: z.string() })

export const EXCHANGE_TIMEOUT_MS = 30_000

export interface ExchangeRequest { sts: string; scope: string; identity: string }

export async function exchange(request: ExchangeRequest, identityToken: string, fetcher: typeof fetch, signal: AbortSignal): Promise<string> {
  const url = new URL('/sts/exchange', request.sts)
  url.searchParams.set('scope', request.scope)
  url.searchParams.set('identity', request.identity)
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(new Error(`octo-sts did not answer within ${EXCHANGE_TIMEOUT_MS / 1000} s`)), EXCHANGE_TIMEOUT_MS)
  try {
    let response: Response
    try {
      response = await fetcher(url, {
        redirect: 'error',
        headers: { authorization: `Bearer ${identityToken}`, accept: 'application/json' },
        signal: AbortSignal.any([signal, timeout.signal]),
      })
    } catch (error) {
      throw withCause(error, identityToken)
    }
    if (!response.ok) throw new Error(`octo-sts answered ${response.status}: ${await reason(response)}`)
    const parsed = TokenSchema.safeParse(await response.json().catch(() => undefined))
    if (!parsed.success) throw new Error('octo-sts answered without a token')
    return parsed.data.token
  } catch (error) {
    if (timeout.signal.aborted && !signal.aborted) throw timeout.signal.reason
    throw error
  } finally {
    clearTimeout(timer)
  }
}

function withCause(error: unknown, identityToken: string): unknown {
  if (!(error instanceof Error) || typeof error.cause !== 'object' || error.cause === null) return error
  const { code, message } = error.cause as { code?: unknown; message?: unknown }
  const detail = typeof code === 'string' ? code : typeof message === 'string' ? message : ''
  if (!detail) return error
  return new Error(printable(`${error.message}: ${detail}`).replaceAll(identityToken, '[redacted]'), { cause: error })
}

async function reason(response: Response): Promise<string> {
  const body = await response.json().catch(() => undefined)
  const parsed = ErrorSchema.safeParse(body)
  return printable(parsed.success ? parsed.data.message : response.statusText).slice(0, 200) || 'no reason given'
}

function printable(text: string): string {
  return text.replace(/\p{Cc}+/gu, ' ').trim()
}
