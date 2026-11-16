// biome-ignore-all lint/style/useNamingConvention: environment variable names are fixed by docs/design.md
import { describe, expect, it } from 'vitest'
import { resolveEnvFiles } from './env-files.ts'

const FILES: Record<string, string> = {
  '/run/secrets/token': 's3cret\n',
  '/run/secrets/crlf': 'abc\r\n',
  '/run/secrets/spaced': '  keep my spaces  \n',
}

function readFile(path: string): string {
  const content = FILES[path]
  if (content === undefined) throw new Error(`ENOENT: no such file, open '${path}'`)
  return content
}

function resolved(env: Record<string, string>) {
  const result = resolveEnvFiles({ env, names: ['SATCHEL_TOKEN', 'CF_ACCESS_AUD'], readFile })
  if (!result.ok) throw new Error(result.error)
  return result.env
}

function failure(env: Record<string, string>): string {
  const result = resolveEnvFiles({ env, names: ['SATCHEL_TOKEN'], readFile })
  if (result.ok) throw new Error('expected an error')
  return result.error
}

describe('resolveEnvFiles', () => {
  it('reads NAME_FILE and drops the trailing newline', () => {
    expect(resolved({ SATCHEL_TOKEN_FILE: '/run/secrets/token' }).SATCHEL_TOKEN).toBe('s3cret')
    expect(resolved({ SATCHEL_TOKEN_FILE: '/run/secrets/crlf' }).SATCHEL_TOKEN).toBe('abc')
  })

  it('reads the LinuxServer.io spelling FILE__NAME', () => {
    expect(resolved({ FILE__CF_ACCESS_AUD: '/run/secrets/token' }).CF_ACCESS_AUD).toBe('s3cret')
  })

  it('keeps other whitespace in the file byte for byte', () => {
    expect(resolved({ SATCHEL_TOKEN_FILE: '/run/secrets/spaced' }).SATCHEL_TOKEN).toBe(
      '  keep my spaces  ',
    )
  })

  it('leaves the environment alone when no file variable is set', () => {
    const env = { SATCHEL_TOKEN: 'plain', OTHER: 'x' }
    expect(resolved(env)).toEqual(env)
  })

  it('ignores file variables for names it was not given', () => {
    expect(resolved({ SSL_CERT_FILE: '/run/secrets/token' }).SSL_CERT).toBeUndefined()
  })

  it('refuses a value set both directly and from a file', () => {
    expect(failure({ SATCHEL_TOKEN: 'a', SATCHEL_TOKEN_FILE: '/run/secrets/token' })).toMatch(
      /SATCHEL_TOKEN, SATCHEL_TOKEN_FILE are set/,
    )
    expect(
      failure({
        SATCHEL_TOKEN_FILE: '/run/secrets/token',
        FILE__SATCHEL_TOKEN: '/run/secrets/crlf',
      }),
    ).toMatch(/set only one/)
  })

  it('names the variable and path when the file cannot be read', () => {
    expect(failure({ SATCHEL_TOKEN_FILE: '/run/secrets/missing' })).toMatch(
      /SATCHEL_TOKEN_FILE: cannot read \/run\/secrets\/missing/,
    )
  })
})
