/**
 * `core/store` — the file-backed `ChainStore` adapter (AD-9 single-writer
 * persistence).
 *
 * A zero-new-dependency engine: per-slot block files + one exclusive
 * `O_CREAT|O_EXCL` PID lockfile on the data directory. The engine choice is
 * the ticket's reserved code-level decision (AD-9): custom, no SQLite/LevelDB.
 *
 * Layout under `<dir>`:
 *   - `.lock`               — the exclusive data-directory lockfile (holder PID)
 *   - `blocks/<slot>.block` — canonical wire bytes, written atomically (tmp +
 *                             fsync + rename) so a crash never corrupts a file
 *
 * Contract: the store persists **canonical wire bytes** (the generated
 * `Block.encode` form) and hands back exactly those bytes — byte-identity is
 * the contract, no re-serialization. `commit(block)` encodes once on the way
 * in; `getBlock(slot)` returns the stored file bytes verbatim, which is what
 * makes the persist/reload round-trip a true byte-identity check.
 *
 * One writer: the data directory is locked with an exclusive `O_EXCL`
 * lockfile, so a second core against the same directory fails at boot with a
 * clear `SC-STORE-1` error (AD-9). A stale lockfile left by a crashed process
 * (dead PID) is detected and taken over — not a permanent brick.
 *
 * No consensus/ledger/identity/net logic lives here: the store persists bytes
 * and reports `headSlot`. Ordering, validation, and the single-writer loop
 * are epic 3. No UI imports (AD-1); no hand-written protocol types (AD-12) —
 * the adapter uses the generated `Block` codec only.
 */
