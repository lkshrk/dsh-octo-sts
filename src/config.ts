import { isAbsolute, resolve } from 'node:path'
import { z } from 'zod'

const absolutePath = z.string().trim().refine(isAbsolute, 'must be an absolute path')
const identity = z.string().trim().min(1).regex(/^[^/\s\p{Cc}]+$/u, 'must be a single path segment')
  .refine(value => value !== '.' && value !== '..', 'must be a single path segment')
const scope = z.string().trim().min(1)

const httpsUrl = z.url({ protocol: /^https$/ })
  .refine(value => { const url = new URL(value); return !url.username && !url.password }, 'must not contain credentials')
const stsUrl = httpsUrl
  .refine(value => { const url = new URL(value); return url.pathname === '/' && !url.search && !url.hash }, 'must be the server root, without a path, query or fragment')

const OWNER_KEYS = ['scope', 'identity', 'workspaces', 'tokenFile'] as const
const NEEDS_DESTINATION = 'set workspaces, tokenFile or both'

const OwnerSchema = z.object({
  scope,
  identity,
  workspaces: z.array(httpsUrl).default([]),
  tokenFile: absolutePath.optional(),
}).strict().refine(owner => owner.workspaces.length > 0 || owner.tokenFile !== undefined, NEEDS_DESTINATION)

export const OctoStsConfigSchema = z.object({
  sts: stsUrl.default('https://sts.h-cloud.io'),
  scope: scope.optional(),
  identity: identity.optional(),
  identityTokenFile: absolutePath.default('/var/run/secrets/octo-sts/token'),
  refreshMinutes: z.number().int().min(5).max(45).default(30),
  workspaces: z.array(httpsUrl).optional(),
  registerWorkspaces: z.boolean().default(true),
  secretName: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be an environment variable name').default('GITHUB_TOKEN'),
  tokenFile: absolutePath.optional(),
  owners: z.array(OwnerSchema).min(1).optional(),
}).strict().superRefine((config, ctx) => {
  if (config.owners) {
    for (const key of OWNER_KEYS) {
      if (config[key] !== undefined) ctx.addIssue({ code: 'custom', path: [key], message: `set ${key} inside owners, not next to it` })
    }
    checkOwners(config.owners, ctx)
    return
  }
  for (const key of ['scope', 'identity'] as const) {
    if (config[key] === undefined) ctx.addIssue({ code: 'custom', path: [key], message: 'set scope and identity, or owners' })
  }
  if (!config.workspaces?.length && config.tokenFile === undefined) ctx.addIssue({ code: 'custom', message: NEEDS_DESTINATION })
  if (config.scope !== undefined) checkWorkspaces(config.scope, config.workspaces ?? [], [], ctx)
})

export type OctoStsConfig = z.output<typeof OctoStsConfigSchema>
type Owner = z.output<typeof OwnerSchema>

export interface OwnerSettings extends Owner {
  sts: string
  identityTokenFile: string
  refreshMinutes: number
  registerWorkspaces: boolean
  secretName: string
}

export function ownerSettings(config: OctoStsConfig): OwnerSettings[] {
  const { owners, scope, identity, workspaces, tokenFile, ...shared } = config
  const list: Owner[] = owners ?? [{ scope: scope!, identity: identity!, workspaces: workspaces ?? [], tokenFile }]
  return list.map(owner => ({ ...shared, ...owner }))
}

function checkOwners(owners: Owner[], ctx: z.RefinementCtx): void {
  const pairs = new Set<string>()
  const tokenFiles = new Map<string, number>()
  const workspaces = new Map<string, number>()
  owners.forEach((owner, index) => {
    const pair = `${owner.scope}\n${owner.identity}`.toLowerCase()
    if (pairs.has(pair)) ctx.addIssue({ code: 'custom', path: ['owners', index], message: `scope ${owner.scope} with identity ${owner.identity} is listed twice` })
    pairs.add(pair)
    if (owner.tokenFile !== undefined) {
      const path = resolve(owner.tokenFile)
      const first = tokenFiles.get(path)
      if (first === undefined) tokenFiles.set(path, index)
      else ctx.addIssue({ code: 'custom', path: ['owners', index, 'tokenFile'], message: `${path} is already the tokenFile of owners[${first}]` })
    }
    checkWorkspaces(owner.scope, owner.workspaces, ['owners', index], ctx).forEach((key, position) => {
      const first = workspaces.get(key)
      if (first === undefined) workspaces.set(key, index)
      else if (first !== index) ctx.addIssue({ code: 'custom', path: ['owners', index, 'workspaces', position], message: `${owner.workspaces[position]} is already a workspace of owners[${first}]` })
    })
  })
}

function checkWorkspaces(scope: string, workspaces: string[], prefix: (string | number)[], ctx: z.RefinementCtx): string[] {
  const [scopeOwner = '', scopeRepository] = scope.toLowerCase().split('/')
  return workspaces.map((workspace, position) => {
    const path = [...prefix, 'workspaces', position]
    const repository = githubRepository(workspace)
    if (!repository) {
      ctx.addIssue({ code: 'custom', path, message: `${workspace} must be https://github.com/<owner>/<repository>` })
      return workspace.toLowerCase()
    }
    if (repository.owner !== scopeOwner) {
      ctx.addIssue({ code: 'custom', path, message: `${workspace} does not belong to ${scopeOwner}, the owner of scope ${scope}` })
    } else if (scopeRepository !== undefined && repository.name !== scopeRepository) {
      ctx.addIssue({ code: 'custom', path, message: `${workspace} is outside scope ${scope}` })
    }
    return `${repository.owner}/${repository.name}`
  })
}

function githubRepository(value: string): { owner: string; name: string } | undefined {
  const url = new URL(value)
  if (url.hostname !== 'github.com' || url.port || url.search || url.hash) return undefined
  const match = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.pathname)
  return match ? { owner: match[1]!.toLowerCase(), name: match[2]!.toLowerCase() } : undefined
}
