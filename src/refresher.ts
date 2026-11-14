import { randomBytes } from 'node:crypto'
import { access, mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { ownerSettings, type OctoStsConfig, type OwnerSettings } from './config.ts'
import { exchange, ExchangeRefused } from './exchange.ts'

export const TOKEN_LIFETIME_MS = 60 * 60_000
export const WRITE_TIMEOUT_MS = 60_000
export const REGISTER_TIMEOUT_MS = 5 * 60_000
const FIRST_RETRY_MS = 60_000
const MAX_RETRY_MS = 5 * 60_000
const HOLD_CHECK_MS = 60_000

export interface SecretStore {
  setWorkspaceSecret(repositoryUrl: string, name: string, value: string): Promise<unknown>
  createRepositoryWorkspace?(repositoryUrl: string): Promise<unknown>
}
export interface Logger { info(format: string, ...args: unknown[]): void; warn(format: string, ...args: unknown[]): void; error(format: string, ...args: unknown[]): void }
export interface RefresherDependencies {
  store(): SecretStore | undefined
  logger: Logger
  fetch?: typeof fetch
  now?: () => number
}

export class PermanentError extends Error {}

interface Destination { label: string; write(token: string, signal: AbortSignal): Promise<unknown>; holds(marker: unknown): Promise<boolean> }
interface Delivery { issuedAt?: number; marker?: unknown; error?: string; permanent?: boolean }
interface Issued { token: string; issuedAt: number }
interface ExchangeFailure { text: string; permanent: boolean; retryAfterMs?: number }

export const retryDelayMs = (failures: number): number => Math.min(FIRST_RETRY_MS * 2 ** Math.max(failures - 1, 0), MAX_RETRY_MS)

export async function writeTokenFile(path: string, token: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`
  let created = false
  try {
    const handle = await open(temporary, 'wx', 0o600)
    created = true
    try {
      await handle.writeFile(token)
    } finally {
      await handle.close()
    }
    await rename(temporary, path)
  } catch (error) {
    if (created) await rm(temporary, { force: true })
    throw error
  }
}

export async function removeTemporaryFiles(path: string): Promise<void> {
  const prefix = `${basename(path)}.`
  const entries = await readdir(dirname(path)).catch(() => [] as string[])
  for (const entry of entries) {
    if (entry.startsWith(prefix) && /^[0-9a-f]{16}\.tmp$/.test(entry.slice(prefix.length))) await rm(join(dirname(path), entry), { force: true })
  }
}

export async function readIdentityToken(path: string): Promise<string> {
  const token = (await readFile(path, 'utf8')).trim()
  if (!token) throw new Error(`${path} is empty`)
  return token
}

type Registrations = Map<string, Promise<unknown>>

const CORDIS_ORIGINAL = Symbol.for('cordis.original')
// cordis wraps a service in a new proxy on every ctx.get, so compare the instance behind it.
const serviceIdentity = (service: SecretStore | undefined): unknown => (service as { [CORDIS_ORIGINAL]?: unknown } | undefined)?.[CORDIS_ORIGINAL] ?? service

function destinations(config: OwnerSettings, store: () => SecretStore | undefined, registering: Registrations): Destination[] {
  const result: Destination[] = []
  if (config.tokenFile) {
    const path = config.tokenFile
    result.push({ label: path, write: token => writeTokenFile(path, token), holds: () => access(path).then(() => true, () => false) })
  }
  const register = async (service: SecretStore, workspace: string, signal: AbortSignal) => {
    if (!service.createRepositoryWorkspace) throw new PermanentError('could not register the workspace: sandboxManager has no createRepositoryWorkspace')
    let pending = registering.get(workspace)
    if (!pending) {
      const created = Promise.resolve().then(() => service.createRepositoryWorkspace!(workspace))
      pending = created.finally(() => { registering.delete(workspace) })
      pending.catch(() => undefined)
      registering.set(workspace, pending)
    }
    try {
      await withTimeout(pending, 'timed out', REGISTER_TIMEOUT_MS, signal)
    } catch (error) {
      const detail = `could not register the workspace: ${message(error)}`
      throw /require the dsh Web profile/.test(message(error)) ? new PermanentError(detail) : new Error(detail)
    }
  }
  const set = (service: SecretStore, workspace: string, token: string, signal: AbortSignal) =>
    withTimeout(Promise.resolve().then(() => service.setWorkspaceSecret(workspace, config.secretName, token)), 'timed out', WRITE_TIMEOUT_MS, signal)
  const unregistered = (error: unknown) => /workspace is not registered/.test(message(error))
  for (const workspace of new Set(config.workspaces)) {
    result.push({ label: workspace, write: async (token, signal) => {
      const service = store()
      if (!service) throw new Error('the sandboxManager service is not available')
      try {
        await set(service, workspace, token, signal)
        return serviceIdentity(service)
      } catch (error) {
        if (!unregistered(error)) throw error
        if (!config.registerWorkspaces) throw new PermanentError(message(error))
        await register(service, workspace, signal)
        await set(service, workspace, token, signal).catch((retry: unknown) => { throw unregistered(retry) ? new PermanentError(message(retry)) : retry })
        return serviceIdentity(service)
      }
    }, holds: async marker => {
      try {
        return serviceIdentity(store()) === marker
      } catch {
        return false
      }
    } })
  }
  return result
}

export class TokenRefresher {
  private readonly owners: OwnerRefresher[]

  constructor(config: OctoStsConfig, dependencies: RefresherDependencies) {
    const registering: Registrations = new Map()
    this.owners = ownerSettings(config).map(owner => new OwnerRefresher(owner, dependencies, registering))
  }

  start(): void { for (const owner of this.owners) owner.start() }

  async settled(): Promise<void> { await Promise.all(this.owners.map(owner => owner.settled())) }

  async stop(): Promise<void> { await Promise.all(this.owners.map(owner => owner.stop())) }
}

class OwnerRefresher {
  private readonly controller = new AbortController()
  private readonly targets: Destination[]
  private readonly deliveries = new Map<string, Delivery>()
  private timer: NodeJS.Timeout | undefined
  private running: Promise<void> | undefined
  private current: Issued | undefined
  private exchangeAt = -Infinity
  private exchangeFailure: ExchangeFailure | undefined
  private failures = 0
  private repeated: string | undefined
  private started = false

  constructor(private readonly config: OwnerSettings, private readonly dependencies: RefresherDependencies, registering: Registrations) {
    this.targets = destinations(config, dependencies.store, registering)
  }

  start(): void { this.schedule(0) }

  async settled(): Promise<void> { await this.running }

  async stop(): Promise<void> {
    this.controller.abort()
    clearTimeout(this.timer)
    await this.running
    this.current = undefined
  }

  private get interval(): number { return this.config.refreshMinutes * 60_000 }

  private now(): number { return this.dependencies.now ? this.dependencies.now() : performance.now() }

  private schedule(delay: number): void {
    if (this.controller.signal.aborted) return
    this.timer = setTimeout(() => { this.running = this.round().catch((error: unknown) => this.recover(error)) }, delay)
    this.timer.unref?.()
  }

  private async round(): Promise<void> {
    if (!this.started) {
      this.started = true
      if (this.config.tokenFile) await removeTemporaryFiles(this.config.tokenFile).catch(() => undefined)
    }
    const due = this.now() >= this.exchangeAt
    if (due) {
      const issuedAt = this.now()
      let identityToken: string | undefined
      try {
        identityToken = await readIdentityToken(this.config.identityTokenFile)
        this.current = { token: await exchange(this.config, identityToken, this.dependencies.fetch ?? fetch, this.controller.signal), issuedAt }
        this.exchangeAt = issuedAt + this.interval
        this.exchangeFailure = undefined
      } catch (error) {
        const refused = error instanceof ExchangeRefused ? error : undefined
        this.exchangeFailure = { text: redact(message(error), [identityToken]), permanent: refused?.permanent ?? false, retryAfterMs: refused?.retryAfterMs }
        if (this.exchangeFailure.permanent) this.exchangeAt = this.now() + this.interval
      }
    }
    if (this.controller.signal.aborted) return
    const fresh = due && this.exchangeFailure === undefined
    const current = this.current
    let attempted = false
    if (current) {
      const results = await Promise.allSettled(this.targets.map(target => this.deliver(target, current, fresh)))
      if (this.controller.signal.aborted) return
      const outcomes = results.map(result => result.status === 'fulfilled' ? result.value : undefined)
      attempted = outcomes.some(outcome => outcome !== undefined)
      const again = this.targets.filter((_, index) => outcomes[index] === 'redelivered').map(target => target.label)
      if (again.length > 0) this.log('info', 'dsh-octo-sts: %s token delivered again to %s, which had lost it', `${this.config.scope}/${this.config.identity}`, again.join(', '))
    }
    this.schedule(this.report(fresh, !due && !attempted))
  }

  private recover(error: unknown): void {
    this.failures += 1
    const delay = retryDelayMs(this.failures)
    this.log('error', 'dsh-octo-sts: %s refresh failed: %s; next attempt in %d s', `${this.config.scope}/${this.config.identity}`,
      redact(message(error), [this.current?.token]), Math.round(delay / 1000))
    this.schedule(delay)
  }

  private async deliver(target: Destination, current: Issued, fresh: boolean): Promise<'written' | 'redelivered' | 'failed' | undefined> {
    const delivery = this.deliveries.get(target.label) ?? {}
    const lost = delivery.issuedAt === current.issuedAt && delivery.error === undefined
    if (lost && await target.holds(delivery.marker)) return undefined
    if (delivery.permanent && !fresh) return undefined
    try {
      const marker = await target.write(current.token, this.controller.signal)
      this.deliveries.set(target.label, { issuedAt: current.issuedAt, marker })
      return lost ? 'redelivered' : 'written'
    } catch (error) {
      this.deliveries.set(target.label, { issuedAt: delivery.issuedAt, error: redact(message(error), [current.token]), permanent: error instanceof PermanentError })
      return 'failed'
    }
  }

  private report(fresh: boolean, quiet: boolean): number {
    const now = this.now()
    const untilExchange = Math.max(this.exchangeAt - now, 0)
    if (quiet) return Math.min(untilExchange, HOLD_CHECK_MS)
    const exchangeError = this.exchangeFailure
    const failed = this.targets.flatMap(target => {
      const delivery = this.deliveries.get(target.label)
      return delivery?.error === undefined ? [] : [{ label: target.label, ...delivery }]
    })
    const retrying = exchangeError !== undefined || failed.some(delivery => !delivery.permanent)
    const recovered = this.failures
    this.failures = retrying ? this.failures + 1 : 0
    const backingOff = retrying && !exchangeError?.permanent
    const next = backingOff ? Math.max(retryDelayMs(this.failures), Math.min(exchangeError?.retryAfterMs ?? 0, this.interval)) : untilExchange
    const delay = backingOff ? next : Math.min(next, HOLD_CHECK_MS)
    const problems = [...exchangeError === undefined ? [] : [`exchange failed: ${exchangeError.text}`],
      ...failed.map(delivery => `${delivery.label}${delivery.permanent ? ' (retried at the next exchange)' : ''}: ${delivery.error}`)]
    const name = `${this.config.scope}/${this.config.identity}`
    if (problems.length === 0) {
      this.repeated = undefined
      if (fresh || recovered > 0) {
        this.log('info', 'dsh-octo-sts: %s token delivered to every destination%s; next exchange in %d min', name,
          recovered > 0 ? ` after ${recovered} failed attempts` : '', Math.round(next / 60_000))
      }
      return delay
    }
    const valid = this.targets.some(target => {
      const issuedAt = this.deliveries.get(target.label)?.issuedAt
      return issuedAt !== undefined && issuedAt + TOKEN_LIFETIME_MS > now
    })
    const level = valid ? 'warn' : 'error'
    const key = exchangeError?.permanent ? `${level} ${problems.join('; ')}` : undefined
    if (key !== undefined && key === this.repeated) return delay
    this.repeated = key
    this.log(level, 'dsh-octo-sts: %s %s; %s; next attempt in %d s', name, problems.join('; '),
      valid ? 'destinations keep their last token until it expires' : 'no destination holds a valid token', Math.round(next / 1000))
    return delay
  }

  private log(level: keyof Logger, format: string, ...args: unknown[]): void {
    try {
      this.dependencies.logger[level](format, ...args)
    } catch { /* a logger failure must not stop the loop */ }
  }
}

function redact(text: string, secrets: (string | undefined)[]): string {
  return secrets.reduce<string>((result, secret) => secret ? result.replaceAll(secret, '[redacted]') : result, text)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function withTimeout<T>(promise: Promise<T>, detail: string, ms: number, signal: AbortSignal): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  let onAbort: (() => void) | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(detail)), ms)
    onAbort = () => reject(new Error('stopped'))
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort!)
  }
}
