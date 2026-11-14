import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { format } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OctoStsConfigSchema, ownerSettings, type OctoStsConfig } from '../src/config.ts'
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

  it('refuses workspace URLs with credentials', () => {
    for (const workspace of ['https://user:pass@github.com/acme/widgets', 'https://token@github.com/acme/widgets', 'http://github.com/acme/widgets']) {
      expect(OctoStsConfigSchema.safeParse({ ...base, workspaces: [workspace] }).success, workspace).toBe(false)
    }
  })

  it('refuses an identity that is not one path segment, relative paths and unknown keys', () => {
    for (const identity of ['a/b', '..', '.', 'a b', '']) expect(OctoStsConfigSchema.safeParse({ ...base, identity }).success).toBe(false)
    expect(OctoStsConfigSchema.safeParse({ ...base, tokenFile: 'gh.token' }).success).toBe(false)
    expect(OctoStsConfigSchema.safeParse({ ...base, identityTokenFile: 'token' }).success).toBe(false)
    expect(OctoStsConfigSchema.safeParse({ ...base, extra: true }).success).toBe(false)
  })

  it('accepts only <owner> or <owner>/<repository> as scope', () => {
    for (const scope of ['acme', 'Acme-Corp', 'acme/widgets', 'acme/my.repo_name-2', ' acme ']) {
      expect(OctoStsConfigSchema.safeParse({ ...base, scope, workspaces: [], tokenFile: '/run/gh.token' }).success, scope).toBe(true)
    }
    for (const scope of ['', '-acme', 'ac_me', 'acme/', '/widgets', 'acme/widgets/x', 'acme/..', 'acme/.', 'acme/wid gets', 'a'.repeat(40), 'acme/a?b']) {
      const result = OctoStsConfigSchema.safeParse({ ...base, scope, workspaces: [], tokenFile: '/run/gh.token' })
      expect(result.success, scope).toBe(false)
      expect(result.error?.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`), scope).toContain('scope: must be <owner> or <owner>/<repository>')
    }
    expect(OctoStsConfigSchema.safeParse({ owners: [{ scope: 'acme/a/b', identity: 'dsh-yawn', tokenFile: '/run/gh.token' }] }).error?.issues[0])
      .toMatchObject({ path: ['owners', 0, 'scope'], message: 'must be <owner> or <owner>/<repository>' })
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

  describe('owners', () => {
    const GLOBEX = 'https://github.com/globex/app'
    const acme = { scope: 'acme', identity: 'dsh-yawn', workspaces: [WORKSPACE], tokenFile: '/run/acme.token' }
    const globex = { scope: 'globex', identity: 'dsh-yawn', workspaces: [GLOBEX], tokenFile: '/run/globex.token' }
    const issues = (input: Record<string, unknown>) => {
      const result = OctoStsConfigSchema.safeParse(input)
      return result.success ? [] : result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`)
    }

    it('splits into one owner per entry with the shared keys', () => {
      const parsed = OctoStsConfigSchema.parse({ refreshMinutes: 10, secretName: 'GH', owners: [acme, { scope: 'globex', identity: 'bot', tokenFile: '/run/globex.token' }] })
      expect(ownerSettings(parsed)).toEqual([
        expect.objectContaining({ ...acme, refreshMinutes: 10, secretName: 'GH', sts: 'https://sts.h-cloud.io', registerWorkspaces: true }),
        expect.objectContaining({ scope: 'globex', identity: 'bot', workspaces: [], tokenFile: '/run/globex.token', refreshMinutes: 10 }),
      ])
    })

    it('keeps the single-owner form as one owner', () => {
      const parsed = OctoStsConfigSchema.parse(base)
      expect(parsed.owners).toBeUndefined()
      expect(ownerSettings(parsed)).toEqual([expect.objectContaining({ scope: 'acme', identity: 'dsh-yawn', workspaces: [WORKSPACE], tokenFile: undefined, secretName: 'GITHUB_TOKEN' })])
    })

    it('refuses mixing owners with the single-owner keys', () => {
      for (const key of ['scope', 'identity', 'workspaces', 'tokenFile'] as const) {
        expect(issues({ owners: [acme], [key]: base[key as keyof typeof base] ?? '/run/gh.token' }), key).toEqual([`${key}: set ${key} inside owners, not next to it`])
      }
      expect(issues({ owners: [] })).not.toEqual([])
      expect(issues({ identity: 'dsh-yawn', tokenFile: '/run/gh.token' })).toEqual(['scope: set scope and identity, or owners'])
    })

    it('refuses two owners sharing a token file', () => {
      expect(issues({ owners: [acme, { ...globex, tokenFile: '/run/../run/acme.token' }] })).toEqual(['owners.1.tokenFile: /run/acme.token is already the tokenFile of owners[0]'])
    })

    it('refuses a workspace outside its owner', () => {
      expect(issues({ owners: [acme, { ...globex, workspaces: [GLOBEX, OTHER] }] })).toEqual([`owners.1.workspaces.1: ${OTHER} does not belong to globex, the owner of scope globex`])
      expect(issues({ owners: [acme, { ...acme, identity: 'other', tokenFile: undefined, workspaces: [`${WORKSPACE}/`] }] })).toEqual([`owners.1.workspaces.0: ${WORKSPACE}/ is already a workspace of owners[0]`])
      expect(issues({ owners: [{ ...acme, workspaces: ['https://gitlab.com/acme/widgets'] }] })).toEqual(['owners.0.workspaces.0: https://gitlab.com/acme/widgets must be https://github.com/<owner>/<repository>'])
      expect(issues({ owners: [{ ...acme, scope: 'acme/widgets', workspaces: [WORKSPACE, OTHER] }] })).toEqual([`owners.0.workspaces.1: ${OTHER} is outside scope acme/widgets`])
      expect(issues({ owners: [{ ...acme, scope: 'ACME', workspaces: [WORKSPACE, 'https://github.com/Acme/Other.git'] }] })).toEqual([])
    })

    it('checks the single-owner form\'s workspaces against its scope too', () => {
      expect(issues({ ...base, workspaces: [WORKSPACE, GLOBEX] })).toEqual([`workspaces.1: ${GLOBEX} does not belong to acme, the owner of scope acme`])
      expect(issues({ ...base, scope: 'acme/widgets', workspaces: [WORKSPACE, OTHER] })).toEqual([`workspaces.1: ${OTHER} is outside scope acme/widgets`])
      expect(issues({ ...base, scope: 'Acme', workspaces: ['https://github.com/ACME/Widgets'] })).toEqual([])
    })

    it('refuses the same scope and identity twice and an owner without a destination', () => {
      expect(issues({ owners: [acme, { ...acme, workspaces: [], tokenFile: '/run/second.token' }] })).toEqual(['owners.1: scope acme with identity dsh-yawn is listed twice'])
      expect(issues({ owners: [acme, { ...acme, scope: 'ACME', workspaces: [], tokenFile: '/run/second.token' }] })).toEqual(['owners.1: scope ACME with identity dsh-yawn is listed twice'])
      expect(issues({ owners: [acme, { ...acme, identity: 'DSH-yawn', workspaces: [], tokenFile: '/run/second.token' }] })).toEqual([])
      expect(issues({ owners: [{ scope: 'acme', identity: 'dsh-yawn' }] })).toEqual(['owners.0: set workspaces, tokenFile or both'])
      expect(issues({ owners: [{ ...acme, extra: true }] })).not.toEqual([])
    })
  })

  it('is a standard schema Cordis can validate', () => {
    expect(typeof Config['~standard'].validate).toBe('function')
  })
})

