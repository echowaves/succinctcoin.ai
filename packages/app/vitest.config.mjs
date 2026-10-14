/**
 * The app's package-local Vitest config (6.3).
 *
 * A standalone file (takes precedence over `vite.config.ts` — which sets
 * `root: 'src/renderer'` for the renderer bundle and would otherwise
 * redirect the package-local `vitest run` away from `test/`). Mirrors the
 * root `vitest.config.mjs` shape: plain-Node environment, the package's
 * `test/` directory only. The root run (repo-root `vitest.config.mjs`) is
 * unaffected — it globs every package's `test/` directory itself.
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
})
