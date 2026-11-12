// Request authentication. Any configured mode may authorise a request; a failure is a bare
// 401 so a caller learns nothing about which check failed. See docs/design.md.
import { createHash, timingSafeEqual } from 'node:crypto'
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from 'jose'
import type { AuthConfig, CfAccessConfig } from '../config.ts'

const CF_ACCESS_HEADER = 'cf-access-jwt-assertion'
// Cloudflare Access signs with RS256 only; pinning it rules out alg confusion and "none".
const CF_ACCESS_ALGORITHMS = ['RS256']
const BEARER_PATTERN = /^Bearer[ \t]+(\S+)[ \t]*$/i

type Check = (req: Request) => Promise<boolean>

export interface AuthOptions {
  auth: AuthConfig
  /** Key source for Access JWTs. Defaults to the team's remote JWKS; tests pass a local set. */
  cfAccessKeys?: JWTVerifyGetKey
  onError?: (error: unknown) => void
  /** Told which credentials a rejected request carried (names only, never values). */
  onReject?: (presented: PresentedCredentials) => void
}

export interface PresentedCredentials {
  path: string
  hasAccessJwt: boolean
  hasBearerToken: boolean
}

function presentedCredentials(req: Request): PresentedCredentials {
  return {
    path: req.path,
    hasAccessJwt: req.get(CF_ACCESS_HEADER) !== undefined,
    hasBearerToken: bearerToken(req) !== undefined,
  }
}

export function cfAccessCertsUrl(teamDomain: string): URL {
  return new URL(`https://${teamDomain}/cdn-cgi/access/certs`)
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

/** Hashing first gives equal-length buffers, so neither length nor content leaks via timing. */
export function tokensMatch(presented: string, expected: string): boolean {
  return timingSafeEqual(digest(presented), digest(expected))
}

function bearerToken(req: Request): string | undefined {
  const header = req.get('authorization')
  return header ? BEARER_PATTERN.exec(header)?.[1] : undefined
}

function tokenCheck(expected: string): Check {
  return async (req) => {
    const presented = bearerToken(req)
    return presented !== undefined && tokensMatch(presented, expected)
  }
}

function cfAccessCheck(options: {
  cfAccess: CfAccessConfig
  keys: JWTVerifyGetKey
  onError: (error: unknown) => void
}): Check {
  const { cfAccess, keys, onError } = options
  const verifyOptions = {
    algorithms: CF_ACCESS_ALGORITHMS,
    issuer: `https://${cfAccess.teamDomain}`,
    audience: cfAccess.aud,
    requiredClaims: ['exp', 'iat'],
  }
  return async (req) => {
    const jwt = req.get(CF_ACCESS_HEADER)
    if (!jwt) return false
    try {
      await jwtVerify(jwt, keys, verifyOptions)
      return true
    } catch (error) {
      onError(error)
      return false
    }
  }
}

function buildChecks(options: AuthOptions): Check[] {
  const { auth } = options
  const onError = options.onError ?? (() => {})
  const none: Check[] = auth.none ? [async () => true] : []
  const token: Check[] = auth.token ? [tokenCheck(auth.token)] : []
  const cf: Check[] = auth.cfAccess
    ? [
        cfAccessCheck({
          cfAccess: auth.cfAccess,
          keys:
            options.cfAccessKeys ?? createRemoteJWKSet(cfAccessCertsUrl(auth.cfAccess.teamDomain)),
          onError,
        }),
      ]
    : []
  return [...none, ...token, ...cf]
}

async function anyCheckPasses(checks: Check[], req: Request): Promise<boolean> {
  for (const check of checks) {
    if (await check(req)) return true
  }
  return false
}

export function createAuthMiddleware(options: AuthOptions): RequestHandler {
  const checks = buildChecks(options)
  const onReject = options.onReject ?? (() => {})
  return async (req: Request, res: Response, next: NextFunction) => {
    if (await anyCheckPasses(checks, req)) return next()
    onReject(presentedCredentials(req))
    res.status(401).end()
  }
}
