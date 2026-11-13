import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OctoStsConfigSchema, type OctoStsConfig } from '../src/config.ts'
import { exchange } from '../src/exchange.ts'
import { TokenRefresher, refreshOnce, retryDelayMs, writeTokenFile, type SecretStore } from '../src/refresher.ts'
import { apply, Config } from '../src/index.ts'

const WORKSPACE = 'https://github.com/acme/widgets'
const IDENTITY_TOKEN = 'eyJ.identity.jwt'
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'octo-sts-'))
  writeFileSync(join(dir, 'sa-token'), `${IDENTITY_TOKEN}\n`)
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

const config = (overrides: Record<string, unknown> = {}): OctoStsConfig => OctoStsConfigSchema.parse({
  sts: 'https://sts.example.test', scope: 'acme', identity: 'dsh-yawn', identityTokenFile: join(dir, 'sa-token'),
  workspaces: [WORKSPACE], tokenFile: join(dir, 'gh.token'), ...overrides })

function sts(answers: (() => Response)[] = []) {
  let issued = 0
  const calls: { url: URL; headers: Record<string, string> }[] = []
  const fetcher = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: new URL(String(url)), headers: init.headers as Record<string, string> })
    const answer = answers.shift()
    if (answer) return answer()
    return Response.json({ token: `ghs_token${++issued}` })
  })
  return { fetcher: fetcher as unknown as typeof fetch, calls }
}

function store(fail?: () => Error) {
  const secrets = new Map<string, string>()
  const value: SecretStore = {
    setWorkspaceSecret: vi.fn(async (url: string, name: string, secret: string) => {
      if (fail) throw fail()
      secrets.set(`${url} ${name}`, secret)
      return {}
    }),
  }
  return { value, secrets }
}

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })
const logged = (log: ReturnType<typeof logger>) => JSON.stringify([log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls])
const signal = () => new AbortController().signal
async function advance(refresher: TokenRefresher, ms: number) {
  for (let left = ms; ; left -= 1_000) {
    await vi.advanceTimersByTimeAsync(Math.min(left, 1_000))
    await refresher.settled()
    if (left <= 1_000) return
  }
}

describe('config', () => {
  it('applies the defaults', () => {
    const parsed = OctoStsConfigSchema.parse({ scope: 'acme', identity: 'dsh-yawn', workspaces: [WORKSPACE] })
    expect(parsed).toMatchObject({ sts: 'https://sts.h-cloud.io', identityTokenFile: '/var/run/secrets/octo-sts/token', refreshMinutes: 30, secretName: 'GITHUB_TOKEN' })
    expect(parsed.tokenFile).toBeUndefined()
  })

  it('refuses an identity that is not one path segment, relative paths, plain http and unknown keys', () => {
    const base = { scope: 'acme', identity: 'dsh-yawn', workspaces: [WORKSPACE] }
    for (const identity of ['a/b', '..', '.', 'a b', '']) expect(OctoStsConfigSchema.safeParse({ ...base, identity }).success).toBe(false)
    expect(OctoStsConfigSchema.safeParse({ ...base, tokenFile: 'gh.token' }).success).toBe(false)
    expect(OctoStsConfigSchema.safeParse({ ...base, sts: 'http://sts.example.test' }).success).toBe(false)
    expect(OctoStsConfigSchema.safeParse({ ...base, extra: true }).success).toBe(false)
    expect(OctoStsConfigSchema.safeParse({ ...base, refreshMinutes: 60 }).success).toBe(false)
  })

  it('needs somewhere to put the token', () => {
    expect(OctoStsConfigSchema.safeParse({ scope: 'acme', identity: 'dsh-yawn' }).success).toBe(false)
    expect(OctoStsConfigSchema.safeParse({ scope: 'acme', identity: 'dsh-yawn', tokenFile: '/run/gh.token' }).success).toBe(true)
  })

  it('is a standard schema Cordis can validate', () => {
    expect(typeof Config['~standard'].validate).toBe('function')
  })
})

