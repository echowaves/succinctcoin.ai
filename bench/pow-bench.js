#!/usr/bin/env node
/**
 * succinctcoin PoW benchmark — run from repo root: node bench/pow-bench.js
 *
 * AD-6 throughput evidence for the E1 difficulty spike:
 *   1. per-attempt sha256 throughput at the CANONICAL block size (322 bytes —
 *      the exact `canonicalBlockBytes` layout: u64be(slot) ‖ parentHash(32)
 *      ‖ utf8(winnerIdentityId, 64) ‖ winnerTicket(202) ‖ u64be(nonce)
 *      ‖ u64be(txCount)); and
 *   2. time-to-find at the fixed target (POW_TARGET_LEADING_ZERO_BITS = 16,
 *      1/65536 expected attempts).
 *
 * Writes bench/pow-bench-results.json and prints a summary. Mirrors bench.js:
 * a 120s runaway watchdog, an explicit exit 0 (the pending watchdog timer
 * would otherwise keep the event loop alive).
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const log = (s) => console.error(`[pow-bench] ${s}`);
const watchdog = setTimeout(() => { log("WATCHDOG: 120s exceeded, exiting 124"); process.exit(124); }, 120_000);

const TARGET_BITS = 16; // POW_TARGET_LEADING_ZERO_BITS (fixed at launch, E1)
const results = { node: process.version, platform: `${process.platform} ${process.arch}`, ts: new Date().toISOString(), targetBits: TARGET_BITS };

// --- canonical block bytes (322 B) — the per-attempt hash input ---
// Same deterministic field values as packages/core/test/consensus-pow.test.ts
// (the golden vector's fixed block); only the u64be counter field changes per
// attempt. Kept here as raw constants (no core dependency). The ticket is
// built from its deterministic PROTO PARTS (not a long hex literal) so the
// canonical size stays exactly the test's 322B — a hand-typed ticket hex is
// easy to get wrong.
const IDENTITY_ID = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
// Golden Ticket field values: identityId (32B hex), windowIndex=7,
// challenge=0x00..0x1f (32B), nonceCommitment=0x5a×32, signature=0x7e×64.
const TICKET = Buffer.concat([
  Buffer.from("0a40", "hex"), Buffer.from(IDENTITY_ID, "utf8"), // field 1
  Buffer.from("1007", "hex"), // field 2: windowIndex = 7
  Buffer.from("1a20", "hex"), Buffer.from(Array.from({ length: 32 }, (_, i) => i)), // field 3: challenge
  Buffer.from("2220", "hex"), Buffer.alloc(32, 0x5a), // field 4: nonceCommitment
  Buffer.from("2a40", "hex"), Buffer.alloc(64, 0x7e), // field 5: signature
]); // 202 bytes

function u64be(v) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(v), 0);
  return b;
}
const SLOT = u64be(42);
const PARENT = Buffer.from("0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20", "hex"); // 32B
const ID = Buffer.from(IDENTITY_ID, "utf8");
const TXCOUNT = u64be(3);
// Everything except the counter, in proto field order: 8+32+64+202 = 306 B.
const PREFIX = Buffer.concat([SLOT, PARENT, ID, TICKET]);
const SUFFIX = TXCOUNT;
const CANONICAL_LEN = PREFIX.length + 8 + SUFFIX.length; // 322
results.canonicalBytes = CANONICAL_LEN;

function canonicalBytes(counter) {
  return Buffer.concat([PREFIX, u64be(counter), SUFFIX]);
}
function leadingZeroBits(digest) {
  let bits = 0;
  for (let i = 0; i < digest.length; i++) {
    const byte = digest[i];
    if (byte === 0) { bits += 8; continue; }
    for (let b = 7; b >= 0; b--) {
      if (byte & (1 << b)) return bits;
      bits++;
    }
  }
  return bits;
}
function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest();
}

// --- per-attempt throughput at the canonical size ---
// The per-attempt path rebuilds the canonical bytes (counter field) and hashes
// once — the same work `powCheck` does per counter value (AD-6).
{
  const iters = 200_000;
  let acc = 0;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) {
    const d = sha256(canonicalBytes(i));
    acc += d.readUInt32BE(0); // keep the digest alive (no dead-code elision)
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const hps = iters / (ms / 1000);
  results.throughput = {
    iters,
    inputBytes: CANONICAL_LEN,
    ms: +ms.toFixed(1),
    hashesPerSec: Math.round(hps),
    hashesPerSecHuman: `${(hps / 1e6).toFixed(2)}M`,
    acc,
  };
  log(`throughput: ${iters} hashes of ${CANONICAL_LEN}B in ${ms.toFixed(0)}ms => ${results.throughput.hashesPerSecHuman} hashes/s`);
}

// --- time-to-find at the fixed target (N=16 leading zero bits) ---
{
  // The block is FIXED, so a from-scratch mine is deterministic (always the
  // same nonce). Instead we scan once and record the wall-clock of THREE
  // consecutive gaps between passing nonces — independent geometric samples
  // (each ~2^N attempts on average) — without re-doing the same search.
  const runs = [];
  let counter = 0n;
  for (let run = 0; run < 3; run++) {
    const t0 = process.hrtime.bigint();
    let attempts = 0;
    let found = -1n;
    while (found < 0n) {
      const d = sha256(canonicalBytes(Number(counter)));
      attempts++;
      if (leadingZeroBits(d) >= TARGET_BITS) found = counter;
      counter++;
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    runs.push({ attempts, counter: found.toString(), ms: +ms.toFixed(2) });
  }
  const best = runs.reduce((a, b) => (b.ms < a.ms ? b : a));
  results.timeToFind = {
    targetBits: TARGET_BITS,
    expectedAttempts: 2 ** TARGET_BITS,
    runs,
    bestMs: best.ms,
    note: "single sha256 per counter value at the canonical block size",
  };
  log(`time-to-find (≥${TARGET_BITS} leading zero bits): best ${best.ms}ms over ${best.attempts} attempts (expected ~${2 ** TARGET_BITS})`);
}

// --- sanity: the target is trivially reachable (≥1 hash/slot) ---
results.targetTriviallyReachable = results.timeToFind.bestMs < 1000;
if (!results.targetTriviallyReachable) {
  log("WARNING: time-to-find ≥ 1s on this hardware — the target is NOT trivially reachable here");
}

log("writing results");
const out = path.join(__dirname, "pow-bench-results.json");
fs.writeFileSync(out, JSON.stringify(results, null, 2));
console.log("wrote", out);
console.log(JSON.stringify(results, null, 2));
clearTimeout(watchdog);
process.exit(0);
