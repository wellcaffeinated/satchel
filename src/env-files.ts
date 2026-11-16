// Variables read from files, for Docker and Compose secrets. See docs/design.md "Configuration".
//
// Two spellings name the file holding a variable's value: `NAME_FILE` (the convention of
// the official Docker images) and `FILE__NAME` (LinuxServer.io's).

type Env = Record<string, string | undefined>

export type EnvFilesResult = { ok: true; env: Env } | { ok: false; error: string }

export interface ResolveEnvFilesOptions {
  env: Env
  /** The variables that may come from a file; others are left alone. */
  names: readonly string[]
  readFile: (path: string) => string
}

const TRAILING_NEWLINES = /[\r\n]+$/

function isSet(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== ''
}

function fileVariablesFor(name: string): string[] {
  return [`${name}_FILE`, `FILE__${name}`]
}

/** A secret file almost always ends in a newline its value does not contain. */
function readValue(options: { path: string; readFile: (path: string) => string }): string {
  return options.readFile(options.path).replace(TRAILING_NEWLINES, '')
}

type Resolution = { name: string; value: string } | { error: string } | undefined

function resolveOne(options: {
  name: string
  env: Env
  readFile: (path: string) => string
}): Resolution {
  const { name, env, readFile } = options
  const fileVariables = fileVariablesFor(name).filter((variable) => isSet(env[variable]))
  const variable = fileVariables[0]
  if (variable === undefined) return undefined
  if (isSet(env[name]) || fileVariables.length > 1) {
    const all = [name, ...fileVariables].filter((each) => isSet(env[each]))
    return { error: `${all.join(', ')} are set; set only one of them` }
  }
  const path = env[variable]?.trim() ?? ''
  try {
    return { name, value: readValue({ path, readFile }) }
  } catch (error) {
    return { error: `${variable}: cannot read ${path}: ${String(error)}` }
  }
}

/** Returns `env` with each named variable that has a file variable set to that file's contents. */
export function resolveEnvFiles(options: ResolveEnvFilesOptions): EnvFilesResult {
  const { env, names, readFile } = options
  const resolutions = names.map((name) => resolveOne({ name, env, readFile }))
  const errors = resolutions.flatMap((resolution) =>
    resolution !== undefined && 'error' in resolution ? [resolution.error] : [],
  )
  if (errors.length > 0) return { ok: false, error: errors.join('; ') }
  const values = resolutions.flatMap((resolution) =>
    resolution !== undefined && 'value' in resolution ? [[resolution.name, resolution.value]] : [],
  )
  return { ok: true, env: { ...env, ...Object.fromEntries(values) } }
}
