/**
 * `app/scripts/copy-genesis` — the app build's LAST step.
 *
 * Copies the repo-root `config/genesis.json` BYTE-IDENTICAL into
 * `packages/app/dist/config/genesis.json` — the ONE genesis source the
 * packaged app reads: the main process's `genesisPath()` (one level up
 * from `dist/main/`) resolves this bundled copy and threads it into EVERY
 * `host.start` call, so the gate registry AND the core's boot read the
 * same single file (the repo-root path is NOT in the package).
 * `copyFileSync` = byte-identical (no JSON re-serialization, no
 * reformatting).
 *
 * The repo root is resolved from THIS script's own location
 * (`<repo>/packages/app/scripts/` → three levels up), so the copy works
 * from any cwd (the build script invokes it from `packages/app/`).
 */
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
// `<repo>/packages/app/scripts` → the repo root is three levels up.
const repoRoot = join(here, '..', '..', '..')
const src = join(repoRoot, 'config', 'genesis.json')
const destDir = join(here, '..', 'dist', 'config')
mkdirSync(destDir, { recursive: true })
copyFileSync(src, join(destDir, 'genesis.json'))
console.log(`copy-genesis: ${src} -> ${join(destDir, 'genesis.json')} (byte-identical)`)
