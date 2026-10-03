#!/usr/bin/env node
/**
 * succinctcoin benchmark — run from repo root: node bench/bench.js
 * Writes bench/bench-results.json (absolute path) and prints a summary.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Big = require("big.js");

const log = (s) => console.error(`[bench] ${s}`);
// Runaway guard only: the script exits 0 explicitly at the end (see bottom),
// so this fires just if a benchmark section genuinely hangs.
const watchdog = setTimeout(() => { log("WATCHDOG: 120s exceeded, exiting 124"); process.exit(124); }, 120_000);

const N = 2_000_000;
const results = { node: process.version, platform: `${process.platform} ${process.arch}`, ts: new Date().toISOString() };

// --- sha256 throughput (node:crypto) ---
{
  const buf = crypto.randomBytes(1024 * 1024);
  const iters = 512;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) crypto.createHash("sha256").update(buf).digest();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  results.sha256 = { iters, inputKB: 1024, totalMB: iters, ms: +ms.toFixed(1), GBps: +((iters * 1e6) / 1e9 / (ms / 1000)).toFixed(3) };
  log(`sha256 done in ${ms.toFixed(0)}ms`);
}

// --- keccak256 throughput (js-sha3) if installed ---
try {
  const { keccak256 } = require("js-sha3");
  const buf = new Uint8Array(64 * 1024); // 64KB — pure-JS keccak is slow; keep the workload modest
  crypto.getRandomValues(buf);
  const iters = 2048; // 2048 * 64KB = 128MB total
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) keccak256(buf);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  results.keccak256 = { iters, inputKB: 64, totalMB: 128, ms: +ms.toFixed(1), GBps: +((128 * 1e6) / 1e9 / (ms / 1000)).toFixed(4) };
  log(`keccak256 done in ${ms.toFixed(0)}ms`);
} catch (e) {
  results.keccak256 = { error: "js-sha3 not installed: " + e.message };
}

// --- BigInt add ops/s ---
{
  let a = 0n;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) a += 123n;
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  results.bigint = { ops: N, ms: +ms.toFixed(1), addOpsPerSec: +((N * 1000) / ms).toLocaleString("en-US", { maximumFractionDigits: 0 }) };
  log(`bigint done in ${ms.toFixed(0)}ms`);
}

// --- big.js ops/s: add and multiply (smaller N — big.js allocates a new object per op) ---
{
  const NB = 500_000;
  let b = new Big(0);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < NB; i++) b = b.plus(0.123);
  const msAdd = Number(process.hrtime.bigint() - t0) / 1e6;
  let c = new Big(123.45);
  const t1 = process.hrtime.bigint();
  for (let i = 0; i < NB; i++) {
    c = c.times(1.001);
    if (c.gte(1e6)) c = c.div(1e4); // keep values money-sized (bounded digits) — the prior version grew to 3k digits and went quadratic
  }
  const msMul = Number(process.hrtime.bigint() - t1) / 1e6;
  results.bigjs = { ops: NB, addMs: +msAdd.toFixed(1), addOpsPerSec: +((NB * 1000) / msAdd).toLocaleString("en-US", { maximumFractionDigits: 0 }), mulMs: +msMul.toFixed(1), mulOpsPerSec: +((NB * 1000) / msMul).toLocaleString("en-US", { maximumFractionDigits: 0 }) };
  log(`big.js done add=${msAdd.toFixed(0)}ms mul=${msMul.toFixed(0)}ms`);
}

// --- exactness check: float vs big.js ---
results.exactness = {
  float: +(0.1 + 0.2),
  bigjs: new Big(0.1).plus(0.2).toString(),
  floatScaled: +(0.3 * 100), // classic satoshi-scaling trap
  bigjsScaled: new Big(0.3).times(100).toString(),
};

// --- serialization: 10k money values ---
{
  const n = 10_000;
  const vals = Array.from({ length: n }, () => new Big(crypto.randomInt(1, 100_000_000) / 100));
  let s = "";
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 100; i++) s = JSON.stringify(vals);
  const msStr = Number(process.hrtime.bigint() - t0) / 1e6;
  let p = 0;
  const t1 = process.hrtime.bigint();
  for (let i = 0; i < 100; i++) p = JSON.parse(s).length;
  const msParse = Number(process.hrtime.bigint() - t1) / 1e6;
  results.serialization = { values: n, bytesPerValue: +(s.length / n).toFixed(1), stringify100xMs: +msStr.toFixed(1), parse100xMs: +msParse.toFixed(1) };
}

// --- memory footprint: big.js object vs BigInt (rough, GC-noisy) ---
{
  const m0 = process.memoryUsage().rss;
  const a = Array.from({ length: 100_000 }, () => new Big(123.456));
  const m1 = process.memoryUsage().rss;
  const b = Array.from({ length: 100_000 }, () => 123456n);
  const m2 = process.memoryUsage().rss;
  void a; void b;
  results.memory = { note: "rough RSS deltas, GC-noisy, 100k values each", bigjsDeltaKB: +((m1 - m0) / 1024).toFixed(0), bigintDeltaKB: +((m2 - m1) / 1024).toFixed(0) };
}

log("writing results");
const out = path.join(__dirname, "bench-results.json");
fs.writeFileSync(out, JSON.stringify(results, null, 2));
console.log("wrote", out);
console.log(JSON.stringify(results, null, 2));
// Exit explicitly: without this the pending watchdog timer keeps the event
// loop alive and the script hangs to the 120s watchdog (exit 124).
clearTimeout(watchdog);
process.exit(0);
