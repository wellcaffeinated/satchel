// Git worktrees live in .worktrees/, inside the repo: without this, `pnpm test` would also
// run every worktree's copy of the tests.
import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '.worktrees/**'],
  },
})