describe('exchange', () => {
  it('sends the identity token as a bearer with scope and identity', async () => {
    const { fetcher, calls } = sts()
    await expect(exchange(config(), IDENTITY_TOKEN, fetcher, signal())).resolves.toBe('ghs_token1')
    expect(calls[0]!.url.toString()).toBe('https://sts.example.test/sts/exchange?scope=acme&identity=dsh-yawn')
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${IDENTITY_TOKEN}`)
  })

  it('reports the status and octo-sts message on refusal', async () => {
    const { fetcher } = sts([() => Response.json({ code: 16, message: 'unable to verify bearer token' }, { status: 401 })])
    await expect(exchange(config(), IDENTITY_TOKEN, fetcher, signal())).rejects.toThrow('octo-sts answered 401: unable to verify bearer token')
  })

  it('refuses an answer without a token', async () => {
    const { fetcher } = sts([() => Response.json({ token: '' })])
    await expect(exchange(config(), IDENTITY_TOKEN, fetcher, signal())).rejects.toThrow('without a token')
  })
})

describe('refreshOnce', () => {
  it('writes the token to every workspace and to a 0600 file', async () => {
    const { fetcher } = sts()
    const { value, secrets } = store()
    await refreshOnce(config({ workspaces: [WORKSPACE, 'https://github.com/acme/other'] }), { store: () => value, logger: logger(), fetch: fetcher }, signal())
    expect(secrets.get(`${WORKSPACE} GITHUB_TOKEN`)).toBe('ghs_token1')
    expect(secrets.get('https://github.com/acme/other GITHUB_TOKEN')).toBe('ghs_token1')
    expect(readFileSync(join(dir, 'gh.token'), 'utf8')).toBe('ghs_token1')
    expect(statSync(join(dir, 'gh.token')).mode & 0o777).toBe(0o600)
  })

  it('reads the identity token file fresh each round', async () => {
    const { fetcher, calls } = sts()
    const { value } = store()
    const dependencies = { store: () => value, logger: logger(), fetch: fetcher }
    await refreshOnce(config(), dependencies, signal())
    writeFileSync(join(dir, 'sa-token'), 'eyJ.rotated.jwt')
    await refreshOnce(config(), dependencies, signal())
    expect(calls.map(call => call.headers.authorization)).toEqual([`Bearer ${IDENTITY_TOKEN}`, 'Bearer eyJ.rotated.jwt'])
  })

  it('still writes the file when sandboxManager is missing, and fails the round', async () => {
    const { fetcher } = sts()
    await expect(refreshOnce(config(), { store: () => undefined, logger: logger(), fetch: fetcher }, signal())).rejects.toThrow('sandboxManager')
    expect(readFileSync(join(dir, 'gh.token'), 'utf8')).toBe('ghs_token1')
  })

  it('redacts token values from errors', async () => {
    const { fetcher } = sts()
    const { value } = store(() => new Error('rejected ghs_token1 for eyJ.identity.jwt'))
    const error = await refreshOnce(config(), { store: () => value, logger: logger(), fetch: fetcher }, signal()).catch((caught: Error) => caught)
    expect(String(error)).toContain('[redacted]')
    expect(String(error)).not.toContain('ghs_token1')
    expect(String(error)).not.toContain(IDENTITY_TOKEN)
  })

  it('fails without calling octo-sts when the identity token file is missing or empty', async () => {
    const { fetcher, calls } = sts()
    writeFileSync(join(dir, 'sa-token'), '\n')
    await expect(refreshOnce(config(), { store: () => store().value, logger: logger(), fetch: fetcher }, signal())).rejects.toThrow('is empty')
    rmSync(join(dir, 'sa-token'))
    await expect(refreshOnce(config(), { store: () => store().value, logger: logger(), fetch: fetcher }, signal())).rejects.toThrow('ENOENT')
    expect(calls).toHaveLength(0)
  })

  it('tries every workspace when one refuses', async () => {
    const { fetcher } = sts()
    const secrets = new Map<string, string>()
    const value: SecretStore = { setWorkspaceSecret: (url, name, secret) => {
      if (url === WORKSPACE) throw new Error('workspace is not registered: https://github.com/acme/widgets')
      secrets.set(url, secret)
      return Promise.resolve({})
    } }
    await expect(refreshOnce(config({ workspaces: [WORKSPACE, 'https://github.com/acme/other'] }), { store: () => value, logger: logger(), fetch: fetcher }, signal()))
      .rejects.toThrow('workspace is not registered')
    expect(secrets.get('https://github.com/acme/other')).toBe('ghs_token1')
  })
})

describe('writeTokenFile', () => {
  it('replaces an existing file and leaves no temporary file behind', async () => {
    const path = join(dir, 'gh.token')
    writeFileSync(path, 'old', { mode: 0o644 })
    await writeTokenFile(path, 'new')
    expect(readFileSync(path, 'utf8')).toBe('new')
    expect(statSync(path).mode & 0o777).toBe(0o600)
    await expect(writeTokenFile(join(dir, 'missing', 'gh.token'), 'x')).rejects.toThrow()
  })
})

describe('TokenRefresher', () => {
  it('backs off 1, 2, 4 min up to 5 min', () => {
    expect([1, 2, 3, 4, 5, 10].map(retryDelayMs)).toEqual([60_000, 120_000, 240_000, 300_000, 300_000, 300_000])
  })

  it('refreshes at start and on the interval', async () => {
    vi.useFakeTimers()
    const { fetcher, calls } = sts()
    const { value, secrets } = store()
    const refresher = new TokenRefresher(config(), { store: () => value, logger: logger(), fetch: fetcher, now: Date.now })
    refresher.start()
    await advance(refresher, 0)
    expect(refresher.health()).toMatchObject({ state: 'ready', failures: 0 })
    expect(secrets.get(`${WORKSPACE} GITHUB_TOKEN`)).toBe('ghs_token1')
    await advance(refresher, 30 * 60_000)
    expect(calls).toHaveLength(2)
    expect(secrets.get(`${WORKSPACE} GITHUB_TOKEN`)).toBe('ghs_token2')
    await refresher.stop()
  })

  it('keeps the previous token on failure, backs off and recovers', async () => {
    vi.useFakeTimers()
    const failing = () => Response.json({ message: 'unavailable' }, { status: 503 })
    const { fetcher, calls } = sts()
    const { value, secrets } = store()
    const log = logger()
    const refresher = new TokenRefresher(config(), { store: () => value, logger: log, fetch: fetcher, now: Date.now })
    refresher.start()
    await advance(refresher, 0)
    const answers = [failing, failing]
    vi.mocked(fetcher).mockImplementation(async (url, init) => {
      calls.push({ url: new URL(String(url)), headers: init?.headers as Record<string, string> })
      return (answers.shift() ?? (() => Response.json({ token: 'ghs_recovered' })))()
    })
    await advance(refresher, 30 * 60_000)
    expect(refresher.health()).toMatchObject({ state: 'failing', failures: 1, detail: 'octo-sts answered 503: unavailable' })
    expect(secrets.get(`${WORKSPACE} GITHUB_TOKEN`)).toBe('ghs_token1')
    expect(readFileSync(join(dir, 'gh.token'), 'utf8')).toBe('ghs_token1')
    await advance(refresher, 59_000)
    expect(calls).toHaveLength(2)
    await advance(refresher, 1_000)
    expect(refresher.health()).toMatchObject({ state: 'failing', failures: 2 })
    await advance(refresher, 120_000)
    expect(refresher.health()).toMatchObject({ state: 'ready', failures: 0 })
    expect(secrets.get(`${WORKSPACE} GITHUB_TOKEN`)).toBe('ghs_recovered')
    expect(log.warn).toHaveBeenCalledTimes(2)
    expect(logged(log)).not.toMatch(/ghs_|eyJ/)
    await refresher.stop()
  })

  it('reports expired once the last good token is past its hour', async () => {
    vi.useFakeTimers()
    const { fetcher } = sts()
    const { value } = store()
    const log = logger()
    const refresher = new TokenRefresher(config({ refreshMinutes: 55 }), { store: () => value, logger: log, fetch: fetcher, now: Date.now })
    refresher.start()
    await advance(refresher, 0)
    vi.mocked(fetcher).mockImplementation(async () => Response.json({ message: 'down' }, { status: 500 }))
    await advance(refresher, 55 * 60_000)
    expect(refresher.health().state).toBe('failing')
    await advance(refresher, 5 * 60_000)
    expect(refresher.health().state).toBe('expired')
    expect(log.error).not.toHaveBeenCalled()
    await advance(refresher, 2 * 60_000)
    expect(log.error).toHaveBeenCalledTimes(1)
    await refresher.stop()
  })

  it('never rejects when every dependency throws, and stops cleanly', async () => {
    vi.useFakeTimers()
    const throwing = () => { throw new Error('logger down') }
    const fetcher = vi.fn(async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch
    const refresher = new TokenRefresher(config(), { store: () => { throw new Error('no store') }, logger: { info: throwing, warn: throwing, error: throwing }, fetch: fetcher, now: Date.now })
    const rejections: unknown[] = []
    const listener = (reason: unknown) => { rejections.push(reason) }
    process.on('unhandledRejection', listener)
    try {
      refresher.start()
      await advance(refresher, 10 * 60_000)
      expect(refresher.health()).toMatchObject({ state: 'expired', detail: 'fetch failed' })
      await refresher.stop()
      expect(refresher.health().state).toBe('stopped')
      const before = vi.mocked(fetcher).mock.calls.length
      await advance(refresher, 60 * 60_000)
      expect(vi.mocked(fetcher).mock.calls.length).toBe(before)
    } finally {
      process.off('unhandledRejection', listener)
    }
    expect(rejections).toEqual([])
  })
})

describe('plugin', () => {
  it('starts in an effect, looks sandboxManager up per round and stops on dispose', async () => {
    vi.useFakeTimers()
    const { fetcher } = sts()
    vi.stubGlobal('fetch', fetcher)
    try {
      const { value, secrets } = store()
      let dispose: (() => unknown) | void = undefined
      const get = vi.fn(() => value)
      apply({ logger: logger(), get, effect: execute => { dispose = execute() } }, config())
      await vi.waitFor(() => expect(secrets.size).toBe(1))
      expect(get).toHaveBeenCalledWith('sandboxManager')
      expect(secrets.get(`${WORKSPACE} GITHUB_TOKEN`)).toBe('ghs_token1')
      await (dispose as unknown as () => Promise<void>)()
      await vi.advanceTimersByTimeAsync(60 * 60_000)
      expect(vi.mocked(fetcher)).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
