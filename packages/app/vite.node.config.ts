/**
 * The app build's HEADLESS-RUNNER config (ticket 8) — the Vite node/ssr lib
 * build of `src/main/cli/run-node.ts` → `dist/node/run-node.js`.
 *
 * The same pipeline shape as `vite.main.config.ts` (the core graph INLINED via
 * `noExternal: true`, so a relocated checkout needs no workspace
 * `node_modules`), with one difference that is the whole point: there is NO
 * `electron` external — nothing in this entry's import graph touches electron
 * (`run-node.ts` composes the electron-free main modules), so the bundle runs
 * under plain Node on a server with no display. Node builtins stay external
 * automatically, and `import.meta.url` stays native so the default genesis
 * lookup (`../config/genesis.json`, the copy `scripts/copy-genesis.mjs` lands)
 * resolves inside `dist/`.
 */
import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    ssr: 'src/main/cli/run-node.ts',
    outDir: 'dist/node',
    emptyOutDir: false,
    rollupOptions: {
      output: {
        format: 'es',
      },
    },
  },
  ssr: {
    target: 'node',
    noExternal: true,
  },
})
