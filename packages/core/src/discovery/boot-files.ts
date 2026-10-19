/**
 * `core/discovery/boot-files` — the fallback-ladder boot FILE rungs
 * (CAP-7, ticket 8.5, R4; design §"The Ladder").
 *
 * WHAT THIS MODULE MAY TOUCH (and why the AD-10 purity scans do NOT apply):
 * like the genesis loader (`config/genesis.ts`), this is a BOOTSTRAP
 * I/O boundary — it reads/writes LOCAL FILES the operator (or another app
 * on the LAN) placed there. It is deliberately OUTSIDE the purity-scanned
 * set: no consensus, crypto-purity, or headless-logic module imports fs;
 * everything downstream (`announcements.ts`, `address-book.ts`, the loop)
 * stays pure and receives already-read bytes. The orchestrator here keeps
 * the LOGIC testable by taking explicit paths/deps — no ambient state.
 *
 * THE LADDER (design order, each rung independent + fail-soft):
 *   1. mDNS            — shipped in 7.2's net config; reported, not re-done.
 *   2. LAN hints FILE  — records ingest into the address book HINT-GRADE:
 *                        stored, NEVER dialed without 3 vouchs (a poisoned
 *                        LAN file is therefore inert by construction).
 *   3. artifact FILE   — block-grade announcement records carried on a
 *                        local path (the epic Notes MVP: what the Amnesiac
 *                        Boot Proof feeds a wiped node). Validated at the
 *                        caller's currentSlot ("read before dial" on own
 *                        signature) and returned as DIAL TARGETS — they do
 *                        NOT enter the book, because a file carries no
 *                        block proof and the book's `block` class requires
 *                        a real `blockRef` (never fabricated here).
 *   4. applied blocks  — shipped in 8.3/8.4 (`chainId` wiring); reported.
 *
 * HARD RULES: every reader NEVER throws — a missing file is `{found:false}`,
 * junk is a skip count (fail-soft, R4). Files are bounded
 * ({@link MAX_ARTIFACT_RECORDS}). Writes are ATOMIC (tmp + rename) — a torn
 * file must never poison the next boot. All time inputs are caller-supplied
 * (AD-3): this module reads no clock. The report is counts only — AD-9-safe.
 */
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { validatePeerAnnouncement } from './announcements.js'
import { MAX_INVITE_TEXT_LEN, verifyInvite } from './invitation.js'
import type { AddressBook } from './address-book.js'

import { PeerAnnouncement } from '../proto/index.js'

/** Records per file (artifact OR hints) — beyond this, the rest are skipped. */
export const MAX_ARTIFACT_RECORDS = 64

/** The on-disk envelope: canonical `PeerAnnouncement` wire blobs as hex, so
 * every record SELF-VALIDATES (proto decode + validator) at read time. */
interface AnnouncementFileEnvelope {
  version: 1
  blobs: string[]
}

/** Result of reading one announcement file (never throws). */
export interface AnnouncementFileRead {
  /** False when the file is absent/unreadable; junk-but-present is TRUE. */
  found: boolean
  /** Proto-decoded candidate records, in file order (NOT yet validated —
   * candidates only: decode proves bytes, not chain/freshness/trust). */
  records: unknown[]
  /** Blob-level junk (bad hex / undecodable bytes / over-cap overflow). */
  skipped: number
}

/** Counts for one file rung of the ladder (AD-9-safe: numbers only). */
export interface LadderRungReport {
  found: boolean
  ingested: number
  skipped: number
}

/** What worked at boot (design "how did this node find its way" — counts,
 * never key material; surfaced to logs/UI, AD-9). */
export interface LadderReport {
  /** Rung 1: mDNS was enabled in the net config (7.2 seam). */
  mdns: boolean
  /** Rung 2: LAN hints file — records stored hint-grade. */
  hints: LadderRungReport
  /** Rung 3: artifact file — VALID record count kept as dial targets. */
  artifact: { found: boolean; targets: number; skipped: number }
  /** Rung 0 (9.2): invitation file — verified + applied invite count. */
  invites: { found: boolean; verified: number; rejected: number }
  /** Rung 4: block-announcement ingest is wired (8.3/8.4 `chainId`). */
  blocks: boolean
}

