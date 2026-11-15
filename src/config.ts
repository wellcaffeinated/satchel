// Environment parsing and limits. See docs/design.md "Configuration".
import { isIP } from 'node:net'
import { resolve } from 'node:path'

export const CORE_MAX_CHARS = 4_000
// Claude Code truncates instructions at 4,096; the margin is for its own framing.
export const INSTRUCTIONS_MAX_CHARS = 3_800
// A rule plus its examples; the first paragraph is the rule. See docs/design.md.
export const MEMORY_MAX_CHARS = 6_000
export const CHECKPOINT_SUMMARY_MAX_CHARS = 3_000
export const LABELS_MAX_COUNT = 10
export const LABEL_MAX_CHARS = 32
export const FILETYPE_PATTERN = /^[a-z0-9]+$/
export const TAG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const TOPIC_NAME_MAX_CHARS = 32
export const TOPIC_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const TRIGGER_MAX_CHARS = 160
export const RECALL_DEFAULT_LIMIT = 8
export const RECALL_MAX_LIMIT = 100
// Pages hold whole memories up to these sizes; see docs/design.md "Paging".
export const RECALL_PAGE_MAX_CHARS = 24_000
export const BRIEF_LOADED_MAX_CHARS = 32_000
// A client may describe its work with many labels (every dependency, say).
export const REQUEST_LABELS_MAX_COUNT = 100
export const CLIENT_NAME_MAX_CHARS = 64
export const PROJECT_MAX_CHARS = 200
export const BRANCH_MAX_CHARS = 200
export const HOST_MAX_CHARS = 100
export const COMMIT_MAX_CHARS = 64
export const JSON_BODY_LIMIT_BYTES = 256 * 1024

export const DEFAULT_PORT = 8787
export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_DATA_DIR = './data'
export const DEFAULT_EMBED_MODEL = 'Xenova/bge-small-en-v1.5'

const MAX_PORT = 2 ** 16 - 1
const HOSTNAME_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
const HOSTNAME_PATTERN = new RegExp(`^(?=.{1,253}$)${HOSTNAME_LABEL}(?:\\.${HOSTNAME_LABEL})+$`)
const IPV6_LOOPBACK_PATTERN = /^(?:0{0,4}:){2,7}0{0,3}1$/
const IPV4_MAPPED_PREFIX = '::ffff:'

export interface CfAccessConfig {
  teamDomain: string // bare hostname, e.g. example.cloudflareaccess.com
  aud: string
}

export interface AuthConfig {
  cfAccess?: CfAccessConfig
  token?: string
  none: boolean
}

export interface Config {
  dataDir: string // absolute
  host: string
  port: number
  embedModel: string // model id or "off"
  auth: AuthConfig
}

export type ConfigResult = { ok: true; config: Config } | { ok: false; error: string }

type Env = Record<string, string | undefined>

export function isLoopback(host: string): boolean {
  const bare = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
  if (bare === 'localhost') return true
  const v4 = bare.startsWith(IPV4_MAPPED_PREFIX) ? bare.slice(IPV4_MAPPED_PREFIX.length) : bare
  if (isIP(v4) === 4) return v4.split('.')[0] === '127'
  if (isIP(bare) === 6) return IPV6_LOOPBACK_PATTERN.test(bare)
  return false
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function fail(error: string): ConfigResult {
  return { ok: false, error }
}

function parsePort(raw: string | undefined): number | undefined {
  const trimmed = nonEmpty(raw)
  if (trimmed === undefined) return DEFAULT_PORT
  if (!/^\d+$/.test(trimmed)) return undefined
  const port = Number(trimmed)
  return port <= MAX_PORT ? port : undefined
}

function normaliseTeamDomain(raw: string): string | undefined {
  const domain = raw
    .toLowerCase()
    .replace(/^https:\/\//, '')
    .replace(/\/+$/, '')
  return HOSTNAME_PATTERN.test(domain) ? domain : undefined
}

function parseCfAccess(env: Env): { cfAccess?: CfAccessConfig; error?: string } {
  const team = nonEmpty(env.CF_ACCESS_TEAM_DOMAIN)
  const aud = nonEmpty(env.CF_ACCESS_AUD)
  if (!team && !aud) return {}
  if (!team || !aud) {
    return { error: 'Cloudflare Access needs both CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD' }
  }
  const teamDomain = normaliseTeamDomain(team)
  if (!teamDomain) {
    return {
      error: 'CF_ACCESS_TEAM_DOMAIN must be a hostname such as example.cloudflareaccess.com',
    }
  }
  return { cfAccess: { teamDomain, aud } }
}

function parseNoneMode(env: Env, host: string): { none: boolean; error?: string } {
  const mode = nonEmpty(env.SATCHEL_AUTH)
  if (mode === undefined) return { none: false }
  if (mode !== 'none') return { none: false, error: `SATCHEL_AUTH accepts only "none"` }
  if (!isLoopback(host)) {
    return {
      none: false,
      error: `SATCHEL_AUTH=none is only allowed on a loopback bind; SATCHEL_HOST is ${host}`,
    }
  }
  return { none: true }
}

/** The token is kept byte for byte; only an all-blank value counts as unset. */
function parseToken(env: Env): string | undefined {
  return nonEmpty(env.SATCHEL_TOKEN) === undefined ? undefined : env.SATCHEL_TOKEN
}

export function loadConfig(env: Env): ConfigResult {
  const host = nonEmpty(env.SATCHEL_HOST) ?? DEFAULT_HOST
  const port = parsePort(env.SATCHEL_PORT)
  if (port === undefined) return fail('SATCHEL_PORT must be an integer from 0 to 65535')

  const { cfAccess, error: cfError } = parseCfAccess(env)
  if (cfError) return fail(cfError)
  const { none, error: noneError } = parseNoneMode(env, host)
  if (noneError) return fail(noneError)
  const token = parseToken(env)

  if (!cfAccess && !token && !none) {
    return fail(
      'No authentication configured. Set CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD, ' +
        'or SATCHEL_TOKEN, or SATCHEL_AUTH=none with a loopback SATCHEL_HOST.',
    )
  }

  const config: Config = {
    dataDir: resolve(nonEmpty(env.SATCHEL_DATA) ?? DEFAULT_DATA_DIR),
    host,
    port,
    embedModel: nonEmpty(env.SATCHEL_EMBED_MODEL) ?? DEFAULT_EMBED_MODEL,
    auth: { cfAccess, token, none },
  }
  return { ok: true, config }
}

/** Enabled auth modes for the startup log. Never includes secrets. */
export function authModeNames(auth: AuthConfig): string[] {
  const cf = auth.cfAccess ? [`cloudflare-access(${auth.cfAccess.teamDomain})`] : []
  const token = auth.token ? ['token'] : []
  const none = auth.none ? ['none'] : []
  return [...cf, ...token, ...none]
}
