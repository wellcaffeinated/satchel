// biome-ignore-all lint/style/useNamingConvention: HTTP header names are fixed by the protocols under test
import type { AddressInfo } from 'node:net'
import express from 'express'
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey, SignJWT } from 'jose'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AuthConfig } from '../config.ts'
import { createAuthMiddleware, tokensMatch } from './auth.ts'

const TEAM = 'team.cloudflareaccess.com'
const AUD = 'aud-tag-1234'
const ISSUER = `https://${TEAM}`
const KID = 'test-key'

type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>

interface Harness {
  url: string
  close: () => Promise<void>
}

async function serve(options: { auth: AuthConfig; keys?: JWTVerifyGetKey }): Promise<Harness> {
  const app = express()
  app.use(createAuthMiddleware({ auth: options.auth, cfAccessKeys: options.keys }))
  app.get('/x', (_req, res) => {
    res.send('in')
  })
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
  })
  const port = portOf(server.address())
  return {
    url: `http://127.0.0.1:${port}/x`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

function portOf(address: AddressInfo | string | null): number {
  if (address === null || typeof address === 'string') throw new Error('not listening on TCP')
  return address.port
}

function signingKey(keys: KeyPair | undefined): KeyPair['privateKey'] {
  if (!keys) throw new Error('keys not generated')
  return keys.privateKey
}

async function sign(
  key: KeyPair['privateKey'],
  claims: { aud?: string | string[]; iss?: string; exp?: string | number; alg?: string } = {},
): Promise<string> {
  return new SignJWT({ email: 'owner@example.com' })
    .setProtectedHeader({ alg: claims.alg ?? 'RS256', kid: KID })
    .setIssuedAt()
    .setIssuer(claims.iss ?? ISSUER)
    .setAudience(claims.aud ?? [AUD])
    .setExpirationTime(claims.exp ?? '5m')
    .sign(key)
}

describe('Cloudflare Access JWT', () => {
  const state: { harness?: Harness; keys?: KeyPair; otherKeys?: KeyPair } = {}

  beforeAll(async () => {
    const keys = await generateKeyPair('RS256')
    const otherKeys = await generateKeyPair('RS256')
    const jwk = { ...(await exportJWK(keys.publicKey)), kid: KID, alg: 'RS256' }
    state.keys = keys
    state.otherKeys = otherKeys
    state.harness = await serve({
      auth: { cfAccess: { teamDomain: TEAM, aud: AUD }, none: false },
      keys: createLocalJWKSet({ keys: [jwk] }),
    })
  })
  afterAll(() => state.harness?.close())

  const status = async (headers: Record<string, string>) =>
    (await fetch(state.harness?.url ?? '', { headers })).status

  it('accepts a valid token', async () => {
    const jwt = await sign(signingKey(state.keys))
    expect(await status({ 'Cf-Access-Jwt-Assertion': jwt })).toBe(200)
  })

  it('rejects a missing token with a bare 401', async () => {
    const response = await fetch(state.harness?.url ?? '')
    expect(response.status).toBe(401)
    expect(await response.text()).toBe('')
    expect(response.headers.get('www-authenticate')).toBeNull()
  })

  it('rejects an expired token', async () => {
    const past = Math.floor(Date.now() / 1000) - 60
    const jwt = await sign(signingKey(state.keys), { exp: past })
    expect(await status({ 'Cf-Access-Jwt-Assertion': jwt })).toBe(401)
  })

  it('rejects the wrong audience, including a prefix of the right one', async () => {
    const key = signingKey(state.keys)
    expect(await status({ 'Cf-Access-Jwt-Assertion': await sign(key, { aud: 'other' }) })).toBe(401)
    expect(
      await status({ 'Cf-Access-Jwt-Assertion': await sign(key, { aud: AUD.slice(0, 5) }) }),
    ).toBe(401)
  })

  it('rejects the wrong issuer', async () => {
    const key = signingKey(state.keys)
    const jwt = await sign(key, { iss: 'https://evil.cloudflareaccess.com' })
    expect(await status({ 'Cf-Access-Jwt-Assertion': jwt })).toBe(401)
  })

  it('rejects a token signed by another key', async () => {
    const jwt = await sign(signingKey(state.otherKeys))
    expect(await status({ 'Cf-Access-Jwt-Assertion': jwt })).toBe(401)
  })

  it('rejects an HS256 token and an unsigned token', async () => {
    const hs = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256', kid: KID })
      .setIssuer(ISSUER)
      .setAudience(AUD)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode('a-shared-secret-long-enough-for-hs256'))
    expect(await status({ 'Cf-Access-Jwt-Assertion': hs })).toBe(401)
    const body = Buffer.from(
      JSON.stringify({ iss: ISSUER, aud: AUD, exp: Math.floor(Date.now() / 1000) + 300 }),
    ).toString('base64url')
    const unsigned = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${body}.`
    expect(await status({ 'Cf-Access-Jwt-Assertion': unsigned })).toBe(401)
  })

  it('does not accept a bearer token when only Access is configured', async () => {
    expect(await status({ Authorization: 'Bearer anything' })).toBe(401)
  })
})

describe('static bearer token', () => {
  const state: { harness?: Harness } = {}
  beforeAll(async () => {
    state.harness = await serve({ auth: { token: 's3cret-token', none: false } })
  })
  afterAll(() => state.harness?.close())

  const status = async (headers: Record<string, string>) =>
    (await fetch(state.harness?.url ?? '', { headers })).status

  it('accepts the right token', async () => {
    expect(await status({ Authorization: 'Bearer s3cret-token' })).toBe(200)
    expect(await status({ Authorization: 'bearer s3cret-token' })).toBe(200)
  })

  it('rejects wrong, partial, longer or missing tokens', async () => {
    expect(await status({ Authorization: 'Bearer wrong' })).toBe(401)
    expect(await status({ Authorization: 'Bearer s3cret' })).toBe(401)
    expect(await status({ Authorization: 'Bearer s3cret-token-and-more' })).toBe(401)
    expect(await status({ Authorization: 's3cret-token' })).toBe(401)
    expect(await status({})).toBe(401)
  })
})

describe('combined and none modes', () => {
  it('lets any configured mode authorise', async () => {
    const keys = await generateKeyPair('RS256')
    const jwk = { ...(await exportJWK(keys.publicKey)), kid: KID, alg: 'RS256' }
    const harness = await serve({
      auth: { token: 'tok', cfAccess: { teamDomain: TEAM, aud: AUD }, none: false },
      keys: createLocalJWKSet({ keys: [jwk] }),
    })
    const get = async (headers: Record<string, string>) =>
      (await fetch(harness.url, { headers })).status
    expect(await get({ Authorization: 'Bearer tok' })).toBe(200)
    expect(await get({ 'Cf-Access-Jwt-Assertion': await sign(keys.privateKey) })).toBe(200)
    expect(await get({ Authorization: 'Bearer nope' })).toBe(401)
    await harness.close()
  })

  it('none mode lets requests through', async () => {
    const harness = await serve({ auth: { none: true } })
    expect((await fetch(harness.url)).status).toBe(200)
    await harness.close()
  })
})

describe('tokensMatch', () => {
  it('compares exactly', () => {
    expect(tokensMatch('abc', 'abc')).toBe(true)
    expect(tokensMatch('abc', 'abcd')).toBe(false)
    expect(tokensMatch('', 'abc')).toBe(false)
  })
})