import { constants, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'

import { Block } from '../proto/index.js'
import type { StorePort } from '../ports.js'

/**
 * Store error. Carries the spine's `{ code, message }` shape: lock
 * contention is `SC-STORE-1` (message names the directory + holder);
 * calling `commit`/`getBlock` before `open` is `SC-STORE-2` — a separate
 * code so a boot path that special-cases `SC-STORE-1` ("directory in use")
 * never misreads a not-open programming error.
 */
export class StoreError extends Error {
  readonly code: 'SC-STORE-1' | 'SC-STORE-2'
  constructor(message: string, code: 'SC-STORE-1' | 'SC-STORE-2' = 'SC-STORE-1') {
    super(message)
    this.name = 'StoreError'
    this.code = code
  }
}

/**
 * File-backed `StorePort` (AD-9). Opens an exclusive lock on `dir`, persists
 * canonical block bytes under `blocks/<slot>.block`, and tracks the in-memory
 * head slot (scanned at `open()`, advanced on `commit`).
 *
 * The constructor is cheap and does no I/O — the directory is created and the
 * lock acquired in `open()`, so constructing a second store against a locked
 * directory is harmless until `open()` is called.
 */
export class FileChainStore implements StorePort {
  private readonly dir: string
  private readonly blocksDir: string
  private opened = false
  private head = -1

  constructor(dir: string) {
    this.dir = dir
    this.blocksDir = join(dir, 'blocks')
  }

  /**
   * Create the data directory and acquire the exclusive lock, then scan
   * `blocks/` for the highest committed slot (absent/empty → -1). A contended
   * directory rejects with `SC-STORE-1`; a stale lockfile (dead holder PID) is
   * taken over.
   */
  async open(): Promise<void> {
    if (this.opened) return
    // mkdir -p the data dir + blocks subdir.
    mkdirSync(this.dir, { recursive: true })
    mkdirSync(this.blocksDir, { recursive: true })

    await this.acquireLock()
    this.head = this.scanHead()
    this.opened = true
  }

  /** Release the lock — but only if the lockfile still names THIS process.
   *  If a stale-takeover already replaced it (we died, were reaped, and
   *  someone took over), unlinking would delete the NEW holder's lock and
   *  open the directory to a second writer (AD-9) — so we leave it alone. */
  async close(): Promise<void> {
    if (!this.opened) return
    this.opened = false
    const lockPath = join(this.dir, '.lock')
    if (this.readHolderPid(lockPath) === process.pid) {
      this.unlinkBestEffort(lockPath)
    }
    this.head = -1
  }

  /**
   * Commit one canonical block record (the single mutation path, AD-2).
   * `block` is the generated `Block` (the consensus loop is the only caller,
   * epic 3); it is encoded with `Block.encode` → canonical bytes, written
   * atomically to `blocks/<slot>.block`, and the in-memory head advanced.
   */
  async commit(block: unknown): Promise<void> {
    if (!this.opened) throw new StoreError(`SC-STORE-2: store at ${this.dir} is not open`, 'SC-STORE-2')
    const b = block as Block
    const bytes = Block.encode(b)
    const slot = Number(b.slot)
    await this.atomicWrite(join(this.blocksDir, `${slot}.block`), bytes)
    if (slot > this.head) this.head = slot
  }

  /**
   * Read the stored canonical bytes for `slot`, or `null` if absent. Returns
   * the file bytes verbatim — never re-derived from a decoded object.
   */
  async getBlock(slot: number): Promise<Uint8Array | null> {
    if (!this.opened) throw new StoreError(`SC-STORE-2: store at ${this.dir} is not open`, 'SC-STORE-2')
    const path = join(this.blocksDir, `${slot}.block`)
    try {
      return new Uint8Array(readFileSync(path))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  }

  /** Highest committed slot, or -1 for an empty chain (in-memory). */
  async headSlot(): Promise<number> {
    return this.head
  }

  // ---- internals -------------------------------------------------------

  /**
   * Acquire the exclusive lockfile. On `EEXIST`, read the holder PID: a dead
   * PID (ESRCH) is unlinked and the create retried ONCE (the retry — not the
   * delete — is the atomic arbiter under concurrent stale-takeover); a live
   * PID (or an unreadable one) rejects `SC-STORE-1` naming dir + PID.
   */
  private async acquireLock(): Promise<void> {
    const lockPath = join(this.dir, '.lock')
    const fd = this.tryCreate(lockPath)
    if (fd !== null) {
      this.writePid(fd)
      return
    }

    // EEXIST — the directory is locked. Inspect the holder.
    const holderPid = this.readHolderPid(lockPath)
    if (holderPid !== null && !this.isAlive(holderPid)) {
      // Stale lock from a crashed process: take over, then retry the create
      // exactly once. The retry is what makes takeover atomic.
      this.unlinkBestEffort(lockPath)
      const retryFd = this.tryCreate(lockPath)
      if (retryFd !== null) {
        this.writePid(retryFd)
        return
      }
      // Lost the takeover race (someone else grabbed it) — fall through.
    }

    throw new StoreError(
      `SC-STORE-1: data directory ${this.dir} is already locked by holder pid ${holderPid ?? 'unknown'}`,
    )
  }

  /** `O_CREAT|O_EXCL` create; returns the fd on success, `null` on `EEXIST`. */
  private tryCreate(lockPath: string): number | null {
    try {
      return openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return null
      throw err
    }
  }

  /** Write our PID to a freshly-created lockfile and close it. */
  private writePid(fd: number): void {
    writeFileSync(fd, String(process.pid))
    closeSync(fd)
  }

  /** Parse the holder PID from an existing lockfile (`null` if unreadable). */
  private readHolderPid(lockPath: string): number | null {
    try {
      const pid = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10)
      return Number.isInteger(pid) && pid > 0 ? pid : null
    } catch {
      return null
    }
  }

  /**
   * Is `pid` a live process? `process.kill(pid, 0)` signals nothing — it only
   * probes. No throw → alive; EPERM → alive (other user, can't take it);
   * ESRCH → dead (the only provable dead signal). Anything else is treated as
   * alive — the conservative bias: never steal a lock whose holder we cannot
   * prove dead (a wrong steal is two-writer corruption, AD-9).
   */
  private isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch (err) {
      // ESRCH = no such process (dead — the holder crashed). EPERM = exists
      // but not ours (alive). Anything else: conservative — do not steal.
      return (err as NodeJS.ErrnoException).code !== 'ESRCH'
    }
  }

  /** Scan `blocks/` for the max numeric `<slot>.block` file name (-1 if none). */
  private scanHead(): number {
    let entries: string[]
    try {
      entries = readdirSync(this.blocksDir)
    } catch {
      return -1
    }
    let max = -1
    for (const name of entries) {
      if (!name.endsWith('.block')) continue
      const slot = Number.parseInt(name.slice(0, name.length - '.block'.length), 10)
      if (Number.isInteger(slot) && slot > max) max = slot
    }
    return max
  }

  /**
   * Atomic write: write to `<target>.tmp-<pid>-<rand>`, fsync, then rename
   * onto `<target>`. The rename is atomic on the same filesystem, so a crash
   * mid-write never leaves a torn block file behind.
   */
  private async atomicWrite(targetPath: string, data: Uint8Array): Promise<void> {
    const tmpPath = `${targetPath}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`
    const fd = openSync(tmpPath, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, 0o644)
    try {
      writeFileSync(fd, data)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmpPath, targetPath)
  }

  /** `unlink` that swallows errors (used for best-effort lock release). */
  private unlinkBestEffort(path: string): void {
    try {
      unlinkSync(path)
    } catch {
      /* best-effort */
    }
  }
}
