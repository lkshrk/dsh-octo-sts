import { randomBytes } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { OctoStsConfig } from './config.ts'
import { exchange } from './exchange.ts'

export const TOKEN_LIFETIME_MS = 60 * 60_000
export const WRITE_TIMEOUT_MS = 60_000
const FIRST_RETRY_MS = 60_000
const MAX_RETRY_MS = 5 * 60_000

export interface SecretStore { setWorkspaceSecret(repositoryUrl: string, name: string, value: string): Promise<unknown> }
export interface Logger { info(format: string, ...args: unknown[]): void; warn(format: string, ...args: unknown[]): void; error(format: string, ...args: unknown[]): void }
export interface RefresherDependencies {
  store(): SecretStore | undefined
  logger: Logger
  fetch?: typeof fetch
  now?: () => number
}

export class PermanentError extends Error {}

interface Destination { label: string; write(token: string): Promise<void> }
interface Delivery { issuedAt?: number; error?: string; permanent?: boolean }
interface Issued { token: string; issuedAt: number }

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

export async function readIdentityToken(path: string): Promise<string> {
  const token = (await readFile(path, 'utf8')).trim()
  if (!token) throw new Error(`${path} is empty`)
  return token
}

function destinations(config: OctoStsConfig, store: () => SecretStore | undefined): Destination[] {
  const result: Destination[] = []
  if (config.tokenFile) {
    const path = config.tokenFile
    result.push({ label: path, write: token => writeTokenFile(path, token) })
  }
  for (const workspace of new Set(config.workspaces)) {
    result.push({ label: workspace, write: async token => {
      const service = store()
      if (!service) throw new Error('the sandboxManager service is not available')
      try {
        await withTimeout(Promise.resolve().then(() => service.setWorkspaceSecret(workspace, config.secretName, token)), 'timed out')
      } catch (error) {
        if (/workspace is not registered/.test(message(error))) throw new PermanentError(message(error))
        throw error
      }
    } })
  }
  return result
}

export class TokenRefresher {
  private readonly controller = new AbortController()
  private readonly targets: Destination[]
  private readonly deliveries = new Map<string, Delivery>()
  private timer: NodeJS.Timeout | undefined
  private running: Promise<void> | undefined
  private current: Issued | undefined
  private failures = 0

  constructor(private readonly config: OctoStsConfig, private readonly dependencies: RefresherDependencies) {
    this.targets = destinations(config, dependencies.store)
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

  private now(): number { return (this.dependencies.now ?? Date.now)() }

  private schedule(delay: number): void {
    if (this.controller.signal.aborted) return
    this.timer = setTimeout(() => { this.running = this.round() }, delay)
    this.timer.unref?.()
  }

  private async round(): Promise<void> {
    const due = !this.current || this.now() >= this.current.issuedAt + this.interval
    let exchangeError: string | undefined
    if (due) {
      const issuedAt = this.now()
      let identityToken: string | undefined
      try {
        identityToken = await readIdentityToken(this.config.identityTokenFile)
        this.current = { token: await exchange(this.config, identityToken, this.dependencies.fetch ?? fetch, this.controller.signal), issuedAt }
      } catch (error) {
        exchangeError = redact(message(error), [identityToken])
      }
    }
    if (this.controller.signal.aborted) return
    const fresh = due && exchangeError === undefined
    const current = this.current
    if (current) {
      for (const target of this.targets) {
        const delivery = this.deliveries.get(target.label) ?? {}
        if (delivery.issuedAt === current.issuedAt || (delivery.permanent && !fresh)) continue
        try {
          await target.write(current.token)
          this.deliveries.set(target.label, { issuedAt: current.issuedAt })
        } catch (error) {
          this.deliveries.set(target.label, { issuedAt: delivery.issuedAt, error: redact(message(error), [current.token]), permanent: error instanceof PermanentError })
        }
        if (this.controller.signal.aborted) return
      }
    }
    this.schedule(this.report(fresh, exchangeError))
  }

  private report(fresh: boolean, exchangeError: string | undefined): number {
    const now = this.now()
    const failed = this.targets.flatMap(target => {
      const delivery = this.deliveries.get(target.label)
      return delivery?.error === undefined || delivery.issuedAt === this.current?.issuedAt ? [] : [{ label: target.label, ...delivery }]
    })
    const retrying = exchangeError !== undefined || failed.some(delivery => !delivery.permanent)
    const recovered = this.failures
    this.failures = retrying ? this.failures + 1 : 0
    const delay = retrying || !this.current ? retryDelayMs(this.failures) : Math.max(this.current.issuedAt + this.interval - now, 0)
    const problems = [...exchangeError === undefined ? [] : [`exchange failed: ${exchangeError}`],
      ...failed.map(delivery => `${delivery.label}${delivery.permanent ? ' (retried at the next exchange)' : ''}: ${delivery.error}`)]
    const name = `${this.config.scope}/${this.config.identity}`
    if (problems.length === 0) {
      if (fresh || recovered > 0) {
        this.log('info', 'dsh-octo-sts: %s token delivered to every destination%s; next exchange in %d min', name,
          recovered > 0 ? ` after ${recovered} failed attempts` : '', Math.round(delay / 60_000))
      }
      return delay
    }
    const valid = this.targets.some(target => {
      const issuedAt = this.deliveries.get(target.label)?.issuedAt
      return issuedAt !== undefined && issuedAt + TOKEN_LIFETIME_MS > now
    })
    this.log(valid ? 'warn' : 'error', 'dsh-octo-sts: %s %s; %s; next attempt in %d s', name, problems.join('; '),
      valid ? 'destinations keep their last token until it expires' : 'no destination holds a valid token', Math.round(delay / 1000))
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

async function withTimeout<T>(promise: Promise<T>, detail: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(detail)), WRITE_TIMEOUT_MS) })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}
