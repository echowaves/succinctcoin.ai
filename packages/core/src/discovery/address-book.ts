/**
 * `core/discovery/address-book` — the CAP-7 address book (ticket 8.4):
 * keyed by `identityId` (ONE identity, many addresses — DHCP/NAT rotation is
 * natural, identities persist), every entry tagged `(source class,
 * first-seen slot)` with source classes ordered block > log > dns > hint
 * (discovery-design.md's trust taxonomy).
 *
 * Verify-before-connect is THE rule, and it is STRUCTURAL: the only paths
 * into the book run the pinned validators (`validatePeerAnnouncement` /
 * `validateIntroduction`) on the raw decoded record internally — an
 * unsigned, forged, wrong-chain, or expired-at-ingest record CANNOT enter,
 * so `dialEligible(slot)` can never contain one. Callers hand in UNTRUSTED
 * wire data; nothing is trusted until checked.
 *
 * Rules (pinned by the ticket):
 *  - block-grade entries come from 8.3's emission and store their ORIGINAT-
 *    ING BLOCK (`blockRef`); `retractBlock(hash)` removes exactly the
 *    entries whose current provenance is that block (reorg retraction —
 *    key-by-block, not replay-from-head).
 *  - hint/dns-grade entries become dial-eligible only after >= 3 intro-
 *    ductions from DISTINCT signers; log-grade needs >= 1 ("corroborate,
 *    then dial"); block-grade needs none while fresh. Introductions for a
 *    not-yet-known subject are PARKED (validated first) and merged when the
 *    subject's record arrives — gossip order cannot demote a vouch.
 *  - expiry is a function of the CALLER-SUPPLIED slot (AD-3: no clocks,
 *    ever); quarantine-after-3-failed-dials likewise.
 *  - book size cap with deterministic eviction preferring freshest /
 *    highest-class records (the ticket's "under pressure" unknown).
 *
 * Purity (AD-3/AD-10): NO clock, NO net, NO fs — every time-dependent
 * method takes `currentSlot` as a parameter. This module decides who is
 * SAFE TO DIAL; the dialing itself is 8.5's fallback ladder.
 */
import { validatePeerAnnouncement } from './announcements.js'
import type { AnnouncementRejectReason, SignedPeerAnnouncement } from './announcements.js'
import { validateIntroduction } from './introductions.js'
import type { IntroductionRejectReason, SignedIntroduction } from './introductions.js'

// ---------------------------------------------------------------------------
// vocabulary
// ---------------------------------------------------------------------------

/** Trust classes, most trusted first (discovery-design.md taxonomy). */
export const ADDRESS_SOURCE_CLASSES = ['block', 'log', 'dns', 'hint'] as const
export type AddressSourceClass = (typeof ADDRESS_SOURCE_CLASSES)[number]

/** Higher = more trusted. `block` is the only class with a producer today;
 * `log`/`dns` are enum-only stubs this epic (no producers ship). */
const CLASS_RANK: Record<AddressSourceClass, number> = { block: 3, log: 2, dns: 1, hint: 0 }

/** Introductions required for eligibility per class (pinned table): block
 * none while fresh; log >= 1; dns/hint >= 3 (the three-introductions rule). */
const REQUIRED_INTRODUCTIONS: Record<AddressSourceClass, number> = {
  block: 0,
  log: 1,
  dns: 3,
  hint: 3,
}

/** Dial failures before quarantine, and the quarantine's slot window. */
export const DIAL_FAILURES_TO_QUARANTINE = 3
export const DEFAULT_QUARANTINE_SLOTS = 32n

/** Book size cap (entries); eviction prefers freshest/highest-class. */
export const MAX_BOOK_ENTRIES = 64

/** Distinct vouches retained per subject (entry OR parked) — the memory
 * bound: one key flooding introductions cannot grow a vouch map without
 * limit. Eviction keeps the FRESHEST vouches (newest slotObserved). */
export const MAX_VOUCHES_PER_SUBJECT = 16