export interface BootLadderOptions {
  /** This network's chain id — records from other chains never pass. */
  chainId: string
  /** Caller-supplied chain time for validation (AD-3 — no clock here). */
  currentSlot: number | bigint
  /** Rung 0 (9.2) input: the invitation file (verified invite-grade join). */
  inviteFilePath?: string
  /** Rung 0 liveness probe (passed to `verifyInvite`); absent = invites on
   * disk cannot be verified and are counted rejected — never dialed blind. */
  hadRecentTicket?: (identityId: string, sinceWindow: bigint) => boolean
  /** Rung 0 liveness lookback window (default inside `verifyInvite`). */
  inviteLookbackSlots?: number | bigint
  /** Rung 2 input: the LAN shared address-book file (hint-grade ingest). */
  hintsFilePath?: string
  /** Rung 2 sink: without a book the rung reports `found` and ingests 0. */
  book?: AddressBook
  /** Rung 3 input: the block-grade artifact file. */
  artifactFilePath?: string
  /** Rung 3 dialer: resolves true on connect. Absent = read-only ladder. */
  dial?: (multiaddr: string) => Promise<boolean>
  /** This node's own identity — its (stale) records in an artifact are
   * never dialed back at ourselves. */
  selfIdentityId?: string
  /** Rung-1 report input (the host passes `NetConfig.mdns`). */
  mdnsEnabled?: boolean
  /** Rung-4 report input (true when block ingest is wired via chainId). */
  blocksEnabled?: boolean
}

// ---------------------------------------------------------------------------
// file codec (atomic write / never-throw read)
// ---------------------------------------------------------------------------

function bytesToHex(b: Uint8Array): string {
  let out = ''
  for (const byte of b) out += byte.toString(16).padStart(2, '0')
  return out
}

/** Strict lowercase-hex → bytes; `null` on any junk (never throws). */
function hexToBytes(s: string): Uint8Array | null {
  if (!/^(?:[0-9a-f]{2})+$/.test(s)) return null
  const out = new Uint8Array(s.length / 2)
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

let tmpCounter = 0

/**
 * ATOMICALLY write announcement blobs (canonical wire bytes) to `path` as
 * the versioned JSON envelope: mkdir parents, write `path.tmp-<pid>-<n>`,
 * rename over the target. A crash leaves either the old file or the new —
 * never a torn one. The cap is a PROGRAMMING-ERROR throw (caller misuse of
 * a trusted helper); junk INPUT never reaches this function.
 */
export async function writeAnnouncementFile(
  path: string,
  blobs: readonly Uint8Array[],
): Promise<void> {
  if (blobs.length > MAX_ARTIFACT_RECORDS) {
    throw new RangeError(`boot-files: ${blobs.length} exceeds cap ${MAX_ARTIFACT_RECORDS}`)
  }
  const envelope: AnnouncementFileEnvelope = {
    version: 1,
    blobs: blobs.map(bytesToHex),
  }
  await mkdir(dirname(path), { recursive: true })
  tmpCounter += 1
  const tmp = `${path}.tmp-${process.pid}-${tmpCounter}`
  try {
    await writeFile(tmp, JSON.stringify(envelope), 'utf8')
    await rename(tmp, path)
  } catch (err) {
    // Failed write/rename must not orphan a tmp file in the shared dir.
    await unlink(tmp).catch(() => undefined)
    throw err
  }
}

/** Convenience: encode `PeerAnnouncement`-shaped messages then write. */
export async function writeAnnouncementsFromMessages(
  path: string,
  messages: readonly Parameters<typeof PeerAnnouncement.encode>[0][],
): Promise<void> {
  // This protons build: `encode` returns the canonical bytes directly.
  await writeAnnouncementFile(path, messages.map((m) => PeerAnnouncement.encode(m)))
}

/**
 * Read + proto-decode one announcement file. NEVER throws: absent/
 * unreadable → `{found:false}`; unparseable envelope → present-but-empty;
 * bad hex / undecodable blob → counted skip; over-cap → counted skip.
 */
export async function readAnnouncementFile(path: string): Promise<AnnouncementFileRead> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return { found: false, records: [], skipped: 0 }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { found: true, records: [], skipped: 0 }
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { found: true, records: [], skipped: 0 }
  }
  const env = parsed as Partial<AnnouncementFileEnvelope>
  if (env.version !== 1 || !Array.isArray(env.blobs)) {
    return { found: true, records: [], skipped: 0 }
  }
  const records: unknown[] = []
  let skipped = 0
  for (const blob of env.blobs) {
    if (records.length >= MAX_ARTIFACT_RECORDS) {
      skipped += 1
      continue
    }
    const bytes = typeof blob === 'string' ? hexToBytes(blob) : null
    if (bytes === null) {
      skipped += 1
      continue
    }
    try {
      records.push(PeerAnnouncement.decode(bytes))
    } catch {
      skipped += 1
    }
  }
  return { found: true, records, skipped }
}

