/**
 * The app build's PRELOAD-process config — the Vite node/ssr lib build of
 * `src/preload.ts` → `dist/preload.mjs`.
 *
 * THE OUTPUT NAME IS PINNED TO `.mjs` (the Electron ESM-preload rule —
 * the third boot blocker): Electron ≥ v28 (pin 44.5.1) parses preload
 * scripts as CJS REGARDLESS of the package's `"type": "module"` — the
 * official ESM docs: "Preload scripts will ignore `type: module` fields,
 * so you must use the `.mjs` file extension in your ESM preload scripts".
 * The repo is all-ESM, so the preload SOURCE is ESM; emitting it as
 * `preload.js` was a SyntaxError at packaged boot (`contextBridge.
 * exposeInMainWorld` never ran, `window.succinctcoin` was undefined, the
 * renderer's entire data source dead while main booted and mined).
 * `entryFileNames: 'preload.mjs'` is the one setting that fixes it (the
 * main entry loads it via `new URL('../preload.mjs', import.meta.url)` —
 * the preload path is NOT in the forge config, so no forge change).
 *
 * The inlining constraints are identical to `vite.main.config.ts`
 * (`ssr.noExternal: true` + `ssr.external: ['electron']` — the core's
 * types here are `import type`, erased; the pure IPC tables inline;
 * externals stay exactly {`electron`, node builtins}), and
 * `emptyOutDir: false` (the shared `dist/` is never wiped mid-build).
 */
import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    ssr: 'src/preload.ts',
    outDir: 'dist',
    emptyOutDir: false,
    rollupOptions: {
      output: {
        format: 'es',
        entryFileNames: 'preload.mjs',
      },
    },
  },
  ssr: {
    target: 'node',
    external: ['electron'],
    noExternal: true,
  },
})
