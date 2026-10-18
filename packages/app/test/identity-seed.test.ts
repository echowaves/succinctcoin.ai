/**
 * Story 8.1 matrix — the persisted per-install identity seed under PLAIN
 * NODE (AD-10: the module is electron-free, so these tests inject tmp dirs
 * in place of userData and NEVER spawn Electron). `loadOrCreateIdentitySeed`
 * replaces the pinned constant seed that made every install derive the
 * SAME identity — structurally blocking cross-instance mining and breaking
 * CAP-7's signed-announcement premise.
 *
 *   DISTINCT_INSTALLS        (AC1) two boots into SEPARATE dirs derive
 *                                DISTINCT seeds (32 bytes each) AND distinct
 *                                `deriveIdentityKeypair` identity ids.
 *   CONCURRENT_FIRST_BOOT    two simultaneous creates on one dir converge
 *                                on ONE seed (atomic temp + link: the loser
 *                                adopts the winner's file).
 *   SAME_DIR_REBOOT_STABLE   (AC1) the same dir rebooted (fresh loads,
 *                                including one after a "process restart")
 *                                derives the SAME seed, byte-identical to
 *                                the file's hex contents.
 *   SECRET_FILE_SHAPE        (AC2) the seed lands at `<dir>/identity.seed`
 *                                with mode `0600`, single-line lowercase
 *                                hex + newline, and NO `.tmp` leftover
 *                                (atomic create).
 *   CORRUPT_FILE_THROWS      a file that is not exactly 32 bytes of
 *                                lowercase hex THROWS — a corrupt identity
 *                                file must never silently mint a new
 *                                identity — and the file is left intact.
 *   NO_CONSTANT_SEED_LEFT    (AC3) comment-stripped sources of EVERY
 *                                `src/main/*.ts` file contain neither an
 *                                `0x5c +` constant expression nor an
 *                                `IDENTITY_SEED =` declaration (the pinned
 *                                constant is gone from app main — the
 *                                4.7-style scan), and `index.ts` DOES call
 *                                `loadOrCreateIdentitySeed` (non-vacuity:
 *                                the boot path really uses the module).
 *
 * Imports: the pure module (`../src/main/identity-seed.js`) + `vitest` +
 * node builtins. NO electron import, no sockets (AD-10).
 */
import { readdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { deriveIdentityKeypair } from '@succinctcoin/core'

import {
  IDENTITY_SEED_BYTES,
  IDENTITY_SEED_FILE_NAME,
  loadOrCreateIdentitySeed,
} from '../src/main/identity-seed.js'

const here = dirname(fileURLToPath(import.meta.url))
const APP_DIR = join(here, '..')

/** Strip comments (the 4.7-style self-scan — comments may name a rule; code may not). */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

const tmpDirs: string[] = []
async function newDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sc-identity-seed-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

describe('8.1 — loadOrCreateIdentitySeed: per-install seed, byte-stable reboots', () => {
  it('DISTINCT_INSTALLS: two separate dirs derive distinct seeds AND identity ids', async () => {
    const [a, b] = [await newDir(), await newDir()]

    const seedA = await loadOrCreateIdentitySeed(a)
    const seedB = await loadOrCreateIdentitySeed(b)

    expect(seedA).toHaveLength(IDENTITY_SEED_BYTES)
    expect(seedB).toHaveLength(IDENTITY_SEED_BYTES)
    expect(Buffer.from(seedA).equals(Buffer.from(seedB))).toBe(false)
    // The criterion is stated at the IDENTITY level — pin it directly.
    expect(deriveIdentityKeypair(seedA).identityId).not.toBe(
      deriveIdentityKeypair(seedB).identityId,
    )
  })

  it('SAME_DIR_REBOOT_STABLE: rebooting the same dir re-derives the identical seed + id', async () => {
    const dir = await newDir()

    const first = await loadOrCreateIdentitySeed(dir)
    const reboot1 = await loadOrCreateIdentitySeed(dir)
    const reboot2 = await loadOrCreateIdentitySeed(dir)

    expect(Buffer.from(reboot1).equals(Buffer.from(first))).toBe(true)
    expect(Buffer.from(reboot2).equals(Buffer.from(first))).toBe(true)
    expect(deriveIdentityKeypair(reboot2).identityId).toBe(
      deriveIdentityKeypair(first).identityId,
    )

    // The loaded bytes are exactly the file's hex contents (round-trip).
    const hex = (await readFile(join(dir, IDENTITY_SEED_FILE_NAME), 'utf8')).trim()
    expect(hex).toBe(Array.from(first, (b) => b.toString(16).padStart(2, '0')).join(''))
  })

  it('SECRET_FILE_SHAPE: 0600 mode, one line of lowercase hex, no tmp leftover', async () => {
    const dir = await newDir()
    const seed = await loadOrCreateIdentitySeed(dir)
    const filePath = join(dir, IDENTITY_SEED_FILE_NAME)

    const raw = await readFile(filePath, 'utf8')
    expect(raw).toMatch(/^[0-9a-f]{64}\n$/)
    expect((await stat(filePath)).mode & 0o777).toBe(0o600)

    // A second boot must not have rewritten anything (stable bytes prove it,
    // and no tmp file may linger from the atomic create).
    await loadOrCreateIdentitySeed(dir)
    expect(await readdir(dir)).toEqual([IDENTITY_SEED_FILE_NAME])
    expect(seed).toHaveLength(IDENTITY_SEED_BYTES)
  })

  it('CONCURRENT_FIRST_BOOT: two simultaneous creates on one dir converge on one seed', async () => {
    const dir = await newDir()

    const [a, b] = await Promise.all([
      loadOrCreateIdentitySeed(dir),
      loadOrCreateIdentitySeed(dir),
    ])

    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true)
    const onDisk = (await readFile(join(dir, IDENTITY_SEED_FILE_NAME), 'utf8')).trim()
    expect(onDisk).toBe(Array.from(a, (byte) => byte.toString(16).padStart(2, '0')).join(''))
  })

  it('CORRUPT_FILE_THROWS: non-hex content throws and is never silently replaced', async () => {
    const dir = await newDir()
    const filePath = join(dir, IDENTITY_SEED_FILE_NAME)
    await writeFile(filePath, 'not-a-seed\n')

    await expect(loadOrCreateIdentitySeed(dir)).rejects.toThrow(/Corrupt identity seed/)
    // The corrupt file survives untouched — no silent re-roll.
    expect(await readFile(filePath, 'utf8')).toBe('not-a-seed\n')
  })

  it('NO_CONSTANT_SEED_LEFT: no src/main file pins a constant seed; boot uses the module', async () => {
    const mainDir = join(APP_DIR, 'src', 'main')
    const mainFiles = (await readdir(mainDir)).filter((name) => name.endsWith('.ts'))
    expect(mainFiles.length).toBeGreaterThan(0)

    for (const name of mainFiles) {
      const src = stripComments(await readFile(join(mainDir, name), 'utf8'))
      // The criterion is "in app main" — scan EVERY main-process source.
      expect(src, `${name} pins an 0x5c-style constant`).not.toMatch(/0x5c\s*\+/)
      expect(src, `${name} declares a constant IDENTITY_SEED`).not.toMatch(/IDENTITY_SEED\s*=/)
    }

    // Non-vacuity: the boot path really calls the module.
    const indexSrc = await readFile(join(mainDir, 'index.ts'), 'utf8')
    expect(indexSrc).toContain('loadOrCreateIdentitySeed')
  })
})
