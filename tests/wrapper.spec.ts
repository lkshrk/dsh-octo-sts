import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const WRAPPER = join(import.meta.dirname, '..', 'examples', 'gh-owner-token.sh')
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gh-wrapper-'))
  mkdirSync(join(dir, 'tokens'))
  mkdirSync(join(dir, 'bin'))
  writeFileSync(join(dir, 'tokens', 'acme.token'), 'ghs_acme')
  writeFileSync(join(dir, 'tokens', 'globex.token'), 'ghs_globex')
  writeFileSync(join(dir, 'bin', 'gh'), '#!/bin/sh\nprintf "%s|%s" "$GH_TOKEN" "$*"\n')
  chmodSync(join(dir, 'bin', 'gh'), 0o755)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function run(args: string[], options: { env?: Record<string, string>; origin?: string } = {}) {
  const cwd = join(dir, 'checkout')
  mkdirSync(cwd, { recursive: true })
  const env = { PATH: `${join(dir, 'bin')}${delimiter}${process.env.PATH}`, HOME: dir, DSH_OCTO_STS_TOKENS: join(dir, 'tokens'), ...options.env }
  if (options.origin) {
    spawnSync('git', ['init', '-q'], { cwd, env })
    spawnSync('git', ['remote', 'add', 'origin', options.origin], { cwd, env })
  }
  const result = spawnSync('sh', [WRAPPER, ...args], { cwd, env, encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

describe('gh owner wrapper', () => {
  it('picks the token by the owner of --repo, -R and -Rattached, passing the arguments through', () => {
    expect(run(['pr', 'list', '-R', 'acme/widgets'])).toMatchObject({ status: 0, stdout: 'ghs_acme|pr list -R acme/widgets' })
    expect(run(['pr', 'list', '-Rglobex/app'])).toMatchObject({ status: 0, stdout: 'ghs_globex|pr list -Rglobex/app' })
    expect(run(['pr', 'list', '--repo', 'github.com/Globex/app'])).toMatchObject({ status: 0, stdout: 'ghs_globex|pr list --repo github.com/Globex/app' })
    expect(run(['pr', 'list', '--repo=ACME/widgets'])).toMatchObject({ status: 0, stdout: 'ghs_acme|pr list --repo=ACME/widgets' })
  })

  it('prefers the flag over GH_REPO and GH_REPO over the origin remote', () => {
    expect(run(['pr', 'list', '-R', 'acme/widgets'], { env: { GH_REPO: 'globex/app' } }).stdout).toBe('ghs_acme|pr list -R acme/widgets')
    expect(run(['api', 'user'], { env: { GH_REPO: 'GLOBEX/app' }, origin: 'https://github.com/acme/widgets.git' }).stdout).toBe('ghs_globex|api user')
  })

  it('reads the owner from https, ssh and scp origin remotes', () => {
    for (const origin of ['https://github.com/Acme/widgets.git', 'ssh://git@github.com/acme/widgets', 'git@github.com:ACME/widgets.git']) {
      rmSync(join(dir, 'checkout'), { recursive: true, force: true })
      expect(run(['pr', 'view'], { origin }), origin).toMatchObject({ status: 0, stdout: 'ghs_acme|pr view' })
    }
  })

  it('exits 1 without running gh for an unknown or missing owner', () => {
    const unknown = run(['pr', 'list', '-R', 'initech/app'])
    expect(unknown.status).toBe(1)
    expect(unknown.stdout).toBe('')
    for (const repo of ['', '../acme', '.hidden/x']) {
      const result = run(['pr', 'list', '-R', repo])
      expect(result, repo).toMatchObject({ status: 1, stdout: '' })
    }
    expect(run(['pr', 'list'])).toMatchObject({ status: 1, stdout: '', stderr: 'gh: cannot tell the repository owner\n' })
  })

  it('refuses a host other than github.com', () => {
    for (const repo of ['ghe.example.com/acme/widgets', 'https://ghe.example.com/acme/widgets', 'git@ghe.example.com:acme/widgets.git']) {
      expect(run(['pr', 'list', '-R', repo]), repo).toMatchObject({ status: 1, stdout: '', stderr: 'gh: ghe.example.com is not github.com\n' })
    }
    expect(run(['pr', 'view'], { origin: 'ssh://git@ghe.example.com:2222/acme/widgets' })).toMatchObject({ status: 1, stdout: '' })
    expect(run(['pr', 'list', '-R', 'GitHub.com/acme/widgets']).stdout).toBe('ghs_acme|pr list -R GitHub.com/acme/widgets')
  })

  it('is the script the README shows', () => {
    expect(readFileSync(join(import.meta.dirname, '..', 'README.md'), 'utf8')).toContain(`\`\`\`sh\n${readFileSync(WRAPPER, 'utf8')}\`\`\``)
  })

  it.runIf(spawnSync('shellcheck', ['--version']).status === 0)('passes shellcheck', () => {
    const result = spawnSync('shellcheck', ['-s', 'sh', WRAPPER], { encoding: 'utf8' })
    expect(result.stdout).toBe('')
    expect(result.status).toBe(0)
  })
})