const HEX_ID_64 = /^[0-9a-f]{64}$/

/** Provenance of a block-grade entry — the reorg-retraction key (8.3's
 * emission ctx, verbatim). */
export interface BlockRef {
  /** Hex of the block whose application anchored the record. */
  blockHashHex: string
  /** The block's slot (chain time; informational — provenance keys on hash). */
  slot: bigint
}

/** A book entry as read from outside (immutable snapshot shape). */
export interface AddressBookEntry {
  identityId: string
  multiaddrs: readonly string[]
  observedExternalAddr?: string | undefined
  slotStart: bigint
  slotEnd: bigint
  sourceClass: AddressSourceClass
  /** Slot at which THIS identity first entered the book (never overwritten —
   * replacements preserve it: identities persist across address rotation). */
  firstSeenSlot: bigint
  /** Set exactly when `sourceClass === 'block'`. */
  blockRef?: BlockRef | undefined
  /** Distinct verified introduction signers held for this identity. */
  introductionSigners: readonly string[]
  failedDials: number
  /** While `currentSlot <= quarantineUntilSlot` the entry is ineligible. */
  quarantineUntilSlot?: bigint | undefined
}

/** What the dialer (8.5) consumes — addresses only, never book internals. */
export interface DialTarget {
  identityId: string
  multiaddrs: readonly string[]
  observedExternalAddr?: string | undefined
  sourceClass: AddressSourceClass
}

/** Ingest context: the announcement validator's ctx + provenance tagging. */
export interface BookIngestContext {
  currentSlot: number | bigint
  expectedChainId: string
  /** The class this observation came from (the caller attests the SOURCE;
   * the record itself is validated regardless — the class buys eligibility,
   * never trust in the bytes). */
  sourceClass: AddressSourceClass
  /** REQUIRED for block-grade (reorg retraction key); must be omitted for
   * every other class (a hint claiming a block ref is a programming error). */
  blockRef?: BlockRef | undefined
}

export type BookIngestResult = { ok: true } | { ok: false; reason: AnnouncementRejectReason }
export type BookIntroResult = { ok: true } | { ok: false; reason: IntroductionRejectReason }

export interface AddressBookOptions {
  /** Entry cap (default {@link MAX_BOOK_ENTRIES}). */
  maxEntries?: number
  /** Quarantine window in slots (default {@link DEFAULT_QUARANTINE_SLOTS}). */
  quarantineSlots?: bigint
  /** CAP-7 (8.5): this node's own identity id. When set, records that
   * describe THIS node are accepted-but-ignored — the book is the dial
   * surface, and a node never dials itself, so self-observations must not
   * occupy capacity or appear in {@link AddressBook.dialEligible}. */
  selfIdentityId?: string | undefined
}

