const Big = require("big.js");
const t = (n, f) => { const t0 = process.hrtime.bigint(); for (let i = 0; i < n; i++) f(); return (Number(process.hrtime.bigint() - t0) / 1e6).toFixed(1); };

// 1. does big.js serialize natively to a string?
console.log("toJSON?", typeof Big.prototype.toJSON, JSON.stringify(new Big(123.45)));
console.log("BigInt JSON?", (() => { try { return JSON.stringify(123n); } catch (e) { return "THROWS: " + e.message; } })());

// 2. isolate big.js times slowness
let a = new Big(123.45);
console.log("times bounded (100k):", t(100000, () => { a = a.times(1.001); if (a.gte(1e6)) a = a.div(1e4); }), "ms");
let b = new Big(123.45);
console.log("times unbounded (100k):", t(100000, () => { b = b.times(1.001); }), "ms", "final digits:", b.c.length, "e:", b.e);
let d = new Big(1234567.89012345);
console.log("times by 0.5 (100k):", t(100000, () => { d = d.times(0.5); }), "ms");
let e = new Big(1234567.89012345);
console.log("plus 0.001 (100k):", t(100000, () => { e = e.plus(0.001); }), "ms");
let f = new Big(1);
console.log("div 1e4 (100k):", t(100000, () => { f = f.div(1e4).times(1e4); }), "ms");
console.log("big.js version:", require("big.js/package.json").version);
