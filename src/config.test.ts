// biome-ignore-all lint/style/useNamingConvention: environment variable names are fixed by docs/design.md
import { isAbsolute } from 'node:path'
import { describe, expect, it } from 'vitest'
import { authModeNames, type Config, isLoopback, loadConfig } from './config.ts'

function loaded(env: Record<string, string>): Config {
  const result = loadConfig(env)
  if (!result.ok) throw new Error(result.error)
  return result.config
}

function failure(env: Record<string, string>): string {
  const result = loadConfig(env)
  if (result.ok) throw new Error('expected a config error')
  return result.error
}

describe('loadConfig', () => {
  it('refuses to start with no auth mode', () => {
    expect(failure({})).toMatch(/No authentication configured/)
  })

  it('applies defaults with a token', () => {
    const config = loaded({ SATCHEL_TOKEN: 'secret' })
    expect(config.host).toBe('127.0.0.1')
    expect(config.port).toBe(8787)
    expect(config.embedModel).toBe('Xenova/bge-small-en-v1.5')
    expect(isAbsolute(config.dataDir)).toBe(true)
    expect(config.auth).toEqual({ cfAccess: undefined, token: 'secret', none: false })
  })

  it('reads host, port, data dir and embed model', () => {
    const config = loaded({
      SATCHEL_TOKEN: 't',
      SATCHEL_HOST: '0.0.0.0',
      SATCHEL_PORT: '9000',
      SATCHEL_DATA: '/srv/satchel',
      SATCHEL_EMBED_MODEL: 'off',
    })
    expect(config).toMatchObject({
      host: '0.0.0.0',
      port: 9000,
      dataDir: '/srv/satchel',
      embedModel: 'off',
    })
  })

  it('rejects a bad port', () => {
    expect(failure({ SATCHEL_TOKEN: 't', SATCHEL_PORT: '80a' })).toMatch(/SATCHEL_PORT/)
    expect(failure({ SATCHEL_TOKEN: 't', SATCHEL_PORT: '70000' })).toMatch(/SATCHEL_PORT/)
  })

  it('accepts SATCHEL_AUTH=none on loopback only', () => {
    expect(loaded({ SATCHEL_AUTH: 'none' }).auth.none).toBe(true)
    expect(loaded({ SATCHEL_AUTH: 'none', SATCHEL_HOST: '::1' }).auth.none).toBe(true)
    expect(failure({ SATCHEL_AUTH: 'none', SATCHEL_HOST: '0.0.0.0' })).toMatch(/loopback/)
    expect(failure({ SATCHEL_AUTH: 'none', SATCHEL_HOST: '192.168.1.5' })).toMatch(/loopback/)
  })

  it('refuses none on a non-loopback bind even when another mode is set', () => {
    expect(failure({ SATCHEL_AUTH: 'none', SATCHEL_TOKEN: 't', SATCHEL_HOST: '0.0.0.0' })).toMatch(
      /loopback/,
    )
  })

  it('rejects other SATCHEL_AUTH values', () => {
    expect(failure({ SATCHEL_AUTH: 'off' })).toMatch(/only "none"/)
  })

  it('needs both Cloudflare Access variables', () => {
    expect(failure({ CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com' })).toMatch(/both/)
    expect(failure({ CF_ACCESS_AUD: 'abc' })).toMatch(/both/)
  })

  it('normalises and validates the team domain', () => {
    const config = loaded({
      CF_ACCESS_TEAM_DOMAIN: 'https://Team.cloudflareaccess.com/',
      CF_ACCESS_AUD: 'aud-tag',
    })
    expect(config.auth.cfAccess).toEqual({
      teamDomain: 'team.cloudflareaccess.com',
      aud: 'aud-tag',
    })
    expect(failure({ CF_ACCESS_TEAM_DOMAIN: 'evil.com/path', CF_ACCESS_AUD: 'a' })).toMatch(
      /hostname/,
    )
  })

  it('treats a blank token as unset', () => {
    expect(failure({ SATCHEL_TOKEN: '   ' })).toMatch(/No authentication/)
  })
})

describe('isLoopback', () => {
  it.each([
    ['127.0.0.1', true],
    ['127.1.2.3', true],
    ['localhost', true],
    ['::1', true],
    ['[::1]', true],
    ['::ffff:127.0.0.1', true],
    ['0.0.0.0', false],
    ['::', false],
    ['10.0.0.1', false],
    ['example.com', false],
  ])('%s -> %s', (host, expected) => {
    expect(isLoopback(host)).toBe(expected)
  })
})

describe('authModeNames', () => {
  it('never includes the token', () => {
    const names = authModeNames({ token: 'hunter2', none: false })
    expect(names).toEqual(['token'])
    expect(names.join()).not.toContain('hunter2')
  })
})
