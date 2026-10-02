import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = fileURLToPath(new URL('.', import.meta.url))
const srcDir = join(here, '..', 'src')

/** Recursively collect every `.ts` file under `src/`. */
function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) out.push(...tsFiles(p))
    else if (entry.endsWith('.ts')) out.push(p)
  }
  return out
}

/**
 * AD-1 (core/shell seam): `packages/core` has zero imports of `electron`,
 * the renderer, or any UI library. The core reaches the host only through
 * the injected `UiSink` port. A match fails the test.
 */
// Covers the idiomatic import forms in an ESM NodeNext codebase: static
// `from "x"` / `import "x"`, dynamic `import("x")` (with or without inner
// space), and CJS `require("x")`. Matches electron, @electron/* (and
// @electron-*), react, react-dom.
const FORBIDDEN =
  /(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)["'](electron|@electron[\w/-]+|react-dom|react)(["'])/

describe('AD-1 — zero UI imports in packages/core/src (matrix: NO_UI_IMPORTS)', () => {
  it('scans src/** and finds no forbidden UI import', () => {
    const files = tsFiles(srcDir)
    expect(files.length).toBeGreaterThan(0)
    const offenders: string[] = []
    for (const f of files) {
      if (FORBIDDEN.test(readFileSync(f, 'utf8'))) offenders.push(f)
    }
    expect(offenders, 'forbidden electron/react import found in:\n' + offenders.join('\n')).toEqual([])
  })
})
