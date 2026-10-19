---
id: story-peer-reliability-scoring-local-selection-only-never-trust-plan
ticket: epic-ipv6-invite-network #4 (story)
status: built
covers: [R4, E1, E2]
---

# 9.4 — Reliability scoring: local, selection-only, never trust

## Shape

A pure reliability score per known peer — LOCAL signal only, used ONLY to
order things (who to crawl first, whom to serve, whom to evict last). It
NEVER gates a connection or a validation: eligibility stays exactly 8.4's
trust-class rules. A zero-score block-grade record is dialable; a max-score
hint never becomes dialable. That invariant is the ticket — it gets the
loudest property rows in the suite.

## Module — `discovery/peer-score.ts` (pure)

```
PeerHistory  { dialEwma?: number        // absent = no dial yet
               latencyEwmaMs?: number   // absent = no sample yet
               seenSlots: readonly bigint[]      // distinct recent slots with a valid record
               sourcedValid: number     // records sourced FROM this peer that verified
               sourcedTotal: number
               corroborations: number } // independent vouches (introductions) + block provenance
scorePeer(h: PeerHistory): number in [0,1]
ewmaUpdate(prev: number | undefined, sample: number, alpha = SCORE_EWMA_ALPHA): number
```

Signals → sub-scores in [0,1], weights sum to 1 (ALL named constants):

- `SCORE_EWMA_ALPHA = 0.3` — dial success EWMA; no samples yet ⇒ optimistic
  start 1 (a peer has not failed yet); failure sample 0, success sample 1.
- `STABILITY_WINDOW_SLOTS = 24` — sub = distinct seen slots / window (capped 1).
- `VALIDITY_NEUTRAL = 0.5` — sourced-data validity = valid/total; total 0 ⇒
  neutral (no evidence either way).
- `CORROBORATION_CAP = 4` — corroborations/cap (capped 1).
- `LATENCY_CAP_MS = 5000` — sub = 1 − min(EWMA, cap)/cap; no sample ⇒ 1
  (optimistic, consistent with dial EWMA start).

Weights: `WEIGHT_DIAL = 0.35`, `WEIGHT_VALIDITY = 0.25`,
`WEIGHT_STABILITY = 0.20`, `WEIGHT_LATENCY = 0.10`, `WEIGHT_CORROBORATION = 0.10`.
Score is a positive weighted sum ⇒ monotone in every signal (property).

## History lives on the book (mutable, local)

- Entry gains `history` (dialEwma, latencyEwmaMs, seenSlots ring of 24,
  sourcedValid/Total); exposed read-only on `AddressBookEntry`.
- `recordDialSuccess(identityId, latencyMs?)` / `recordDialFailure(id, slot)`
  update the EWMAs (latency optional — callers that measure pass it).
- NEW `recordSourcedData(identityId, valid: number, total: number): void` —
  the narrow sink; fed by the crawler per response (records accepted vs
  delivered). Gossip/sync can feed the same sink later; nothing else does.
- Ingest (install AND update paths) stamps `seenSlots` with currentSlot
  (deduped, oldest-evicted beyond the window).
- NEW `score(identityId): number` on the book (fresh-history score for
  unknown ids); corroboration input = introductions.size ONLY (as built —
  a blockRef bonus would silently re-rank trust classes inside one score).

## Selection consumers switch to score ORDER (never gates)

1. Crawler dequeue: highest score first among queued (stable — ties keep
   FIFO, so existing mesh rows are untouched).
2. `servePeerBook` ordering: score desc, tie → slotEnd desc, id asc (empty
   histories ⇒ identical to 9.3 order; existing rows stay green). This IS
   the re-share top-K: what we serve is what we re-share.
3. At-cap eviction victim: lowest first under the comparator
   (classRank ASC → score ASC → legacy worse() order) — trust class stays a
   HARD tier (reliability never rescues a hint over an invite); the /64
   floor composes exactly as 9.3 pinned it.

## THE invariant wiring check

