import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { format } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OctoStsConfigSchema, type OctoStsConfig } from '../src/config.ts'
import { exchange } from '../src/exchange.ts'
import { TokenRefresher, readIdentityToken, removeTemporaryFiles, retryDelayMs, writeTokenFile, type SecretStore } from '../src/refresher.ts'
import { apply, Config } from '../src/index.ts'

const WORKSPACE = 'https://github.com/acme/widgets'
const OTHER = 'https://github.com/acme/other'
const IDENTITY_TOKEN = 'eyJ.identity.jwt'
const MIN = 60_000
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
  workspaces: [WORKSPACE], tokenFile: join(dir, 'run', 'gh.token'), ...overrides })
const tokenFile = () => readFileSync(join(dir, 'run', 'gh.token'), 'utf8')

type Answer = () => Response | Promise<Response>
function sts() {
  let issued = 0
  const answers: Answer[] = []
  const calls: { url: URL; init: RequestInit }[] = []
  const fetcher = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: new URL(String(url)), init })
    const answer = answers.shift()
    return answer ? await answer() : Response.json({ token: `ghs_token${++issued}` })
  })
  return { fetcher: fetcher as unknown as typeof fetch, calls, answers }
}
const refused = (status = 503, text = 'unavailable'): Answer => () => Response.json({ message: text }, { status })

function store(options: { registered?: string[] } = {}) {
  const secrets = new Map<string, string>()
  const failures = new Map<string, () => Error>()
  const registered = new Set(options.registered ?? [])
  let registry: (() => Error) | undefined
  const createRepositoryWorkspace = vi.fn(async (url: string) => {
    if (registry) throw registry()
    registered.add(url)
    return `/data/.dsh-yawn/workspace-anchors/${url.split('/').at(-1)}`
  })
  const setWorkspaceSecret = vi.fn(async (url: string, name: string, secret: string) => {
    const failure = failures.get(url)
    if (failure) throw failure()
    if (!registered.has(url)) throw new Error(`workspace is not registered: ${url}`)
    secrets.set(`${url} ${name}`, secret)
    return {}
  })
  return { value: { setWorkspaceSecret, createRepositoryWorkspace } as SecretStore, secrets, failures, registered, setWorkspaceSecret, createRepositoryWorkspace,
    breakRegistry: (error: (() => Error) | undefined) => { registry = error } }
}

function logger() {
  const lines: { level: string; text: string }[] = []
  const at = (level: string) => vi.fn((pattern: string, ...args: unknown[]) => { lines.push({ level, text: format(pattern, ...args) }) })
  return { info: at('info'), warn: at('warn'), error: at('error'), lines }
}

function harness(overrides: Record<string, unknown> = {}) {
  vi.useFakeTimers()
  const server = sts()
  const secrets = store()
  const log = logger()
  const refresher = new TokenRefresher(config(overrides), { store: () => secrets.value, logger: log, fetch: server.fetcher, now: Date.now })
  const advance = async (ms: number) => {
    for (let left = ms; ; left -= 1_000) {
      await vi.advanceTimersByTimeAsync(Math.min(left, 1_000))
      await refresher.settled()
      if (left <= 1_000) return
    }
  }
  return { refresher, server, secrets, log, advance }
}