export interface AddressBook {
  /** Validate-then-insert a peer announcement record (block-grade ingest
   * consumes 8.3's emission: record + `{ blockHashHex, slot }`). Stale
   * records (older than the held one for that identity) are accepted-but-
   * ignored — they are valid observations, just not better ones. */
  ingestAnnouncement(record: unknown, ctx: BookIngestContext): BookIngestResult
  /** Validate-then-park/merge an introduction (8.4's contract). */
  ingestIntroduction(record: unknown, ctx: { currentSlot: number | bigint; expectedChainId: string }): BookIntroResult
  /** A dial attempt to this identity FAILED at `currentSlot`: 3 failures
   * quarantine the entry for the configured window. Unknown id = no-op. */
  recordDialFailure(identityId: string, currentSlot: number | bigint): void
  /** A successful dial clears the failure counter AND any quarantine. */
  recordDialSuccess(identityId: string): void
  /** Reorg retraction: remove exactly the entries whose CURRENT provenance
   * is this block. Returns how many entries were removed. Unknown hash =
   * no-op (0). */
  retractBlock(blockHashHex: string): number
  /** THE verify-before-connect surface: identities eligible to dial AT
   * `currentSlot` — fresh, unexpired, un-quarantined, and class-promoted.
   * Sorted by identityId hex (deterministic). */
  dialEligible(currentSlot: number | bigint): DialTarget[]
  /** Full read view (no eligibility/slot filter — slot-scoped reads go
   * through `dialEligible`), sorted by identityId hex — for the
   * read-API/8.5/tests. */
  entries(): AddressBookEntry[]
  /** Drop every entry expired AT `currentSlot`; returns how many went. */
  pruneExpired(currentSlot: number | bigint): number
  size(): number
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

interface MutableEntry {
  identityId: string
  multiaddrs: string[]
  observedExternalAddr?: string | undefined
  slotStart: bigint
  slotEnd: bigint
  sourceClass: AddressSourceClass
  firstSeenSlot: bigint
  blockRef?: BlockRef | undefined
  /** signer identityId -> newest validated slotObserved (distinct signers
   * only — the independence rule; one signer can never mint three vouches). */
  introductions: Map<string, bigint>
  failedDials: number
  quarantineUntilSlot?: bigint | undefined
}

function coerce(v: number | bigint): bigint {
  const b = typeof v === 'bigint' ? v : Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null
  if (b === null || b < 0n) throw new RangeError(`address-book: ${String(v)} is not a slot`)
  return b
}

/** (class, slotEnd, firstSeenSlot, id)-worst ordering for eviction: the
 * entry returned by `worse(a, b)` LOSES. Deterministic total order. */
function worse(a: MutableEntry, b: MutableEntry): MutableEntry {
  const ra = CLASS_RANK[a.sourceClass]
  const rb = CLASS_RANK[b.sourceClass]
  if (ra !== rb) return ra < rb ? a : b
  if (a.slotEnd !== b.slotEnd) return a.slotEnd < b.slotEnd ? a : b
  if (a.firstSeenSlot !== b.firstSeenSlot) return a.firstSeenSlot < b.firstSeenSlot ? a : b
  return a.identityId <= b.identityId ? a : b
}

/** Frozen rule: QUARANTINE EXPIRY resets the failure counter (as a dial
 * success does) — otherwise one stale failure after the window re-mints a
 * full quarantine instantly, and an occasional-failer never recovers. */
function expireQuarantine(e: MutableEntry, currentSlot: bigint): void {
  if (e.quarantineUntilSlot !== undefined && currentSlot > e.quarantineUntilSlot) {
    delete e.quarantineUntilSlot
    e.failedDials = 0
  }
}

/** Keep the vouch map bounded, evicting the OLDEST slotObserved (ties: the
 * lexicographically-greatest signer id — deterministic). One eviction per
 * insertion is enough: maps only grow one vouch at a time. */
function capVouches(vouches: Map<string, bigint>): void {
  if (vouches.size <= MAX_VOUCHES_PER_SUBJECT) return
  let worstSigner: string | undefined
  let worstSlot: bigint | undefined
  for (const [signer, slot] of vouches) {
    if (
      worstSlot === undefined ||
      slot < worstSlot ||
      (slot === worstSlot && signer > (worstSigner ?? ''))
    ) {
      worstSigner = signer
      worstSlot = slot
    }
  }
  if (worstSigner !== undefined) vouches.delete(worstSigner)
}

function isEligible(e: MutableEntry, currentSlot: bigint): boolean {
  if (e.slotStart > currentSlot || e.slotEnd < currentSlot) return false
  if (e.quarantineUntilSlot !== undefined && currentSlot <= e.quarantineUntilSlot) return false
  let count = 0
  for (const slot of e.introductions.values()) if (slot <= currentSlot) count += 1
  return count >= REQUIRED_INTRODUCTIONS[e.sourceClass]
}

// ---------------------------------------------------------------------------
// the factory
// ---------------------------------------------------------------------------

/**
 * Create an empty address book. Pure state — every time-dependent behavior
 * is parameterized by `currentSlot` (AD-3). Not thread/lock relevant: one
 * per node process, like the loop.
 */
export function createAddressBook(opts: AddressBookOptions = {}): AddressBook {
  const maxEntries = opts.maxEntries ?? MAX_BOOK_ENTRIES
  const quarantineSlots = opts.quarantineSlots ?? DEFAULT_QUARANTINE_SLOTS
  const selfIdentityId = opts.selfIdentityId
  // Safe read of one string field from an untrusted record (pre-validation
  // the shape is unknown; a non-object or non-string field is simply "not
  // self" — validation still judges it afterwards).
  const describesSelf = (record: unknown, field: string): boolean =>
    selfIdentityId !== undefined &&
    typeof record === 'object' &&
    record !== null &&
    (record as Record<string, unknown>)[field] === selfIdentityId

  const entriesById = new Map<string, MutableEntry>()
  /** blockHashHex -> identity ids whose CURRENT provenance is that block. */
  const byBlock = new Map<string, Set<string>>()
  /** Validated intros for subjects not yet in the book (bounded below). */
  const pending = new Map<string, Map<string, bigint>>()

  function detachProvenance(id: string, ref: BlockRef | undefined): void {
    if (ref === undefined) return
    const set = byBlock.get(ref.blockHashHex)
    if (set === undefined) return
    set.delete(id)
    if (set.size === 0) byBlock.delete(ref.blockHashHex)
  }

  function attachProvenance(id: string, ref: BlockRef | undefined): void {
    if (ref === undefined) return
    let set = byBlock.get(ref.blockHashHex)
    if (set === undefined) {
      set = new Set()
      byBlock.set(ref.blockHashHex, set)
    }
    set.add(id)
  }

  function dropEntry(id: string): void {
    const e = entriesById.get(id)
    if (e === undefined) return
    detachProvenance(id, e.blockRef)
    entriesById.delete(id)
  }

  function evictOne(currentSlot: bigint): void {
    let worst: MutableEntry | undefined
    for (const e of entriesById.values()) {
      worst = worst === undefined ? e : worse(worst, e)
    }
    if (worst !== undefined) dropEntry(worst.identityId)
  }

  function snapshot(e: MutableEntry): AddressBookEntry {
    return {
      identityId: e.identityId,
      multiaddrs: [...e.multiaddrs],
      observedExternalAddr: e.observedExternalAddr,
      slotStart: e.slotStart,
      slotEnd: e.slotEnd,
      sourceClass: e.sourceClass,
      firstSeenSlot: e.firstSeenSlot,
      blockRef: e.blockRef === undefined ? undefined : { ...e.blockRef },
      introductionSigners: [...e.introductions.keys()],
      failedDials: e.failedDials,
      quarantineUntilSlot: e.quarantineUntilSlot,
    }
  }

  function mergePending(e: MutableEntry): void {
    const parked = pending.get(e.identityId)
    if (parked === undefined) return
    for (const [signer, slot] of parked) {
      const held = e.introductions.get(signer)
      if (held === undefined || slot > held) e.introductions.set(signer, slot)
    }
    capVouches(e.introductions) // a merge can top the cap even when neither side topped it
    pending.delete(e.identityId)
  }

  return {
    ingestAnnouncement(record: unknown, ctx: BookIngestContext): BookIngestResult {
      const currentSlot = coerce(ctx.currentSlot)
      // Provenance contract is a programming error, not hostile input.
      if (ctx.sourceClass === 'block' && ctx.blockRef === undefined) {
        throw new Error('address-book: block-grade ingest requires a blockRef (reorg key)')
      }
      if (ctx.sourceClass !== 'block' && ctx.blockRef !== undefined) {
        throw new Error(`address-book: ${ctx.sourceClass}-grade ingest must not carry a blockRef`)
      }
      if (ctx.blockRef !== undefined && !HEX_ID_64.test(ctx.blockRef.blockHashHex)) {
        throw new Error('address-book: blockRef.blockHashHex is not 32-byte hex')
      }
      // Self-exclusion (8.5): a node's own announcements are valid observa-
      // tions but never dial targets — accepted-and-ignored, like a stale one.
      if (describesSelf(record, 'identityId')) return { ok: true }

      const verdict = validatePeerAnnouncement(record, {
        currentSlot,
        expectedChainId: ctx.expectedChainId,
      })
      if (!verdict.ok) return verdict
      // Validator-approved: the shape is now a pinned fact (D5 taxonomy).
      const r = record as SignedPeerAnnouncement
      const slotStart = coerce(r.slotStart)
      const slotEnd = coerce(r.slotEnd)

      const existing = entriesById.get(r.identityId)
      if (existing !== undefined) {
        // Newest-slotEnd-wins; tie -> higher class; equal (slotEnd, class)
        // keeps the held entry (stable). A stale-but-valid observation is
        // NOT an error — it simply does not improve the book.
        const better =
          slotEnd > existing.slotEnd ||
          (slotEnd === existing.slotEnd && CLASS_RANK[ctx.sourceClass] > CLASS_RANK[existing.sourceClass])
        if (!better) return { ok: true }
        // Replacement PRESERVES identity-scoped state: firstSeenSlot, the
        // collected introductions, and quarantine (a fresher record may list
        // the same bad addresses — only a successful dial clears that).
        const preservedIntros = existing.introductions
        const preservedFirstSeen = existing.firstSeenSlot
        const preservedFailures = existing.failedDials
        const preservedQuarantine = existing.quarantineUntilSlot
        detachProvenance(r.identityId, existing.blockRef)
        entriesById.delete(r.identityId)
        install(r.identityId, slotStart, slotEnd, preservedIntros, preservedFirstSeen)
        const e = entriesById.get(r.identityId) as MutableEntry
        e.failedDials = preservedFailures
        if (preservedQuarantine !== undefined) e.quarantineUntilSlot = preservedQuarantine
        return { ok: true }
      }

      // Capacity: prune expired first, then evict the worst (freshest /
      // highest-class survive — the pinned pressure policy).
      if (entriesById.size >= maxEntries) {
        pruneExpiredInner(currentSlot)
        if (entriesById.size >= maxEntries) evictOne(currentSlot)
      }
      install(r.identityId, slotStart, slotEnd, new Map(), currentSlot)
      return { ok: true }

      function install(
        id: string,
        start: bigint,
        end: bigint,
        intros: Map<string, bigint>,
        firstSeen: bigint,
      ): void {
        const entry: MutableEntry = {
          identityId: id,
          multiaddrs: [...r.multiaddrs],
          observedExternalAddr: r.observedExternalAddr,
          slotStart: start,
          slotEnd: end,
          sourceClass: ctx.sourceClass,
          firstSeenSlot: firstSeen,
          blockRef: ctx.blockRef === undefined ? undefined : { ...ctx.blockRef },
          introductions: intros,
          failedDials: 0,
        }
        entriesById.set(id, entry)
        attachProvenance(id, entry.blockRef)
        mergePending(entry)
      }
    },

    ingestIntroduction(
      record: unknown,
      ctx: { currentSlot: number | bigint; expectedChainId: string },
    ): BookIntroResult {
      const currentSlot = coerce(ctx.currentSlot)
      // Self-exclusion, same rule as announcements: an introduction whose
      // SUBJECT is this node never enters the book (nor the pending map).
      if (describesSelf(record, 'subjectIdentityId')) return { ok: true }
      const verdict = validateIntroduction(record, {
        currentSlot,
        expectedChainId: ctx.expectedChainId,
      })
      if (!verdict.ok) return verdict
      const r = record as SignedIntroduction
      const slotObserved = coerce(r.slotObserved)

      const entry = entriesById.get(r.subjectIdentityId)
      if (entry !== undefined) {
        const heldNow = entry.introductions.get(r.signerIdentityId)
        if (heldNow === undefined || slotObserved > heldNow) {
          entry.introductions.set(r.signerIdentityId, slotObserved)
          capVouches(entry.introductions)
        }
        return { ok: true }
      }
      // Parked for a subject not yet known — validated NOW, merged when the
      // record arrives. Bounded: at most `maxEntries` subjects parked (the
      // one whose NEWEST vouch is oldest goes first — deterministic, and it
      // keeps the freshest waiting state), and each parked subject's vouch
      // map is capped like a live entry's.
      if (!pending.has(r.subjectIdentityId) && pending.size >= maxEntries) {
        let worstSubject: string | undefined
        let worstNewest: bigint | undefined
        for (const [subject, bySigner] of pending) {
          let newest = 0n
          for (const slot of bySigner.values()) if (slot > newest) newest = slot
          if (
            worstNewest === undefined ||
            newest < worstNewest ||
            (newest === worstNewest && subject > (worstSubject ?? ''))
          ) {
            worstSubject = subject
            worstNewest = newest
          }
        }
        if (worstSubject !== undefined) pending.delete(worstSubject)
      }
      let bySigner = pending.get(r.subjectIdentityId)
      if (bySigner === undefined) {
        bySigner = new Map()
        pending.set(r.subjectIdentityId, bySigner)
      }
      const held = bySigner.get(r.signerIdentityId)
      if (held === undefined || slotObserved > held) {
        bySigner.set(r.signerIdentityId, slotObserved)
        capVouches(bySigner)
      }
      return { ok: true }
    },

    recordDialFailure(identityId: string, currentSlot: number | bigint): void {
      const e = entriesById.get(identityId)
      if (e === undefined) return
      expireQuarantine(e, coerce(currentSlot)) // an expired window starts fresh
      e.failedDials += 1
      if (e.failedDials >= DIAL_FAILURES_TO_QUARANTINE) {
        e.quarantineUntilSlot = coerce(currentSlot) + quarantineSlots
      }
    },

    recordDialSuccess(identityId: string): void {
      const e = entriesById.get(identityId)
      if (e === undefined) return
      e.failedDials = 0
      delete e.quarantineUntilSlot
    },

    retractBlock(blockHashHex: string): number {
      const ids = byBlock.get(blockHashHex)
      if (ids === undefined) return 0
      let removed = 0
      for (const id of ids) {
        const e = entriesById.get(id)
        // Only entries whose CURRENT provenance is this block — a record
        // superseded by a fresher one from another block already detached.
        if (e !== undefined && e.blockRef?.blockHashHex === blockHashHex) {
          dropEntry(id)
          removed += 1
        }
      }
      byBlock.delete(blockHashHex)
      return removed
    },

    dialEligible(currentSlot: number | bigint): DialTarget[] {
      const slot = coerce(currentSlot)
      const out: DialTarget[] = []
      for (const e of entriesById.values()) {
        expireQuarantine(e, slot)
        if (isEligible(e, slot)) {
          out.push({
            identityId: e.identityId,
            multiaddrs: [...e.multiaddrs],
            observedExternalAddr: e.observedExternalAddr,
            sourceClass: e.sourceClass,
          })
        }
      }
      return out.sort((a, b) => (a.identityId < b.identityId ? -1 : a.identityId > b.identityId ? 1 : 0))
    },

    entries(): AddressBookEntry[] {
      return [...entriesById.values()]
        .map(snapshot)
        .sort((a, b) => (a.identityId < b.identityId ? -1 : a.identityId > b.identityId ? 1 : 0))
    },

    pruneExpired(currentSlot: number | bigint): number {
      return pruneExpiredInner(coerce(currentSlot))
    },

    size(): number {
      return entriesById.size
    },
  }

  function pruneExpiredInner(currentSlot: bigint): number {
    let removed = 0
    for (const e of [...entriesById.values()]) {
      if (e.slotEnd < currentSlot) {
        dropEntry(e.identityId)
        removed += 1
      }
    }
    return removed
  }
}
