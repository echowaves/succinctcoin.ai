/**
 * `app/scripts/clean-dist` — the app build's FIRST step.
 *
 * Removes `packages/app/dist/` (recursive, force) so the build ALWAYS
 * starts from a clean emit: stale prior-pipeline artifacts (the 6.4-era
 * tsc `dist/main/*.js` other than the bundle, `*.d.ts`, `*.js.map`,
 * `dist/preload.d.ts`, `dist/preload.js.map`) can never survive into the
 * package — the packager has no `files`/`ignore` restrictions, so
 * whatever is in `dist/` ships (iteration-1 F4).
 *
 * Resolved from this script's own location (`<repo>/packages/app/scripts/`
 * → `dist/` is one level up), so it works from any cwd.
 */
import { rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const distDir = join(here, '..', 'dist')
rmSync(distDir, { recursive: true, force: true })
console.log(`clean-dist: removed ${distDir} (clean emit)`)