describe('config', () => {
  const base = { scope: 'acme', identity: 'dsh-yawn', workspaces: [WORKSPACE] }

  it('applies the defaults', () => {
    const parsed = OctoStsConfigSchema.parse(base)
    expect(parsed).toMatchObject({ sts: 'https://sts.h-cloud.io', identityTokenFile: '/var/run/secrets/octo-sts/token', refreshMinutes: 30, secretName: 'GITHUB_TOKEN', registerWorkspaces: true })
    expect(parsed.tokenFile).toBeUndefined()
  })

  it('refuses an identity that is not one path segment, relative paths and unknown keys', () => {
    for (const identity of ['a/b', '..', '.', 'a b', '']) expect(OctoStsConfigSchema.safeParse({ ...base, identity }).success).toBe(false)
    expect(OctoStsConfigSchema.safeParse({ ...base, tokenFile: 'gh.token' }).success).toBe(false)
    expect(OctoStsConfigSchema.safeParse({ ...base, identityTokenFile: 'token' }).success).toBe(false)
    expect(OctoStsConfigSchema.safeParse({ ...base, extra: true }).success).toBe(false)
  })

  it('accepts only an https server root without credentials as sts', () => {
    expect(OctoStsConfigSchema.safeParse({ ...base, sts: 'https://sts.example.test/' }).success).toBe(true)
    for (const sts of ['http://sts.example.test', 'https://user:pass@sts.example.test', 'https://user@sts.example.test',
      'https://sts.example.test/prefix', 'https://sts.example.test/?a=1', 'https://sts.example.test/#x']) {
      expect(OctoStsConfigSchema.safeParse({ ...base, sts }).success, sts).toBe(false)
    }
  })

  it('keeps the refresh interval between 5 and 45 minutes', () => {
    expect(OctoStsConfigSchema.safeParse({ ...base, refreshMinutes: 45 }).success).toBe(true)
    for (const refreshMinutes of [4, 46, 10.5]) expect(OctoStsConfigSchema.safeParse({ ...base, refreshMinutes }).success).toBe(false)
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
  const signal = () => new AbortController().signal

  it('sends the identity token as a bearer with scope and identity and refuses redirects', async () => {
    const { fetcher, calls } = sts()
    await expect(exchange(config(), IDENTITY_TOKEN, fetcher, signal())).resolves.toBe('ghs_token1')
    expect(calls[0]!.url.toString()).toBe('https://sts.example.test/sts/exchange?scope=acme&identity=dsh-yawn')
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${IDENTITY_TOKEN}`)
    expect(calls[0]!.init.redirect).toBe('error')
  })

  it('reports the status and octo-sts message on refusal', async () => {
    const { fetcher, answers } = sts()
    answers.push(refused(401, 'unable to verify bearer token'))
    await expect(exchange(config(), IDENTITY_TOKEN, fetcher, signal())).rejects.toThrow('octo-sts answered 401: unable to verify bearer token')
  })

  it('refuses an answer without a token', async () => {
    const { fetcher, answers } = sts()
    answers.push(() => Response.json({ token: '' }), () => new Response('not json'))
    await expect(exchange(config(), IDENTITY_TOKEN, fetcher, signal())).rejects.toThrow('without a token')
    await expect(exchange(config(), IDENTITY_TOKEN, fetcher, signal())).rejects.toThrow('without a token')
  })
})

describe('readIdentityToken', () => {
  it('trims the file and refuses an empty or missing one', async () => {
    await expect(readIdentityToken(join(dir, 'sa-token'))).resolves.toBe(IDENTITY_TOKEN)
    writeFileSync(join(dir, 'sa-token'), '\n')
    await expect(readIdentityToken(join(dir, 'sa-token'))).rejects.toThrow('is empty')
    await expect(readIdentityToken(join(dir, 'missing'))).rejects.toThrow('ENOENT')
  })
})

describe('writeTokenFile', () => {
  it('creates a missing parent directory with 0700 and the file with 0600', async () => {
    const path = join(dir, 'a', 'b', 'gh.token')
    await writeTokenFile(path, 'secret')
    expect(readFileSync(path, 'utf8')).toBe('secret')
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, 'a', 'b')).mode & 0o777).toBe(0o700)
  })

  it('replaces an existing file atomically and leaves no temporary file behind', async () => {
    const path = join(dir, 'gh.token')
    writeFileSync(path, 'old', { mode: 0o644 })
    await writeTokenFile(path, 'new')
    expect(readFileSync(path, 'utf8')).toBe('new')
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readdirSync(dir).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('replaces a symlink instead of writing through it', async () => {
    const target = join(dir, 'elsewhere')
    writeFileSync(target, 'untouched')
    const path = join(dir, 'gh.token')
    symlinkSync(target, path)
    await writeTokenFile(path, 'new')
    expect(readFileSync(target, 'utf8')).toBe('untouched')
    expect(lstatSync(path).isSymbolicLink()).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe('new')
  })

  it('fails when the parent cannot be created', async () => {
    writeFileSync(join(dir, 'file'), '')
    await expect(writeTokenFile(join(dir, 'file', 'gh.token'), 'x')).rejects.toThrow()
  })
})

describe('removeTemporaryFiles', () => {
  it('removes only leftover temporary files of the token file', async () => {
    const path = join(dir, 'gh.token')
    for (const name of ['gh.token', 'gh.token.0123456789abcdef.tmp', 'gh.token.fedcba9876543210.tmp', 'gh.token.backup', 'other.0123456789abcdef.tmp', 'gh.token.123.tmp']) writeFileSync(join(dir, name), 'x')
    await removeTemporaryFiles(path)
    expect(readdirSync(dir).sort()).toEqual(['gh.token', 'gh.token.123.tmp', 'gh.token.backup', 'other.0123456789abcdef.tmp', 'sa-token'])
    await expect(removeTemporaryFiles(join(dir, 'missing', 'gh.token'))).resolves.toBeUndefined()
  })
})

describe('TokenRefresher', () => {
  it('backs off 1, 2, 4 min up to 5 min', () => {
    expect([1, 2, 3, 4, 5, 10].map(retryDelayMs)).toEqual([MIN, 2 * MIN, 4 * MIN, 5 * MIN, 5 * MIN, 5 * MIN])
  })

  it('exchanges at start and on the interval, delivering to the file and every workspace', async () => {
    const { refresher, server, secrets, log, advance } = harness({ workspaces: [WORKSPACE, OTHER] })
    refresher.start()
    await advance(0)
    expect(secrets.secrets.get(`${WORKSPACE} GITHUB_TOKEN`)).toBe('ghs_token1')
    expect(secrets.secrets.get(`${OTHER} GITHUB_TOKEN`)).toBe('ghs_token1')
    expect(tokenFile()).toBe('ghs_token1')
    await advance(30 * MIN - 1_000)
    expect(server.calls).toHaveLength(1)
    await advance(1_000)
    expect(server.calls).toHaveLength(2)
    expect(secrets.secrets.get(`${WORKSPACE} GITHUB_TOKEN`)).toBe('ghs_token2')
    expect(log.lines.map(line => line.level)).toEqual(['info', 'info'])
    await refresher.stop()
  })

  it('removes leftover temporary files before the first write', async () => {
    const { refresher, advance } = harness()
    writeFileSync(join(dir, 'sa-token'), IDENTITY_TOKEN)
    const run = join(dir, 'run')
    await writeTokenFile(join(run, 'gh.token'), 'old')
    writeFileSync(join(run, 'gh.token.0123456789abcdef.tmp'), 'leftover')
    refresher.start()
    await advance(0)
    expect(readdirSync(run)).toEqual(['gh.token'])
    expect(tokenFile()).toBe('ghs_token1')
    await refresher.stop()
  })

  it('schedules on the monotonic clock by default, unaffected by wall-clock jumps', async () => {
    vi.useFakeTimers()
    const { fetcher, calls } = sts()
    const refresher = new TokenRefresher(config(), { store: () => undefined, logger: logger(), fetch: fetcher })
    refresher.start()
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    await refresher.settled()
    vi.setSystemTime(Date.now() + 24 * 60 * MIN)
    await vi.advanceTimersByTimeAsync(MIN)
    await refresher.settled()
    expect(calls).toHaveLength(1)
    await refresher.stop()
  })

  it('reads the identity token file fresh for each exchange', async () => {
    const { refresher, server, advance } = harness()
    refresher.start()
    await advance(0)
    writeFileSync(join(dir, 'sa-token'), 'eyJ.rotated.jwt')
    await advance(30 * MIN)
    expect(server.calls.map(call => (call.init.headers as Record<string, string>).authorization)).toEqual([`Bearer ${IDENTITY_TOKEN}`, 'Bearer eyJ.rotated.jwt'])
    await refresher.stop()
  })

  it('takes the issuance time before the exchange, so a slow answer does not push the next one back', async () => {
    const { refresher, server, advance } = harness()
    server.answers.push(() => new Promise(resolve => setTimeout(() => resolve(Response.json({ token: 'ghs_slow' })), 2 * MIN)))
    refresher.start()
    await vi.waitFor(() => expect(server.calls).toHaveLength(1))
    await vi.advanceTimersByTimeAsync(2 * MIN)
    await refresher.settled()
    expect(tokenFile()).toBe('ghs_slow')
    await advance(28 * MIN)
    expect(server.calls).toHaveLength(2)
    await refresher.stop()
  })

  it('keeps the previous token on exchange failure, backs off and recovers', async () => {
    const { refresher, server, secrets, log, advance } = harness()
    refresher.start()
    await advance(0)
    server.answers.push(refused(), refused())
    await advance(30 * MIN)
    expect(secrets.secrets.get(`${WORKSPACE} GITHUB_TOKEN`)).toBe('ghs_token1')
    expect(tokenFile()).toBe('ghs_token1')
    expect(log.lines.at(-1)).toMatchObject({ level: 'warn' })
    expect(log.lines.at(-1)!.text).toContain('exchange failed: octo-sts answered 503: unavailable')
    await advance(MIN - 1_000)
    expect(server.calls).toHaveLength(2)
    await advance(1_000)
    expect(server.calls).toHaveLength(3)
    await advance(2 * MIN)
    expect(server.calls).toHaveLength(4)
    expect(secrets.secrets.get(`${WORKSPACE} GITHUB_TOKEN`)).toBe('ghs_token2')
    expect(log.lines.at(-1)!.text).toContain('after 2 failed attempts')
    expect(JSON.stringify(log.lines)).not.toMatch(/ghs_|eyJ/)
    await refresher.stop()
  })

  it('retries only the destination that failed, without a new exchange', async () => {
    const { refresher, server, secrets, log, advance } = harness({ workspaces: [WORKSPACE, OTHER] })
    secrets.failures.set(OTHER, () => new Error('broker busy'))
    refresher.start()
    await advance(0)
    expect(secrets.secrets.get(`${WORKSPACE} GITHUB_TOKEN`)).toBe('ghs_token1')
    expect(log.lines.at(-1)).toMatchObject({ level: 'warn' })
    expect(log.lines.at(-1)!.text).toContain(`${OTHER}: broker busy`)
    const before = secrets.setWorkspaceSecret.mock.calls.length
    secrets.failures.clear()
    await advance(MIN)
    expect(server.calls).toHaveLength(1)
    expect(secrets.setWorkspaceSecret.mock.calls.slice(before).map(call => call[0])).toEqual([OTHER])
    expect(secrets.secrets.get(`${OTHER} GITHUB_TOKEN`)).toBe('ghs_token1')
    expect(log.lines.at(-1)).toMatchObject({ level: 'info' })
    await advance(29 * MIN - 1_000)
    expect(server.calls).toHaveLength(1)
    await advance(1_000)
    expect(server.calls).toHaveLength(2)
    await refresher.stop()
  })

  it('with registration off, does not fast-retry a workspace that is not registered, and tries it again at the next exchange', async () => {
    const { refresher, server, secrets, log, advance } = harness({ workspaces: [WORKSPACE, OTHER], registerWorkspaces: false })
    secrets.registered.add(WORKSPACE)
    secrets.failures.set(OTHER, () => new Error(`workspace is not registered: ${OTHER}`))
    refresher.start()
    await advance(0)
    expect(log.lines.at(-1)).toMatchObject({ level: 'warn' })
    expect(log.lines.at(-1)!.text).toContain('retried at the next exchange')
    const before = secrets.setWorkspaceSecret.mock.calls.length
    await advance(30 * MIN - 1_000)
    expect(secrets.setWorkspaceSecret.mock.calls.length).toBe(before)
    expect(server.calls).toHaveLength(1)
    secrets.failures.clear()
    secrets.registered.add(OTHER)
    await advance(1_000)
    expect(server.calls).toHaveLength(2)
    expect(secrets.secrets.get(`${OTHER} GITHUB_TOKEN`)).toBe('ghs_token2')
    await refresher.stop()
  })

  it('does not report expiry while another destination holds a fresh token', async () => {
    const { refresher, secrets, log, advance } = harness({ registerWorkspaces: false })
    secrets.failures.set(WORKSPACE, () => new Error(`workspace is not registered: ${WORKSPACE}`))
    refresher.start()
    await advance(0)
    await advance(120 * MIN)
    expect(log.lines.filter(line => line.level === 'error')).toEqual([])
    expect(log.lines.filter(line => line.level === 'warn').length).toBeGreaterThanOrEqual(4)
    await refresher.stop()
  })

  it('registers each workspace once before its first delivery', async () => {
    const { refresher, secrets, log, advance } = harness({ workspaces: [WORKSPACE, OTHER] })
    refresher.start()
    await advance(0)
    expect(secrets.createRepositoryWorkspace.mock.calls.map(call => call[0])).toEqual([WORKSPACE, OTHER])
    expect(secrets.secrets.get(`${OTHER} GITHUB_TOKEN`)).toBe('ghs_token1')
    await advance(60 * MIN)
    expect(secrets.secrets.get(`${OTHER} GITHUB_TOKEN`)).toBe('ghs_token3')
    expect(secrets.createRepositoryWorkspace).toHaveBeenCalledTimes(2)
    expect(log.lines.map(line => line.level)).toEqual(['info', 'info', 'info'])
    await refresher.stop()
  })

  it('registers the workspace again and retries at once after a not-registered error', async () => {
    const { refresher, secrets, log, advance } = harness()
    refresher.start()
    await advance(0)
    secrets.registered.clear()
    await advance(30 * MIN)
    expect(secrets.createRepositoryWorkspace).toHaveBeenCalledTimes(2)
    expect(secrets.secrets.get(`${WORKSPACE} GITHUB_TOKEN`)).toBe('ghs_token2')
    expect(log.lines.map(line => line.level)).toEqual(['info', 'info'])
    await refresher.stop()
  })

  it('warns and still writes the file when the workspace cannot be registered, then retries without a new exchange', async () => {
    const { refresher, server, secrets, log, advance } = harness()
    secrets.breakRegistry(() => new Error('repository workspaces require the dsh Web profile'))
    refresher.start()
    await advance(0)
    expect(tokenFile()).toBe('ghs_token1')
    expect(secrets.setWorkspaceSecret).not.toHaveBeenCalled()
    expect(log.lines.at(-1)).toMatchObject({ level: 'warn' })
    expect(log.lines.at(-1)!.text).toContain(`${WORKSPACE}: could not register the workspace: repository workspaces require the dsh Web profile`)
    secrets.breakRegistry(undefined)
    await advance(MIN)
    expect(server.calls).toHaveLength(1)
    expect(secrets.secrets.get(`${WORKSPACE} GITHUB_TOKEN`)).toBe('ghs_token1')
    await refresher.stop()
  })

  it('warns when sandboxManager cannot register workspaces', async () => {
    vi.useFakeTimers()
    const { fetcher } = sts()
    const log = logger()
    const refresher = new TokenRefresher(config(), { store: () => ({ setWorkspaceSecret: async () => ({}) }), logger: log, fetch: fetcher, now: Date.now })
    refresher.start()
    await vi.waitFor(() => expect(log.lines).toHaveLength(1))
    expect(log.lines[0]).toMatchObject({ level: 'warn' })
    expect(log.lines[0]!.text).toContain('sandboxManager has no createRepositoryWorkspace')
    expect(tokenFile()).toBe('ghs_token1')
    await refresher.stop()
  })

  it('never registers with registration off', async () => {
    const { refresher, secrets, advance } = harness({ registerWorkspaces: false })
    secrets.registered.add(WORKSPACE)
    refresher.start()
    await advance(0)
    expect(secrets.createRepositoryWorkspace).not.toHaveBeenCalled()
    expect(secrets.secrets.get(`${WORKSPACE} GITHUB_TOKEN`)).toBe('ghs_token1')
    await refresher.stop()
  })

  it('reports an error when no destination holds a valid token', async () => {
    const { refresher, server, log, advance } = harness()
    server.answers.push(refused(401, 'unable to verify bearer token'))
    refresher.start()
    await advance(0)
    expect(log.lines.at(-1)).toMatchObject({ level: 'error' })
    expect(log.lines.at(-1)!.text).toContain('no destination holds a valid token')
    await refresher.stop()
  })

  it('reports an error once the last token is past its hour', async () => {
    const { refresher, server, log, advance } = harness({ refreshMinutes: 45 })
    refresher.start()
    await advance(0)
    for (let i = 0; i < 20; i++) server.answers.push(refused(500, 'down'))
    await advance(45 * MIN)
    expect(log.lines.at(-1)).toMatchObject({ level: 'warn' })
    await advance(14 * MIN)
    expect(log.lines.filter(line => line.level === 'error')).toEqual([])
    await advance(5 * MIN)
    expect(log.lines.at(-1)).toMatchObject({ level: 'error' })
    await refresher.stop()
  })

  it('does not call octo-sts when the identity token file is empty, and redacts tokens from delivery errors', async () => {
    const { refresher, server, secrets, log, advance } = harness()
    writeFileSync(join(dir, 'sa-token'), '\n')
    refresher.start()
    await advance(0)
    expect(server.calls).toHaveLength(0)
    expect(log.lines.at(-1)!.text).toContain('is empty')
    writeFileSync(join(dir, 'sa-token'), IDENTITY_TOKEN)
    secrets.failures.set(WORKSPACE, () => new Error('rejected ghs_token1'))
    await advance(MIN)
    expect(log.lines.at(-1)!.text).toContain('rejected [redacted]')
    expect(JSON.stringify(log.lines)).not.toMatch(/ghs_|eyJ/)
    await refresher.stop()
  })

  it('treats a missing sandboxManager as a transient failure and still writes the file', async () => {
    vi.useFakeTimers()
    const { fetcher } = sts()
    const secrets = store()
    let service: SecretStore | undefined
    const log = logger()
    const refresher = new TokenRefresher(config(), { store: () => service, logger: log, fetch: fetcher, now: Date.now })
    refresher.start()
    await vi.advanceTimersByTimeAsync(0)
    await refresher.settled()
    expect(tokenFile()).toBe('ghs_token1')
    expect(log.lines.at(-1)!.text).toContain('sandboxManager service is not available')
    service = secrets.value
    await vi.advanceTimersByTimeAsync(MIN)
    await refresher.settled()
    expect(secrets.secrets.get(`${WORKSPACE} GITHUB_TOKEN`)).toBe('ghs_token1')
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
      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(MIN)
        await refresher.settled()
      }
      expect(vi.mocked(fetcher).mock.calls.length).toBeGreaterThan(1)
      await refresher.stop()
      const before = vi.mocked(fetcher).mock.calls.length
      await vi.advanceTimersByTimeAsync(60 * MIN)
      expect(vi.mocked(fetcher).mock.calls.length).toBe(before)
    } finally {
      process.off('unhandledRejection', listener)
    }
    expect(rejections).toEqual([])
  })

  it('stops while an exchange is in flight without delivering its token', async () => {
    const { refresher, server, secrets } = harness()
    let release: (response: Response) => void = () => {}
    server.answers.push(() => new Promise(resolve => { release = resolve }))
    refresher.start()
    await vi.advanceTimersByTimeAsync(0)
    await vi.waitFor(() => expect(server.calls).toHaveLength(1))
    const stopping = refresher.stop()
    release(Response.json({ token: 'ghs_late' }))
    await stopping
    expect(secrets.secrets.size).toBe(0)
  })

  it('gives up on an exchange that does not answer within 30 s and retries', async () => {
    const { refresher, server, secrets, log, advance } = harness()
    server.answers.push((() => {
      const init = server.calls.at(-1)!.init
      return new Promise<Response>((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)))
    }) as Answer)
    refresher.start()
    await vi.waitFor(() => expect(server.calls).toHaveLength(1))
    await vi.advanceTimersByTimeAsync(30_000)
    await refresher.settled()
    expect(server.calls[0]!.init.signal!.aborted).toBe(true)
    expect(log.lines.at(-1)).toMatchObject({ level: 'error' })
    expect(log.lines.at(-1)!.text).toContain('octo-sts did not answer within 30 s')
    await advance(MIN)
    expect(server.calls).toHaveLength(2)
    expect(secrets.secrets.get(`${WORKSPACE} GITHUB_TOKEN`)).toBe('ghs_token1')
    await refresher.stop()
  })

  it('gives up on a workspace write that does not finish within 60 s and retries only that write', async () => {
    const { refresher, server, secrets, log, advance } = harness()
    let hang = true
    secrets.setWorkspaceSecret.mockImplementation(async (url: string, name: string, secret: string) => {
      if (hang) return await new Promise(() => {})
      secrets.secrets.set(`${url} ${name}`, secret)
      return {}
    })
    refresher.start()
    await vi.waitFor(() => expect(secrets.setWorkspaceSecret).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(60_000)
    await refresher.settled()
    expect(log.lines.at(-1)).toMatchObject({ level: 'warn' })
    expect(log.lines.at(-1)!.text).toContain(`${WORKSPACE}: timed out`)
    expect(tokenFile()).toBe('ghs_token1')
    hang = false
    await advance(MIN)
    expect(secrets.secrets.get(`${WORKSPACE} GITHUB_TOKEN`)).toBe('ghs_token1')
    expect(server.calls).toHaveLength(1)
    await refresher.stop()
  })

  it('aborts the exchange in flight on stop', async () => {
    const { refresher, server, secrets, log } = harness()
    vi.mocked(server.fetcher).mockImplementation(async (url, init) => {
      server.calls.push({ url: new URL(String(url)), init: init! })
      return await new Promise<Response>((_, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('aborted'))))
    })
    refresher.start()
    await vi.waitFor(() => expect(server.calls).toHaveLength(1))
    await refresher.stop()
    expect(server.calls[0]!.init.signal!.aborted).toBe(true)
    expect(secrets.secrets.size).toBe(0)
    expect(log.lines).toEqual([])
  })

  it('redacts the identity token from an exchange error in the log', async () => {
    const { refresher, server, log, advance } = harness()
    vi.mocked(server.fetcher).mockImplementation(async () => { throw new TypeError(`bad header Bearer ${IDENTITY_TOKEN}`) })
    refresher.start()
    await advance(0)
    expect(log.lines.at(-1)!.text).toContain('bad header Bearer [redacted]')
    expect(JSON.stringify(log.lines)).not.toContain(IDENTITY_TOKEN)
    await refresher.stop()
  })
})

describe('plugin', () => {
  it('starts in an effect, looks sandboxManager up when delivering and stops on dispose', async () => {
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
      await vi.advanceTimersByTimeAsync(60 * MIN)
      expect(vi.mocked(fetcher)).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
