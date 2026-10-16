/**
 * The app build's MAIN-process config — the Vite node/ssr lib build of
 * `src/main/index.ts` → `dist/main/index.js` (the electron MAIN entry —
 * the forge config's `main` pins this layout).
 *
 * - `build.ssr` — an SSR (node) build: the entry is a Node/Electron-main
 *   module, not a browser bundle (the renderer owns `vite.config.ts`).
 * - `ssr.target: 'node'` + `ssr.noExternal: true` — the WHOLE
 *   `@succinctcoin/core` graph (the consensus + libp2p adapters + big.js)
 *   is INLINED into the bundle: under pnpm's strict layout the package's
 *   `workspace:*` core dep + its transitive graph are NOT resolvable from
 *   a relocated package dir, so the bundle must carry them (bundle, not
 *   vendor-copy — the Design Note).
 * - `ssr.external: ['electron']` — the ONE carve-out: `electron` is
 *   provided by the runtime (the Node builtins stay external
 *   automatically; Node's ESM loader resolves them with or without the
 *   `node:` prefix). Bundle externals are therefore EXACTLY
 *   {`electron`, node builtins} — the package needs no workspace
 *   node_modules.
 * - `emptyOutDir: false` — the shared `dist/` is NEVER wiped mid-build
 *   (the renderer build owns only `dist/renderer/`; the build's NEW clean
 *   step, `scripts/clean-dist.mjs`, owns the one wipe, at the head).
 * - `import.meta.url` is left native (the node/ssr build does not rewrite
 *   it), so the entry's relative loads (`../preload.mjs`,
 *   `../renderer/index.html`, `../config/genesis.json`) work in dev AND
 *   inside the packaged asar.
 */
import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    ssr: 'src/main/index.ts',
    outDir: 'dist/main',
    emptyOutDir: false,
    rollupOptions: {
      output: {
        format: 'es',
      },
    },
  },
  ssr: {
    target: 'node',
    external: ['electron'],
    noExternal: true,
  },
})
