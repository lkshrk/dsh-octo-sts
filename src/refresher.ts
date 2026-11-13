import { chmod, readFile, rename, rm, writeFile } from 'node:fs/promises'
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
export interface Health { state: 'starting' | 'ready' | 'failing' | 'expired' | 'stopped'; detail: string; failures: number; refreshedAt?: string; expiresAt?: string }

export const retryDelayMs = (failures: number): number => Math.min(FIRST_RETRY_MS * 2 ** Math.max(failures - 1, 0), MAX_RETRY_MS)

export async function writeTokenFile(path: string, token: string): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`
  try {
    await writeFile(temporary, token, { mode: 0o600 })
    await chmod(temporary, 0o600)
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

export async function refreshOnce(config: OctoStsConfig, dependencies: RefresherDependencies, signal: AbortSignal): Promise<void> {
  const secrets: string[] = []
  try {
    const identityToken = (await readFile(config.identityTokenFile, 'utf8')).trim()
    if (!identityToken) throw new Error(`${config.identityTokenFile} is empty`)
    secrets.push(identityToken)
    const token = await exchange(config, identityToken, dependencies.fetch ?? fetch, signal)
    secrets.push(token)
    const failures: string[] = []
    if (config.tokenFile) await writeTokenFile(config.tokenFile, token).catch((error: unknown) => { failures.push(`${config.tokenFile}: ${message(error)}`) })
    if (config.workspaces.length > 0) {
      const store = dependencies.store()
      if (!store) failures.push('the sandboxManager service is not available')
      else for (const workspace of config.workspaces) {
        await withTimeout(Promise.resolve().then(() => store.setWorkspaceSecret(workspace, config.secretName, token)), `${workspace}: timed out`)
          .catch((error: unknown) => { failures.push(`${workspace}: ${message(error)}`) })
      }
    }
    if (failures.length > 0) throw new Error(`could not store the token: ${failures.join('; ')}`)
  } catch (error) {
    throw new Error(secrets.reduce((text, secret) => text.replaceAll(secret, '[redacted]'), message(error)))
  }
}

export class TokenRefresher {
  private readonly controller = new AbortController()
  private timer: NodeJS.Timeout | undefined
  private running: Promise<void> | undefined
  private failures = 0
  private refreshedAt: number | undefined
  private status: Health = { state: 'starting', detail: 'waiting for the first exchange', failures: 0 }

  constructor(private readonly config: OctoStsConfig, private readonly dependencies: RefresherDependencies) {}

  start(): void { this.schedule(0) }

  health(): Health {
    const lapsed = this.status.state === 'failing' && this.status.expiresAt !== undefined && Date.parse(this.status.expiresAt) <= this.now()
    return { ...this.status, state: lapsed ? 'expired' : this.status.state }
  }

  async settled(): Promise<void> { await this.running }

  async stop(): Promise<void> {
    this.controller.abort()
    clearTimeout(this.timer)
    await this.running
    this.status = { ...this.status, state: 'stopped', detail: 'stopped' }
  }

  private now(): number { return (this.dependencies.now ?? Date.now)() }

  private schedule(delay: number): void {
    if (this.controller.signal.aborted) return
    this.timer = setTimeout(() => { this.running = this.round() }, delay)
    this.timer.unref?.()
  }

  private async round(): Promise<void> {
    let delay: number
    try {
      await refreshOnce(this.config, this.dependencies, this.controller.signal)
      delay = this.config.refreshMinutes * 60_000
      this.succeeded(delay)
    } catch (error) {
      if (this.controller.signal.aborted) return
      this.failures += 1
      delay = retryDelayMs(this.failures)
      this.failed(message(error), delay)
    }
    this.schedule(delay)
  }

  private succeeded(delay: number): void {
    const recovered = this.failures
    this.failures = 0
    this.refreshedAt = this.now()
    const expiresAt = new Date(this.refreshedAt + TOKEN_LIFETIME_MS).toISOString()
    this.status = { state: 'ready', detail: 'token refreshed', failures: 0, refreshedAt: new Date(this.refreshedAt).toISOString(), expiresAt }
    this.log('info', 'dsh-octo-sts: refreshed the token for %s/%s%s; next refresh in %d min', this.config.scope, this.config.identity,
      recovered > 0 ? ` after ${recovered} failed attempts` : '', Math.round(delay / 60_000))
  }

  private failed(detail: string, delay: number): void {
    const expiresAt = this.refreshedAt === undefined ? undefined : this.refreshedAt + TOKEN_LIFETIME_MS
    const valid = expiresAt !== undefined && expiresAt > this.now()
    this.status = { state: valid ? 'failing' : 'expired', detail, failures: this.failures,
      refreshedAt: this.refreshedAt === undefined ? undefined : new Date(this.refreshedAt).toISOString(),
      expiresAt: expiresAt === undefined ? undefined : new Date(expiresAt).toISOString() }
    const kept = valid ? `the previous token stays valid until ${new Date(expiresAt).toISOString()}` : 'no valid token is held'
    this.log(valid ? 'warn' : 'error', 'dsh-octo-sts: refresh %d failed, retrying in %d s; %s: %s', this.failures, Math.round(delay / 1000), kept, detail)
  }

  private log(level: keyof Logger, format: string, ...args: unknown[]): void {
    try {
      this.dependencies.logger[level](format, ...args)
    } catch { /* a logger failure must not stop the loop */ }
  }
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
