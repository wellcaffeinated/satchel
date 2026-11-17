import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const AUTHOR_NAME = 'satchel'
const AUTHOR_EMAIL = 'satchel@localhost'
const GIT_MAX_BUFFER = 1024 * 1024 * 16
const INITIAL_FILES = ['core.md', 'topics.yaml']

export interface GitRepo {
  /** Creates the repository, empty core.md and topics.yaml, and an initial commit if missing. */
  ensureInitialised(): Promise<void>
  /** Commits exactly `paths` (relative to the repo, existing or deleted). No-op if unchanged. */
  commit(input: { paths: string[]; message: string }): Promise<void>
}

export function createGitRepo({ dir }: { dir: string }): GitRepo {
  const identity = Object.fromEntries([
    ['GIT_AUTHOR_NAME', AUTHOR_NAME],
    ['GIT_AUTHOR_EMAIL', AUTHOR_EMAIL],
    ['GIT_COMMITTER_NAME', AUTHOR_NAME],
    ['GIT_COMMITTER_EMAIL', AUTHOR_EMAIL],
  ])

  async function git(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync(
      'git',
      [
        '-c',
        `user.name=${AUTHOR_NAME}`,
        '-c',
        `user.email=${AUTHOR_EMAIL}`,
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { cwd: dir, env: { ...process.env, ...identity }, maxBuffer: GIT_MAX_BUFFER },
    )
    return stdout
  }

  async function hasCommits(): Promise<boolean> {
    return git(['rev-parse', '--verify', '--quiet', 'HEAD']).then(
      () => true,
      () => false,
    )
  }

  /**
   * The paths git can stage: present on disk, or tracked (a deletion). An owner's direct
   * edit is never committed, so when Satchel moves such a file the old path is unknown to
   * git, and naming it would fail the whole commit.
   */
  async function stageablePaths(paths: string[]): Promise<string[]> {
    const tracked = new Set((await git(['ls-files', '--', ...paths])).split('\n'))
    return paths.filter((path) => existsSync(join(dir, path)) || tracked.has(path))
  }

  async function commit({ paths, message }: { paths: string[]; message: string }) {
    const stageable = await stageablePaths(paths)
    if (stageable.length === 0) return
    await git(['add', '-A', '--', ...stageable])
    const changed = await git(['status', '--porcelain', '--', ...stageable])
    if (changed.trim() === '') return
    await git(['commit', '--no-verify', '-m', message, '--', ...stageable])
  }

  async function ensureInitialised() {
    await mkdir(dir, { recursive: true })
    if (!existsSync(join(dir, '.git'))) await git(['init', '--quiet', '--initial-branch=main'])
    for (const file of INITIAL_FILES) {
      if (!existsSync(join(dir, file))) await writeFile(join(dir, file), '')
    }
    if (await hasCommits()) return
    await commit({ paths: INITIAL_FILES, message: 'init: satchel repository' })
  }

  return { ensureInitialised, commit }
}
