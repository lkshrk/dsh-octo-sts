import { isAbsolute } from 'node:path'
import { z } from 'zod'

const absolutePath = z.string().trim().refine(isAbsolute, 'must be an absolute path')
const identity = z.string().trim().min(1).regex(/^[^/\s\p{Cc}]+$/u, 'must be a single path segment')
  .refine(value => value !== '.' && value !== '..', 'must be a single path segment')

const stsUrl = z.url({ protocol: /^https$/ })
  .refine(value => { const url = new URL(value); return !url.username && !url.password }, 'must not contain credentials')
  .refine(value => { const url = new URL(value); return url.pathname === '/' && !url.search && !url.hash }, 'must be the server root, without a path, query or fragment')

export const OctoStsConfigSchema = z.object({
  sts: stsUrl.default('https://sts.h-cloud.io'),
  scope: z.string().trim().min(1),
  identity,
  identityTokenFile: absolutePath.default('/var/run/secrets/octo-sts/token'),
  refreshMinutes: z.number().int().min(5).max(45).default(30),
  workspaces: z.array(z.url({ protocol: /^https$/ })).default([]),
  secretName: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be an environment variable name').default('GITHUB_TOKEN'),
  tokenFile: absolutePath.optional(),
}).strict().refine(config => config.workspaces.length > 0 || config.tokenFile !== undefined, 'set workspaces, tokenFile or both')

export type OctoStsConfig = z.output<typeof OctoStsConfigSchema>
