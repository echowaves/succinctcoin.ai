# Deferred Work — initiative-succinctcoin-ai

- source_plan: `_bmad-output/initiative-succinctcoin-ai/epic-platform-baseline/story-workspace-headless-test-harness-plan.md`
  summary: `bench/bench.js` hangs to its 120s watchdog and exits 124 after writing results — pre-existing (present in baseline `3bf6016`), not caused by the workspace conversion.
  evidence: `node bench/bench.js` runs the sha256/keccak256/big.js/BigInt sections, writes fresh `bench/bench-results.json`, prints results, then hits the baseline watchdog `setTimeout(() => { … process.exit(124); }, 120_000)` (bench.js line 12). The script has no early `process.exit()`. Fix is trivial (add `process.exit(0)` after the results write) but the plan's frozen boundary says "bench/ untouched; must still work after the conversion" — it still works; the hang predates this change. Suggested home: a one-line fix in the next story that touches bench/, or a dedicated cleanup ticket.
