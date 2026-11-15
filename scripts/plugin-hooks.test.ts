// biome-ignore-all lint/style/useNamingConvention: hook JSON fields and env names are fixed by Claude Code
// The Claude Code plugin's hook scripts (plugin/scripts/*.sh), run as Claude Code runs them:
// JSON on stdin, against a throwaway git repository. They need sh, git and jq.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const SCRIPTS = fileURLToPath(new URL('../plugin/scripts/', import.meta.url))
const HAS_JQ = (() => {
  try {
    execFileSync('jq', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()
const SESSION = 'session-1'

interface Sandbox {
  repo: string
  data: string
  root: string
}

function createRepo(root: string): string {
  const repo = join(root, 'repo')
  mkdirSync(join(repo, 'src'), { recursive: true })
  for (const name of ['a', 'b', 'c', 'd']) writeFileSync(join(repo, 'src', `${name}.ts`), '')
  writeFileSync(join(repo, 'README.md'), '')
  writeFileSync(join(repo, 'image.png'), '')
  writeFileSync(
    join(repo, 'package.json'),
    JSON.stringify({
      dependencies: { rxjs: '7', '@sveltejs/kit': '2' },
      devDependencies: { '@types/node': '1' },
    }),
  )
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  git('remote', 'add', 'origin', 'git@github.com:Example/Shop.git')
  git('add', '.')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init')
  return repo
}

function run(sandbox: Sandbox, script: string, input: Record<string, unknown>): string {
  return execFileSync('sh', [join(SCRIPTS, script)], {
    input: JSON.stringify({ session_id: SESSION, cwd: sandbox.repo, ...input }),
    env: { ...process.env, SATCHEL_URL: 'http://satchel.test', CLAUDE_PLUGIN_DATA: sandbox.data },
    encoding: 'utf8',
  })
}

function stateFile(sandbox: Sandbox, name: string): string {
  try {
    return readFileSync(join(sandbox.data, 'state', SESSION, name), 'utf8')
  } catch {
    return ''
  }
}

function parsed(output: string): Record<string, unknown> {
  return output.trim() === '' ? {} : JSON.parse(output)
}

describe.skipIf(!HAS_JQ)('plugin hooks', () => {
  const sandbox: Sandbox = { repo: '', data: '', root: '' }
  const tool = (name: string) => `mcp__satchel__${name}`
  const edit = (path: string, agent?: string) =>
    run(sandbox, 'edit-check.sh', {
      tool_name: 'Edit',
      tool_input: { file_path: join(sandbox.repo, path) },
      ...(agent === undefined ? {} : { agent_id: agent }),
    })
  const reason = (output: string) =>
    JSON.stringify(parsed(output)).includes('"permissionDecision":"deny"')
      ? String(
          (parsed(output).hookSpecificOutput as Record<string, unknown>).permissionDecisionReason,
        )
      : ''
  const seeBrief = (text: string) =>
    run(sandbox, 'labels-seen.sh', {
      tool_name: tool('brief'),
      tool_response: [{ type: 'text', text }],
    })

  beforeEach(() => {
    sandbox.root = mkdtempSync(join(tmpdir(), 'satchel-hooks-'))
    sandbox.repo = createRepo(sandbox.root)
    sandbox.data = join(sandbox.root, 'plugin-data')
  })
  afterEach(() => rmSync(sandbox.root, { recursive: true, force: true }))

  it('session start names the work: main file types, code, dependency tags', () => {
    const text = run(sandbox, 'session-start.sh', {})
    expect(text).toContain('project=github.com/example/shop and branch=main')
    expect(text).toContain('filetypes [ts] and tags [code, sveltejs-kit, rxjs]')
    expect(text).not.toContain('png')
    expect(text).not.toContain('types-node')
  })

  it('fills the work into the main agent brief only, and records what each agent loads', () => {
    const main = parsed(
      run(sandbox, 'fill-arguments.sh', { tool_name: tool('brief'), tool_input: {} }),
    )
    expect(main).toMatchObject({
      hookSpecificOutput: {
        updatedInput: {
          project: 'github.com/example/shop',
          branch: 'main',
          filetypes: ['ts'],
          tags: ['code', 'sveltejs-kit', 'rxjs'],
        },
      },
    })
    const sub = parsed(
      run(sandbox, 'fill-arguments.sh', {
        tool_name: tool('brief'),
        tool_input: {},
        agent_id: 'a1',
      }),
    )
    expect(JSON.stringify(sub)).not.toContain('filetypes')
    run(sandbox, 'fill-arguments.sh', {
      tool_name: tool('recall'),
      tool_input: { filetypes: ['.PY'], tags: ['Code'] },
      agent_id: 'a1',
    })
    expect(stateFile(sandbox, 'main.loaded')).toBe(
      'filetype:ts\ntag:code\ntag:sveltejs-kit\ntag:rxjs\n',
    )
    expect(stateFile(sandbox, 'a1.loaded')).toBe('filetype:py\ntag:code\n')
  })

  it('never touches memorize', () => {
    const output = run(sandbox, 'fill-arguments.sh', {
      tool_name: tool('memorize'),
      tool_input: { text: 'x', topic: 't' },
    })
    expect(output).toBe('')
  })

  it('asks once before the first edit of a file type whose rules are not loaded', () => {
    run(sandbox, 'fill-arguments.sh', { tool_name: tool('brief'), tool_input: {} })
    seeBrief(
      '## Topics\n- code (3): read before code\nTags: code (2), rxjs (1)\nFile types: ts (1), py (1)',
    )
    expect(edit('src/a.ts')).toBe('')
    const first = reason(edit('tool.py'))
    expect(first).toContain('rules for .py files')
    expect(first).toContain('filetypes=["py"]')
    expect(first).not.toContain('tags=')
    expect(edit('tool.py')).toBe('')
    expect(edit('notes.md')).toBe('')
  })

  it('asks a subagent for the code rules and the repository library tags that have rules', () => {
    seeBrief('Tags: code (2), rxjs (1)\nFile types: ts (1)')
    const asked = reason(edit('src/a.ts', 'a1'))
    expect(asked).toContain('filetypes=["ts"], tags=["code","rxjs"]')
    run(sandbox, 'fill-arguments.sh', {
      tool_name: tool('recall'),
      tool_input: { filetypes: ['ts'], tags: ['code', 'rxjs'] },
      agent_id: 'a1',
    })
    expect(edit('src/b.ts', 'a1')).toBe('')
  })

  it('without a brief, asks for code files only; with no labelled rules, asks nothing', () => {
    expect(reason(edit('src/a.ts'))).toContain('filetypes=["ts"], tags=["code"]')
    expect(edit('README.md')).toBe('')
    seeBrief('## Topics\n- general (4): read before anything')
    expect(edit('src/c.ts', 'a2')).toBe('')
  })

  it('session start forgets what the main agent had loaded, since compaction drops it', () => {
    run(sandbox, 'fill-arguments.sh', { tool_name: tool('brief'), tool_input: {} })
    expect(stateFile(sandbox, 'main.loaded')).not.toBe('')
    run(sandbox, 'session-start.sh', {})
    expect(stateFile(sandbox, 'main.loaded')).toBe('')
  })

  it('tells subagents where they are working', () => {
    const output = parsed(
      run(sandbox, 'subagent-start.sh', { agent_id: 'a1', agent_type: 'Explore' }),
    )
    const context = String((output.hookSpecificOutput as Record<string, unknown>).additionalContext)
    expect(context).toContain('project=github.com/example/shop, branch=main')
    expect(context).toContain('first edit of a code file')
  })
})
