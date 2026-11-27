import { defineConfig, configDefaults } from 'vitest/config';

// server/data holds the owner's project worktrees (wt/...) — never collect their test files
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, 'data/**'] },
});