// ---------------------------------------------------------------------------
// invitation file (9.2) — plain-text lines, verify-before-dial
// ---------------------------------------------------------------------------

/** Invite lines per file (beyond this, the rest are skipped). */
export const MAX_INVITE_LINES = 8

export interface InviteFileRead {
  /** False when the file is absent/unreadable; junk-but-present is TRUE. */
  found: boolean
  /** Non-empty, non-comment lines, in file order (NOT yet verified — a line
   * is text, not trust; `applyInvites` runs the full verification). */
  lines: string[]
  /** Lines dropped for shape reasons or over-cap overflow. */
  skipped: number
}

/**
 * Read `<userData>/invite.txt` (one `scinvite:v1:` line per invite, `#`
 * comments + blanks ignored). NEVER throws — same fail-soft contract as the
 * announcement files. Lines are kept verbatim (whitespace inside a line is
 * stripped later by `parseInvite`; wrapping is tolerated there too).
 */
export async function readInviteFile(path: string): Promise<InviteFileRead> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return { found: false, lines: [], skipped: 0 }
  }
  const lines: string[] = []
  let skipped = 0
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    // Length cap (9.2 review): a valid encoded record is ~2 KB; an absurd
    // single-line file must not hand boot a megabyte base64 decode. Counted
    // as skipped — fail-soft, like every other malformed line.
    if (line.replace(/\s/g, '').length > MAX_INVITE_TEXT_LEN || lines.length >= MAX_INVITE_LINES) {
      skipped += 1
      continue
    }
    lines.push(line)
  }
  return { found: true, lines, skipped }
}

/** Options for `applyInvites` — all time/chain inputs caller-supplied (AD-3). */
export interface ApplyInvitesOptions {
  lines: readonly string[]
  chainId: string
  currentSlot: number | bigint
  /** Liveness getter passed through to `verifyInvite` untouched. */
  hadRecentTicket(identityId: string, sinceWindow: bigint): boolean
  lookbackSlots?: number | bigint
  /** Verified records ingest invite-grade here (absent = verify + dial only). */
  book?: AddressBook
  /** Own identity: an invite to ourselves verifies but is not applied. */
  selfIdentityId?: string
  /** Dialer: resolves true on connect; failures swallowed into counts. */
  dial?: (multiaddr: string) => Promise<boolean>
}

/** Counts only (AD-9): no invite text, no keys, no addresses. */
export interface InviteApplyReport {
  verified: number
  rejected: number
  /** Records whose dial list was attempted to completion (success or not). */
  dialed: number
}