`dialEligible`, `validateIntroduction`, `verifyPeerAnnouncement`, the crawl
follow gate, and the ladder dial loop must not read score. Property rows:
identical eligibility sets with all-zero vs all-max histories (non-vacuity:
assert a zero-score block entry IS eligible and a max-score hint is NOT);
grep-style source row pinning `score` does not appear in those files'
eligibility paths (house pattern for structural pins).

## Tests

- `peer-score.test.ts` — hand-computed EWMA/stability vectors; monotonicity
  fast-check (bump one signal ⇒ score non-decreasing, all signals); range
  [0,1]; neutral/optimistic defaults pinned; weights sum to exactly 1.
- `discovery-address-book.test.ts` (+rows) — history updates on events;
  eviction = lowest score WITHIN class tier (new row: two log-grade entries,
  the flakier evicts despite fresher slotEnd); seenSlots window; floor rows
  still green; ELIGIBILITY-INVARIANT property rows above.
- `peerbook-serve.test.ts` (+1) — served order follows score when histories
  differ (flaky-dial peer sinks below reliable one).
- `discovery-crawler.test.ts` (+1) — queue drains highest-score first
  (two queued peers, boosted history on the later-enqueued one dials first).
- core-ladder: no change expected (crawl report shape untouched; latencyMs
  optional).

## Gates

build → typecheck → root suite (`--maxWorkers=3` under machine load) → app.
Quick-lens review; commit.

## Build log

- Delivered: `discovery/peer-score.ts` (pure; α 0.3, weights 0.35/0.25/
  0.20/0.10/0.10 = 1, caps 24 slots / 4 vouches / 5000 ms, optimistic dial
  & latency starts, neutral validity); history on book entries (mutable,
  survives record rotation); `recordDialSuccess(id, latencyMs?)`,
  `recordSourcedData(id, valid, total)` (ingest VERDICTS — stale-but-valid
  counts as valid evidence), `score(id)`; ingest/update stamp `seenSlots`
  (window 24); challenger stamped before any seat contest.
- Consumers: crawler dequeue = highest score, TIES keep FIFO (existing mesh
  rows byte-unchanged); serve order score desc → slotEnd desc → id (empty
  histories reproduce the 9.3 freshness order exactly — pinned in the same
  row); eviction victim `worseReliability` = class tier HARD first, then
  score, then legacy (slotEnd, firstSeen, id); /64 floor composition
  untouched (floor rows green).
- Latency hook resolved: `CrawlDeps.now` (optional monotonic clock) times
  each crawl dial; core wiring passes `performance.now()` — discovery-only,
  AD-3 unaffected. Re-share top-K = servePeerBook limit truncation.
- Tests: NEW `peer-score.test.ts` (6 rows: EWMA vectors, hand-computed full
  score, defaults, weights-sum, fast-check RANGE + MONOTONE over all five
  signals, 400 runs each); address-book +4 rows (within-class score
  eviction vs fresher slotEnd, CLASS_TIER_IS_HARD, ELIGIBILITY_INVARIANT
  with numeric non-vacuity ≈0.11→≈0.54 swing at identical eligibility set,
  HISTORY_ROWS window/sink/latency-EWMA/corroboration); serve +1 SCORE_ORDER
  (equal histories keep 9.3 order; evidence flips it); crawler +2 (boosted
  seed dials first; ties FIFO). Root 444/61, core 407/54, app 37/7 + tsc.
- Review (quick lenses): F1 validity-sink wording — code already counted
  ingest verdicts; doc pinned that reading. F2 numeric non-vacuity asserts
  added to ELIGIBILITY_INVARIANT (caught a real misestimate: dial EWMA from
  zero needs 6 successes to reach ≈0.88, asserted as such). F3 challenger
  stamp "dead code" — REJECTED: the stub's stamped history IS the score
  reference in the seat contest (removing it loses legitimate contests).
- Env note: full suites run with `--maxWorkers=2..3` under host CPU load;
  no failures attributable to story code.
