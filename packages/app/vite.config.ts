/**
 * The 6.3 Vite config — the React renderer bundle (the `dist/renderer/`
 * asset the BrowserWindow loads from `file://`).
 *
 * - `base: './'` — the bundle loads from `file://` in the BrowserWindow:
 *   relative asset paths (no absolute `/assets/...` URLs).
 * - `root: 'src/renderer'` — the Vite entry is `src/renderer/index.html`
 *   (so the shell's `<script src="/main.tsx">` resolves to
 *   `src/renderer/main.tsx`).
 * - the AUTOMATIC JSX runtime (React 19) — NO `@vitejs/plugin-react`
 *   (the spine pins: react 19.3.0 + vite 8.3.2). Vite 8 transforms with
 *   oxc (the Rolldown engine), where the `esbuild` option is IGNORED — so
 *   the automatic runtime is set via the `oxc` option (it is also the oxc
 *   default; it is stated explicitly to pin the intent).
 * - the output is `dist/renderer/` — the tsc build owns `dist/main/` +
 *   `dist/preload.js` (the renderer `.ts` modules are excluded from the
 *   build tsconfig, so only the Vite build owns `dist/renderer/`). `dist/` is
 *   gitignored (never committed).
 */
import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  root: 'src/renderer',
  oxc: {
    jsx: { runtime: 'automatic', importSource: 'react' },
  },
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
  },
})