/**
 * Verify-then-apply invite lines (9.2 join seam): every line runs the FULL
 * three-gate `verifyInvite` (parse → 8.2 validator → ticket liveness) in a
 * FIRST pass; only then are the verified records stored and dialed in a
 * second pass. Two passes bound the liveness snapshot's staleness to the
 * verify pass alone — dial timeouts (10 s each) can no longer stretch the
 * window between an allow-all boot snapshot and the later lines' verdicts.
 * A failure is a counted reject and yields NO dial target — structural
 * verify-before-connect. Successes ingest invite-grade into `book` and get
 * their addresses dialed in order, first success wins (artifact rung rule).
 */
export async function applyInvites(opts: ApplyInvitesOptions): Promise<InviteApplyReport> {
  const report: InviteApplyReport = { verified: 0, rejected: 0, dialed: 0 }
  // Pass 1 — verify everything (pure CPU; no awaits, so no staleness).
  const verifiedRecords: { record: InviteVerifiedRecord }[] = []
  for (const line of opts.lines) {
    const result = verifyInvite(line, {
      currentSlot: opts.currentSlot,
      expectedChainId: opts.chainId,
      hadRecentTicket: opts.hadRecentTicket,
      lookbackSlots: opts.lookbackSlots,
    })
    if (!result.ok) {
      report.rejected += 1
      continue
    }
    if (opts.selfIdentityId !== undefined && result.record.identityId === opts.selfIdentityId) {
      report.verified += 1 // own invite: verified, never applied/dialed
      continue
    }
    report.verified += 1
    verifiedRecords.push({ record: result.record })
  }
  // Pass 2 — store + dial the accepted records (the only awaiting phase).
  for (const { record } of verifiedRecords) {
    if (opts.book !== undefined) {
      opts.book.ingestAnnouncement(record, {
        currentSlot: opts.currentSlot,
        expectedChainId: opts.chainId,
        sourceClass: 'invite',
      })
    }
    report.dialed += 1
    if (opts.dial !== undefined) {
      for (const addr of record.multiaddrs) {
        let ok = false
        try {
          ok = await opts.dial(addr)
        } catch {
          ok = false
        }
        if (ok) break
      }
    }
  }
  return report
}

type InviteVerifiedRecord = Extract<
  Awaited<ReturnType<typeof verifyInvite>>,
  { ok: true }
>['record']

// ---------------------------------------------------------------------------
// OS-appropriate LAN shared-file default (pure — platform/env injected)
// ---------------------------------------------------------------------------

/**
 * The OS-appropriate default location for the SHARED LAN address-book file
 * (a machine-readable public dir other hosts on the LAN can reach — e.g.
 * via an existing share mount). `env.SUCCINCTCOIN_LAN_BOOK` overrides;
 * `sharedDir` overrides the per-OS public root (tests, unusual mounts).
 * Pure: platform + env are parameters.
 */
export function defaultLanBookPath(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  sharedDir?: string,
): string {
  if (env.SUCCINCTCOIN_LAN_BOOK !== undefined && env.SUCCINCTCOIN_LAN_BOOK !== '') {
    return env.SUCCINCTCOIN_LAN_BOOK
  }
  const root =
    sharedDir ??
    (platform === 'darwin'
      ? '/Users/Shared'
      : platform === 'win32'
        ? 'C:\\Users\\Public'
        : '/var/tmp')
  const sep = platform === 'win32' ? '\\' : '/'
  return `${root}${sep}succinctcoin${sep}address-book.json`
}

// ---------------------------------------------------------------------------
// the ladder orchestrator
// ---------------------------------------------------------------------------

/**
 * Run the file rungs of the fallback ladder (2 + 3) and report what worked.
 * Every failure mode is fail-soft (R4): a rung that cannot read, parse, or
 * dial leaves the node exactly as well-connected as it was. HINT records go
 * into `book` hint-grade (stored, never dial-eligible without 3 vouchs —
 * poisoned-hint fail-soft is structural). ARTIFACT records are validated at
 * `currentSlot` and dialed directly (each multiaddr of a record tried in
 * order until one succeeds); they never enter the book (no block proof to
 * cite — see module docs). `dial` failures are swallowed into counts.
 */