describe('exchange', () => {
  const signal = () => new AbortController().signal
  const request = { sts: 'https://sts.example.test', scope: 'acme', identity: 'dsh-yawn' }

  it('sends the identity token as a bearer with scope and identity and refuses redirects', async () => {
    const { fetcher, calls } = sts()
    await expect(exchange(request, IDENTITY_TOKEN, fetcher, signal())).resolves.toBe('ghs_token1')
    expect(calls[0]!.url.toString()).toBe('https://sts.example.test/sts/exchange?scope=acme&identity=dsh-yawn')
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${IDENTITY_TOKEN}`)
    expect(calls[0]!.init.redirect).toBe('error')
  })

  it('reports the status and octo-sts message on refusal', async () => {
    const { fetcher, answers } = sts()
    answers.push(refused(401, 'unable to verify bearer token'))
    await expect(exchange(request, IDENTITY_TOKEN, fetcher, signal())).rejects.toThrow('octo-sts answered 401: unable to verify bearer token')
  })

  it('refuses an answer without a token', async () => {
    const { fetcher, answers } = sts()
    answers.push(() => Response.json({ token: '' }), () => new Response('not json'))
    await expect(exchange(request, IDENTITY_TOKEN, fetcher, signal())).rejects.toThrow('without a token')
    await expect(exchange(request, IDENTITY_TOKEN, fetcher, signal())).rejects.toThrow('without a token')
  })

  it('names the network cause of a failed fetch without the identity token', async () => {
    const failing = (cause: unknown) => vi.fn(async () => { throw new TypeError('fetch failed', { cause }) }) as unknown as typeof fetch
    const refusedConnection = Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:443'), { code: 'ECONNREFUSED' })
    await expect(exchange(request, IDENTITY_TOKEN, failing(refusedConnection), signal())).rejects.toThrow(/^fetch failed: ECONNREFUSED$/)
    await expect(exchange(request, IDENTITY_TOKEN, failing(new Error(`certificate has expired\nfor ${IDENTITY_TOKEN}`)), signal()))
      .rejects.toThrow(/^fetch failed: certificate has expired for \[redacted\]$/)
    await expect(exchange(request, IDENTITY_TOKEN, failing(undefined), signal())).rejects.toThrow(/^fetch failed$/)
  })

  it('strips control characters from the octo-sts message and keeps 200 characters', async () => {
    const { fetcher, answers } = sts()
    answers.push(refused(400, 'bad\nrequest\r\n\u001b[31mforged line'), refused(400, 'x'.repeat(250)))
    await expect(exchange(request, IDENTITY_TOKEN, fetcher, signal())).rejects.toThrow(/^octo-sts answered 400: bad request \[31mforged line$/)
    await expect(exchange(request, IDENTITY_TOKEN, fetcher, signal())).rejects.toThrow(new RegExp(`^octo-sts answered 400: x{200}$`))
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
    secrets.registered.add(WORKSPACE).add(OTHER)
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

  it('registers a workspace only when dsh-yawn does not know it, then sets the secret', async () => {
    const { refresher, secrets, log, advance } = harness({ workspaces: [WORKSPACE, OTHER] })
    secrets.registered.add(WORKSPACE)
    refresher.start()
    await advance(0)
    expect(secrets.createRepositoryWorkspace.mock.calls.map(call => call[0])).toEqual([OTHER])
    expect(secrets.secrets.get(`${WORKSPACE} GITHUB_TOKEN`)).toBe('ghs_token1')
    expect(secrets.secrets.get(`${OTHER} GITHUB_TOKEN`)).toBe('ghs_token1')
    await advance(60 * MIN)
    expect(secrets.secrets.get(`${OTHER} GITHUB_TOKEN`)).toBe('ghs_token3')
    expect(secrets.createRepositoryWorkspace).toHaveBeenCalledTimes(1)
    expect(log.lines.map(line => line.level)).toEqual(['info', 'info', 'info'])
    await refresher.stop()
  })

  it('never touches registration for an existing workspace, even when registering would fail', async () => {
    const { refresher, secrets, log, advance } = harness()
    secrets.registered.add(WORKSPACE)
    secrets.breakRegistry(() => new Error('repository anchor hash collision'))
    refresher.start()
    await advance(0)
    expect(secrets.createRepositoryWorkspace).not.toHaveBeenCalled()
    expect(secrets.secrets.get(`${WORKSPACE} GITHUB_TOKEN`)).toBe('ghs_token1')
    expect(log.lines.map(line => line.level)).toEqual(['info'])
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

  it('treats a missing Web profile as permanent: warns, still writes the file and retries at the next exchange', async () => {
    const { refresher, server, secrets, log, advance } = harness()
    secrets.breakRegistry(() => new Error('repository workspaces require the dsh Web profile'))
    refresher.start()
    await advance(0)
    expect(tokenFile()).toBe('ghs_token1')
    expect(log.lines.at(-1)).toMatchObject({ level: 'warn' })
    expect(log.lines.at(-1)!.text).toContain(`${WORKSPACE} (retried at the next exchange): could not register the workspace: repository workspaces require the dsh Web profile`)
    secrets.breakRegistry(undefined)
    await advance(30 * MIN - 1_000)
    expect(secrets.createRepositoryWorkspace).toHaveBeenCalledTimes(1)
    await advance(1_000)
    expect(server.calls).toHaveLength(2)
    expect(secrets.secrets.get(`${WORKSPACE} GITHUB_TOKEN`)).toBe('ghs_token2')
    await refresher.stop()
  })

  it('treats a sandboxManager without createRepositoryWorkspace as permanent', async () => {
    const { refresher, secrets, log, advance } = harness()
    delete (secrets.value as { createRepositoryWorkspace?: unknown }).createRepositoryWorkspace
    refresher.start()
    await advance(0)
    expect(log.lines.at(-1)).toMatchObject({ level: 'warn' })
    expect(log.lines.at(-1)!.text).toContain('(retried at the next exchange): could not register the workspace: sandboxManager has no createRepositoryWorkspace')
    expect(tokenFile()).toBe('ghs_token1')
    const before = secrets.setWorkspaceSecret.mock.calls.length
    await advance(30 * MIN - 1_000)
    expect(secrets.setWorkspaceSecret.mock.calls.length).toBe(before)
    await refresher.stop()
  })

  it('does not start a second registration while a slow one is still running', async () => {
    const { refresher, secrets, log } = harness()
    let finish: () => void = () => {}
    secrets.createRepositoryWorkspace.mockImplementationOnce(async (url: string) => {
      await new Promise<void>(resolve => { finish = resolve })
      secrets.registered.add(url)
      return ''
    })
    refresher.start()
    await vi.waitFor(() => expect(secrets.createRepositoryWorkspace).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(5 * MIN)
    await refresher.settled()
    expect(log.lines.at(-1)).toMatchObject({ level: 'warn' })
    expect(log.lines.at(-1)!.text).toContain(`${WORKSPACE}: could not register the workspace: timed out`)
    await vi.advanceTimersByTimeAsync(MIN)
    await vi.waitFor(() => expect(secrets.setWorkspaceSecret).toHaveBeenCalledTimes(2))
    expect(secrets.createRepositoryWorkspace).toHaveBeenCalledTimes(1)
    finish()
    await refresher.settled()
    expect(secrets.createRepositoryWorkspace).toHaveBeenCalledTimes(1)
    expect(secrets.secrets.get(`${WORKSPACE} GITHUB_TOKEN`)).toBe('ghs_token1')
    expect(log.lines.at(-1)).toMatchObject({ level: 'info' })
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

  it('delivers the current token again within a minute to a new sandboxManager instance, without a new exchange', async () => {
    vi.useFakeTimers()
    const server = sts()
    let secrets = store({ registered: [WORKSPACE] })
    const log = logger()
    const refresher = new TokenRefresher(config(), { store: () => secrets.value, logger: log, fetch: server.fetcher, now: Date.now })
    refresher.start()
    await vi.advanceTimersByTimeAsync(0)
    await refresher.settled()
    expect(secrets.secrets.get(`${WORKSPACE} GITHUB_TOKEN`)).toBe('ghs_token1')
    await vi.advanceTimersByTimeAsync(5 * MIN)
    await refresher.settled()
    expect(secrets.setWorkspaceSecret).toHaveBeenCalledTimes(1)
    secrets = store({ registered: [WORKSPACE] })
    await vi.advanceTimersByTimeAsync(MIN)
    await refresher.settled()
    expect(secrets.secrets.get(`${WORKSPACE} GITHUB_TOKEN`)).toBe('ghs_token1')
    expect(server.calls).toHaveLength(1)
    expect(log.lines).toEqual([{ level: 'info', text: 'dsh-octo-sts: acme/dsh-yawn token delivered to every destination; next exchange in 30 min' }])
    await refresher.stop()
  })

  it('writes the token file again within a minute when it was deleted, without a new exchange', async () => {
    const { refresher, server, secrets, log, advance } = harness()
    secrets.registered.add(WORKSPACE)
    refresher.start()
    await advance(0)
    rmSync(join(dir, 'run', 'gh.token'))
    await advance(MIN)
    expect(tokenFile()).toBe('ghs_token1')
    expect(server.calls).toHaveLength(1)
    expect(secrets.setWorkspaceSecret).toHaveBeenCalledTimes(1)
    expect(log.lines.map(line => line.level)).toEqual(['info'])
    await refresher.stop()
  })

  it('delivers to every other destination while one write hangs', async () => {
    const { refresher, secrets, log } = harness({ workspaces: [WORKSPACE, OTHER] })
    secrets.registered.add(WORKSPACE).add(OTHER)
    secrets.setWorkspaceSecret.mockImplementation(async (url: string, name: string, secret: string) => {
      if (url === WORKSPACE) return await new Promise(() => {})
      secrets.secrets.set(`${url} ${name}`, secret)
      return {}
    })
    refresher.start()
    await vi.waitFor(() => expect(secrets.secrets.get(`${OTHER} GITHUB_TOKEN`)).toBe('ghs_token1'))
    expect(tokenFile()).toBe('ghs_token1')
    expect(log.lines).toEqual([])
    await vi.advanceTimersByTimeAsync(60_000)
    await refresher.settled()
    expect(log.lines.at(-1)!.text).toContain(`${WORKSPACE}: timed out`)
    await refresher.stop()
  })

  it('stops at once while a workspace write or registration hangs', async () => {
    for (const hung of ['write', 'registration'] as const) {
      const { refresher, secrets } = harness()
      if (hung === 'write') secrets.setWorkspaceSecret.mockImplementation(() => new Promise(() => {}))
      else secrets.createRepositoryWorkspace.mockImplementation(() => new Promise(() => {}))
      refresher.start()
      await vi.waitFor(() => expect(hung === 'write' ? secrets.setWorkspaceSecret : secrets.createRepositoryWorkspace).toHaveBeenCalled())
      let stopped = false
      const stopping = refresher.stop().then(() => { stopped = true })
      await vi.waitFor(() => expect(stopped, hung).toBe(true))
      await stopping
      vi.useRealTimers()
    }
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

describe('TokenRefresher with several owners', () => {
  const GLOBEX = 'https://github.com/globex/app'
  const ownersConfig = () => OctoStsConfigSchema.parse({
    sts: 'https://sts.example.test', identityTokenFile: join(dir, 'sa-token'), refreshMinutes: 30,
    owners: [
      { scope: 'acme', identity: 'dsh-yawn', workspaces: [WORKSPACE], tokenFile: join(dir, 'run', 'acme.token') },
      { scope: 'globex', identity: 'dsh-yawn', workspaces: [GLOBEX], tokenFile: join(dir, 'run', 'globex.token') },
    ],
  })
  const read = (owner: string) => readFileSync(join(dir, 'run', `${owner}.token`), 'utf8')

  function owners() {
    vi.useFakeTimers()
    const issued = new Map<string, number>()
    const refusing = new Set<string>()
    const calls: string[] = []
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const scope = new URL(String(url)).searchParams.get('scope')!
      calls.push(scope)
      if (refusing.has(scope)) return Response.json({ message: `${scope} refused` }, { status: 403 })
      const count = (issued.get(scope) ?? 0) + 1
      issued.set(scope, count)
      return Response.json({ token: `ghs_${scope}${count}` })
    }) as unknown as typeof fetch
    const secrets = store()
    const log = logger()
    const refresher = new TokenRefresher(ownersConfig(), { store: () => secrets.value, logger: log, fetch: fetcher, now: Date.now })
    const advance = async (ms: number) => {
      for (let left = ms; ; left -= 1_000) {
        await vi.advanceTimersByTimeAsync(Math.min(left, 1_000))
        await refresher.settled()
        if (left <= 1_000) return
      }
    }
    return { refresher, calls, refusing, secrets, log, advance }
  }

  it('exchanges per owner and delivers each token only to that owner\'s destinations', async () => {
    const { refresher, calls, secrets, advance } = owners()
    refresher.start()
    await advance(0)
    expect(calls.toSorted()).toEqual(['acme', 'globex'])
    expect(read('acme')).toBe('ghs_acme1')
    expect(read('globex')).toBe('ghs_globex1')
    expect(statSync(join(dir, 'run', 'globex.token')).mode & 0o777).toBe(0o600)
    expect(secrets.secrets.get(`${WORKSPACE} GITHUB_TOKEN`)).toBe('ghs_acme1')
    expect(secrets.secrets.get(`${GLOBEX} GITHUB_TOKEN`)).toBe('ghs_globex1')
    await advance(30 * MIN)
    expect(read('acme')).toBe('ghs_acme2')
    expect(read('globex')).toBe('ghs_globex2')
    await refresher.stop()
  })

  it('keeps refreshing one owner while the other\'s exchange fails, each on its own schedule', async () => {
    const { refresher, calls, refusing, secrets, log, advance } = owners()
    refusing.add('globex')
    refresher.start()
    await advance(0)
    expect(read('acme')).toBe('ghs_acme1')
    expect(secrets.secrets.get(`${WORKSPACE} GITHUB_TOKEN`)).toBe('ghs_acme1')
    expect(secrets.secrets.has(`${GLOBEX} GITHUB_TOKEN`)).toBe(false)
    expect(() => read('globex')).toThrow()
    expect(log.lines).toContainEqual({ level: 'info', text: expect.stringContaining('acme/dsh-yawn token delivered') })
    expect(log.lines).toContainEqual({ level: 'error', text: expect.stringContaining('globex/dsh-yawn exchange failed: octo-sts answered 403: globex refused') })
    await advance(MIN + 2 * MIN + 4 * MIN)
    expect(calls.filter(scope => scope === 'globex')).toHaveLength(4)
    expect(calls.filter(scope => scope === 'acme')).toHaveLength(1)
    refusing.clear()
    await advance(5 * MIN)
    expect(read('globex')).toBe('ghs_globex1')
    expect(secrets.secrets.get(`${GLOBEX} GITHUB_TOKEN`)).toBe('ghs_globex1')
    await advance(30 * MIN - 12 * MIN - 1_000)
    expect(calls.filter(scope => scope === 'acme')).toHaveLength(1)
    await advance(1_000)
    expect(calls.filter(scope => scope === 'acme')).toHaveLength(2)
    expect(read('acme')).toBe('ghs_acme2')
    expect(read('globex')).toBe('ghs_globex1')
    await refresher.stop()
  })

  it('keeps one owner on schedule while the other\'s registration hangs', async () => {
    const { refresher, calls, secrets, log } = owners()
    secrets.registered.add(GLOBEX)
    secrets.createRepositoryWorkspace.mockImplementation(() => new Promise(() => undefined))
    refresher.start()
    await vi.advanceTimersByTimeAsync(0)
    await vi.waitFor(() => expect(secrets.createRepositoryWorkspace).toHaveBeenCalledWith(WORKSPACE))
    expect(read('acme')).toBe('ghs_acme1')
    expect(read('globex')).toBe('ghs_globex1')
    expect(secrets.secrets.get(`${GLOBEX} GITHUB_TOKEN`)).toBe('ghs_globex1')
    for (let elapsed = 0; elapsed < 30 * MIN; elapsed += 1_000) await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(secrets.secrets.get(`${GLOBEX} GITHUB_TOKEN`)).toBe('ghs_globex2'))
    expect(calls.filter(scope => scope === 'globex')).toHaveLength(2)
    expect(read('globex')).toBe('ghs_globex2')
    expect(secrets.createRepositoryWorkspace).toHaveBeenCalledTimes(1)
    expect(log.lines).toContainEqual({ level: 'warn', text: expect.stringContaining(`acme/dsh-yawn ${WORKSPACE}: could not register the workspace: timed out`) })
    const stopping = refresher.stop()
    await vi.advanceTimersByTimeAsync(5 * MIN)
    await stopping
  })

  it('stops every owner on stop', async () => {
    const { refresher, calls, advance } = owners()
    refresher.start()
    await advance(0)
    await refresher.stop()
    await advance(60 * MIN)
    expect(calls).toHaveLength(2)
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
