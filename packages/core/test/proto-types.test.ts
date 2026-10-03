/**
 * proto-types.test.ts — enforces two rows of the story matrix:
 *
 *   NO_HANDWRITTEN — scan `src/` for protocol message definitions: the four
 *     messages (`Block`/`Tx`/`Ticket`/`PeerInfo`) exist ONLY in the generated
 *     `src/proto/protocol.ts`. Any hand-written parallel shape (a
 *     `interface`/`class`/object-literal `type` with one of those names
 *     anywhere else in `src/`) fails the test (AD-12: generated types only).
 *
 *   TYPES_EXPORTED — import the package entry: `Block`/`Tx`/`Ticket`/
 *     `PeerInfo` (as codec namespaces) + `succinctcoin` are exported.
 *
 * The package entry is imported from its source module (`../src/index.js`)
 * to match the rest of the suite and keep `pnpm test` build-free; `dist/` is
 * compiled from the same `src/index.ts`, so the export surface is identical.
 */
import { describe, expect, it } from 'vitest'
import { readdir, readFile } from 'node:fs/promises'
import { resolve, join, extname } from 'node:path'

import * as core from '../src/index.js'

const SRC_DIR = resolve(import.meta.dirname, '..', 'src')
const GENERATED = join(SRC_DIR, 'proto', 'protocol.ts') // the four interfaces MUST live here
const REEXPORT = join(SRC_DIR, 'proto', 'index.ts') // the sanctioned re-export layer

const MESSAGES = ['Block', 'Ticket', 'Tx', 'PeerInfo'] as const

/** Recursively yield every `.ts` file under `dir`. */
async function* walkTs(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) {
      yield* walkTs(p)
    } else if (extname(entry.name) === '.ts') {
      yield p
    }
  }
}

/**
 * Match a HANDWRITTEN message definition of name `m`:
 *   - `interface <m>`  (any `export` modifier)
 *   - `class <m>`
 *   - `type <m> = {`   (object-literal type alias)
 * A namespace re-export alias (`type <m> = succinctcoin.<m>`) and a value
 * re-export (`const <m> = succinctcoin.<m>`) do NOT match.
 */
function handwrittenDefRe(m: string): RegExp {
  return new RegExp(`(interface|class)\\s+${m}\\b|type\\s+${m}\\s*=\\s*\\{`)
}

describe('NO_HANDWRITTEN — the four messages exist only in the generated file', () => {
  it('the generated protocol.ts defines all four messages', async () => {
    const gen = await readFile(GENERATED, 'utf8')
    for (const m of MESSAGES) {
      expect(gen, `generated file missing "interface ${m}"`).toMatch(
        new RegExp(`interface\\s+${m}\\b`)
      )
    }
  })

  it('no parallel message definition lives anywhere else in src/', async () => {
    const offenders: string[] = []
    for await (const file of walkTs(SRC_DIR)) {
      // The generated file (where the defs belong) and the sanctioned
      // re-export layer are the only files allowed to name these messages.
      if (file === GENERATED || file === REEXPORT) continue
      const content = await readFile(file, 'utf8')
      for (const m of MESSAGES) {
        if (handwrittenDefRe(m).test(content)) {
          offenders.push(`${join('src', file.slice(SRC_DIR.length).replace(/^[/\\]/, ''))}: hand-written "${m}"`)
        }
      }
    }
    expect(offenders, `hand-written protocol types found (AD-12 ban):\n${offenders.join('\n')}`).toEqual([])
  })
})

describe('TYPES_EXPORTED — Block/Tx/Ticket/PeerInfo + codecs are on the package entry', () => {
  it('the four messages are exported as codec namespaces (encode/decode/codec)', () => {
    const codec = (name: (typeof MESSAGES)[number]) => core[name] as unknown as {
      encode: unknown
      decode: unknown
      codec: unknown
    }
    for (const m of MESSAGES) {
      const ns = codec(m)
      expect(ns, `${m} is not exported from the package entry`).toBeDefined()
      expect(typeof ns.encode, `${m}.encode`).toBe('function')
      expect(typeof ns.decode, `${m}.decode`).toBe('function')
      expect(typeof ns.codec, `${m}.codec`).toBe('function')
    }
  })

  it('the full succinctcoin namespace is exported for succinctcoin.* access', () => {
    expect(core.succinctcoin).toBeDefined()
    for (const m of MESSAGES) {
      expect((core.succinctcoin as Record<string, unknown>)[m], `succinctcoin.${m}`).toBeDefined()
    }
  })
})
