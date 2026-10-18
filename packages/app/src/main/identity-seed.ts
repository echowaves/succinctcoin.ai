/**
 * `app/main/identity-seed` — the persisted PER-INSTALL identity seed
 * (ticket 8.1 — the CAP-7 prerequisite; reverses the 6.2 shared-seed
 * deferral, RATIFIED in deferred-work on 2026-10-17).
 *
 * The pinned constant seed this module replaces made EVERY install derive
 * the SAME identity, and the node-loop's per-slot dedupe (keyed by
 * `identityId`) then lets only one instance's ticket win — cross-instance
 * mining was structurally impossible. CAP-7 discovery (signed announcements,
 * ticket 8.3+) cryptographically requires distinct per-install keypairs, so
 * the seed becomes a per-install secret: created ONCE with
 * `crypto.getRandomValues` (startup key generation only — AD-3's no-RNG rule
 * governs CONSENSUS logic, not identity creation), then loaded byte-stable
 * on every later boot.
 *
 * The file is single-line lowercase hex (64 chars) at
 * `<userData>/identity.seed`, written ATOMICALLY (unique temp + `link`, so
 * concurrent first boots converge on ONE seed) with mode `0600` — the seed
 * is a secret, and a half-written file must never mint a
 * new identity: content that is not exactly 32 bytes of lowercase hex
 * THROWS rather than silently re-rolling.
 *
 * AD-10 discipline (the `net-config.ts` seam pattern): this module is
 * electron-free — it takes the directory as a parameter, so headless
 * plain-Node tests inject tmp dirs and never spawn Electron. AD-11: the
 * seed NEVER crosses IPC; it stays in main, where `index.ts` feeds it to
 * the core's `deriveIdentityKeypair`.
 */
import { randomFillSync, randomUUID } from 'node:crypto'
import { chmod, link, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** The seed file's name inside the app's userData dir (beside `chain/`). */
export const IDENTITY_SEED_FILE_NAME = 'identity.seed'

/** The seed's width in bytes — the core's `deriveIdentityKeypair` contract. */
export const IDENTITY_SEED_BYTES = 32

const HEX_64 = /^[0-9a-f]{64}$/

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function fromHexOrFail(hex: string, filePath: string): Uint8Array {
  if (!HEX_64.test(hex)) {
    // A corrupt/truncated identity file must not silently mint a NEW
    // identity (that would look like an unexplained peer-id change).
    // The message reports ONLY the shape — never a slice of the content,
    // which may be (nearly) the secret itself.
    throw new Error(
      `Corrupt identity seed file ${filePath}: expected 64 lowercase hex chars, got ${Buffer.byteLength(hex, 'utf8')} non-conforming chars`,
    )
  }
  return Uint8Array.from({ length: IDENTITY_SEED_BYTES }, (_, i) =>
    Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16),
  )
}

/**
 * Load this install's identity seed, creating it on first boot.
 *
 * The ONLY seed source for `index.ts` (ticket 8.1): two boots of the same
 * dir derive the SAME keypair; two dirs derive DISTINCT ones — which is
 * exactly what CAP-7 announcements sign against. Atomic, race-safe create
 * (unique `<file>.tmp-*` + `link`; an EEXIST loser adopts the winner), mode
 * `0600` set at creation AND re-asserted after the link lands so a permissive
 * umask cannot leak a group-readable secret. `dir` is the caller's data directory (production:
 * `app.getPath('userData')`; tests: an injected tmp dir — AD-10).
 */
export async function loadOrCreateIdentitySeed(dir: string): Promise<Uint8Array> {
  const filePath = join(dir, IDENTITY_SEED_FILE_NAME)
  await mkdir(dir, { recursive: true })

  try {
    return fromHexOrFail((await readFile(filePath, 'utf8')).trim(), filePath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }

  const seed = new Uint8Array(IDENTITY_SEED_BYTES)
  randomFillSync(seed) // startup key generation, not consensus (AD-3 scope)

  // Atomic AND race-safe create: write a uniquely-named temp (a crash
  // between here and the link may orphan one — inert), then LINK it into
  // place. `link` fails EEXIST when another instance's create won, and the
  // loser adopts the winner's seed — two processes booting the same userData
  // concurrently still converge on ONE identity (the whole point of 8.1).
  const tmpPath = `${filePath}.tmp-${randomUUID()}`
  await writeFile(tmpPath, `${toHex(seed)}\n`, { mode: 0o600 })
  try {
    await link(tmpPath, filePath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    return fromHexOrFail((await readFile(filePath, 'utf8')).trim(), filePath)
  } finally {
    await rm(tmpPath, { force: true })
  }
  await chmod(filePath, 0o600) // re-assert after the link lands (umask-proof)
  return seed
}