export async function runBootLadder(opts: BootLadderOptions): Promise<LadderReport> {
  const report: LadderReport = {
    mdns: opts.mdnsEnabled ?? false,
    invites: { found: false, verified: 0, rejected: 0 },
    hints: { found: false, ingested: 0, skipped: 0 },
    artifact: { found: false, targets: 0, skipped: 0 },
    blocks: opts.blocksEnabled ?? false,
  }

  // Rung 0 (9.2) — invitation file FIRST: a trusted invite outranks every
  // hint rung, and its verified records make the later rungs' jobs easier.
  if (opts.inviteFilePath !== undefined) {
    const read = await readInviteFile(opts.inviteFilePath)
    report.invites.found = read.found
    if (read.lines.length === 0) {
      report.invites.rejected = read.skipped
    } else if (opts.hadRecentTicket === undefined) {
      // No liveness probe configured: an invite we cannot verify is NOTHING
      // (and dialing blind would break verify-before-connect). Count rejects.
      report.invites.rejected = read.lines.length + read.skipped
    } else {
      const applied = await applyInvites({
        lines: read.lines,
        chainId: opts.chainId,
        currentSlot: opts.currentSlot,
        hadRecentTicket: opts.hadRecentTicket,
        lookbackSlots: opts.inviteLookbackSlots,
        book: opts.book,
        selfIdentityId: opts.selfIdentityId,
        dial: opts.dial,
      })
      report.invites.verified = applied.verified
      // Rejected lines + line-level skips are all rejects (counts, AD-9).
      report.invites.rejected = applied.rejected + read.skipped
    }
  }

  // Rung 2 — LAN hints file: validate-then-store HINT-GRADE (the book's own
  // ingest runs the full validator; a bad record is a counted reject).
  if (opts.hintsFilePath !== undefined) {
    const read = await readAnnouncementFile(opts.hintsFilePath)
    report.hints.found = read.found
    report.hints.skipped = read.skipped
    for (const record of read.records) {
      if (opts.book === undefined) {
        report.hints.skipped += 1
        continue
      }
      const identityId = (record as { identityId?: unknown } | null)?.identityId
      if (opts.selfIdentityId !== undefined && identityId === opts.selfIdentityId) {
        report.hints.skipped += 1 // own record: the book ignores it, the count must agree
        continue
      }
      const result = opts.book.ingestAnnouncement(record, {
        currentSlot: opts.currentSlot,
        expectedChainId: opts.chainId,
        sourceClass: 'hint',
      })
      if (result.ok) report.hints.ingested += 1
      else report.hints.skipped += 1
    }
  }

  // Rung 3 — artifact file: validate at currentSlot, dial what passes.
  if (opts.artifactFilePath !== undefined) {
    const read = await readAnnouncementFile(opts.artifactFilePath)
    report.artifact.found = read.found
    report.artifact.skipped = read.skipped
    for (const record of read.records) {
      const validation = validatePeerAnnouncement(record, {
        currentSlot: opts.currentSlot,
        expectedChainId: opts.chainId,
      })
      if (!validation.ok) {
        report.artifact.skipped += 1
        continue
      }
      const r = record as { identityId: string; multiaddrs: readonly string[] }
      if (opts.selfIdentityId !== undefined && r.identityId === opts.selfIdentityId) {
        report.artifact.skipped += 1 // never dial ourselves
        continue
      }
      report.artifact.targets += 1
      if (opts.dial !== undefined) {
        for (const addr of r.multiaddrs) {
          let ok = false
          try {
            ok = await opts.dial(addr)
          } catch {
            ok = false
          }
          if (ok) break // first successful address wins
        }
      }
    }
  }

  return report
}

/** The default artifact path inside a host's data dir (per-install). */
export function defaultArtifactPath(userDataDir: string): string {
  return join(userDataDir, 'discovery-artifact.json')
}

/** The default invitation file inside a host's data dir (9.2 — plain text:
 * one `scinvite:v1:` line per invite; the operator pastes/receives it). */
export function defaultInvitePath(userDataDir: string): string {
  return join(userDataDir, 'invite.txt')
}
