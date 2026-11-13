import { OctoStsConfigSchema, type OctoStsConfig } from './config.ts'
import { TokenRefresher, type Logger, type SecretStore } from './refresher.ts'

interface PluginContext {
  logger: Logger
  get(name: string): unknown
  effect(execute: () => (() => unknown) | void, label?: string): unknown
}

export const name = 'dsh-octo-sts'
export const inject: string[] = []
export const Config = OctoStsConfigSchema

export function apply(ctx: PluginContext, config: OctoStsConfig): void {
  ctx.effect(() => {
    const refresher = new TokenRefresher(config, { logger: ctx.logger, store: () => ctx.get('sandboxManager') as SecretStore | undefined })
    refresher.start()
    return () => refresher.stop()
  }, 'octo-sts: token refresh')
}

export { OctoStsConfigSchema, type OctoStsConfig } from './config.ts'
export { exchange } from './exchange.ts'
export { PermanentError, TokenRefresher, readIdentityToken, removeTemporaryFiles, retryDelayMs, writeTokenFile, type SecretStore } from './refresher.ts'
