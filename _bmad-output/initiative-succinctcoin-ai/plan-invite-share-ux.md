---
title: 'Invite-share UX: shareable invite appears on its own, with copy'
type: 'feature'
ticket: ''
created: '2026-10-22'
status: 'built'
baseline_revision: 83d5e03c60ad23d18f0486f7564e227c793f2626
route: 'full'
route_source: 'pinned'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context:
  - packages/app/src/renderer/App.tsx
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The node mints its self-invitation as soon as it has a dialable address and is mining (one announce window after boot), but the Invitations panel fetches once and then only on manual Refresh — so users stare at "No invite yet" while a shareable invite already exists, and the raw `[boot] dial me:` console line competes with it. There is also no copy affordance, and in LAN mode the real local address lives only in the console.

**Approach:** Push, don't poll: core emits a `SelfInviteUpdated` event when the self-invite is minted/refreshed; the panel subscribes and shows it live with a Copy button and two-step guidance. When no invite exists but LAN mode has real local addresses, the panel shows those too, honestly labeled "local testnet — not an invite", also copyable.

## Boundaries & Constraints

**Always:** Renderer stays event-driven (RENDERER_NO_POLL pins no timers); renderer stays thin (AD-1: bridge surface only) and key-free (AD-11: invites are public signed text). Invite minting, liveness, and the address laws stay exactly as built (9.2/9.5/11.x) — this change never touches what makes an invite valid, only when the UI shows it and how it is shared. LAN addresses remain never-invitable (CAP-9 law).

**Never:** No QR codes, no new dependencies, no clipboard writes outside a user click, no changes to core policy/announce logic or boot lines, no polling timers anywhere.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Invite minted after panel open | announce window fires SelfInviteUpdated | panel swaps "No invite yet" for the invite + Copy, no refresh click | — |
| Copy clicked | invite visible | clipboard gets the exact `scinvite:v1:…` text; button says "Copied" briefly* | clipboard failure → status line, never throws |
| Invite null at mount | node still booting | unchanged honest "No invite yet" + IPv6 diagnostics | — |
| LAN mode, no invite | SUCCINCTCOIN_LAN=1, local addrs exist | "Local testnet address (not an invite)" block, copyable | empty list → block absent |
| Node stopped | SelfInvite null | panel falls back to the no-invite message | — |

*clipboard has no reliable read-back in Electron tests — pin the call, not the OS clipboard.

</frozen-after-approval>

## Code Map

- `packages/core/src/events/types.ts` — `CoreEvents` (L77): add `SelfInviteUpdated: { invite: string | null }`; docblock line beside it.
- `packages/core/src/index.ts` — L342 (`latestSelfInvite = encodeInvite(record)`): emit `SelfInviteUpdated` with the new text; on stop (L290, resets to null) emit with `null`. Emitter already typed-generic — no other core change.
- `packages/app/src/main/ipc-channels.ts` — `IPC_EVENTS` map is keyed off `CoreEventName`; add channel entry only if the map is explicit (check: it is a Record over names).
- `packages/app/src/main/core-host.ts` — L128 forwards every core event generically; verify no per-event list needs adding.
- `packages/app/src/preload.ts` / `preload.d.ts` — `on()` is generic over `CoreEvents`; likely zero-change, verify types flow.
- `packages/app/src/renderer/App.tsx` — `InvitePanel`: subscribe via `window.succinctcoin.on('SelfInviteUpdated', …)` in the existing effect (return unsubscribe); add Copy button (`navigator.clipboard.writeText`, click-only) with copied/failed status; two-step guidance copy ("1. Send this exact text… 2. Your friend pastes it below and presses Join"); LAN block per below.
- `packages/app/src/main/index.ts` — register `IPC_READ.lanDial`: LAN env ⇒ `net.listenAddresses().filter(a => a.startsWith('/ip4/') && !lanModeDropsAddress(a))`, else `[]`; `preload.ts`/`preload.d.ts` +`getLanDial()`.
- `packages/app/test/renderer.test.ts` — static rows (pattern L257): InvitePanel subscribes to `SelfInviteUpdated`; contains copy affordance; still no timers (existing RENDERER_NO_POLL must stay green).
- Root core test beside existing invite/announce rows — emit row: announce pass ⇒ `SelfInviteUpdated` payload equals `getInvite()`; stop ⇒ null.

Do NOT touch: address-policy, adapter, node-loop announce logic, run-node boot lines, invitation verification.

## Tasks & Acceptance

**Execution:**
- [ ] `packages/core/src/events/types.ts` + `packages/core/src/index.ts` — add + emit `SelfInviteUpdated` (mint & clear points) — event is the single trigger.
- [ ] `packages/app/src/main/ipc-channels.ts` + `index.ts` (+ core-host/preload check) — lanDial read; verify generic forwarding.
- [ ] `packages/app/src/preload.ts` + `preload.d.ts` — expose `getLanDial`.
- [ ] `packages/app/src/renderer/App.tsx` — subscribe, Copy buttons (invite + LAN block), guidance copy.
- [ ] Tests: core emit row; app static rows in `renderer.test.ts`; keep suites green.

**Acceptance Criteria:**
- Given the panel open with node booting and a dialable address, when the first announce window fires, then the invite appears without clicking Refresh.
- Given an invite shown, when Copy is clicked, then `clipboard.writeText` receives exactly the invite text.
- Given LAN mode with local addresses and no invite, when the panel renders, then a copy-labeled local-testnet block appears with "not an invite" wording; given not LAN mode, it is absent.
- Given any state, renderer source contains no timers and no core imports (pinned rows green).

## Matrix Test Audit notes

No real-clipboard CI (Electron): pin the writeText call via injected bridge in static/source form as existing rows do; live check = field run. Disclosed, not faked.

## Implementation Notes

- Shipped as planned, with four review-driven refinements (see triage log):
  the push is DEDUPED core-side (the loop re-mints every window with fresh
  signatures; the push keys on identity + addresses, so the panel gets one
  event per real change — not ~60/s); the LAN read re-runs on `CoreStarted`
  (boot loads the renderer before `host.start`, so a mount-only read races
  the adapter); the LAN block is the boot line's either/or (`invite === null
  &&` — an invite always wins); `copy()` guards the synchronous clipboard
  access itself, and each call carries its own success line.
- "Copied briefly" (matrix) vs RENDERER_NO_POLL: resolved as PERMANENT status
  — no timer may clear it; the footnote already pins the clipboard CALL, not
  OS state. Documented here per the review's note that the conflict needed a
  recorded resolution.
- Gates at commit: root build + typecheck green; root vitest 558/70 (new core
  row incl. dedupe pin); app tsc green; app vitest 77/10 (new static row).

## Review Triage Log

| # | Finding (Quick lens) | Verdict | Disposition |
|---|--------------------|---------|-------------|
| 1 | `getLanDial` mount-only read races node start (boot loads renderer before `host.start`; `listenAddresses()` throws pre-start → []) — LAN block may never appear on cold boot | medium | patched: `useEffect(() => window.succinctcoin.on('CoreStarted', readLan), [])` re-reads when the adapter is provably listening (event-driven, no timer); mount read kept for late-mount |
| 2 | Emit sits in `onSelfAnnouncement`, which fires EVERY announce window with fresh slot/signature → ~60 IPC pushes/s rewriting the textarea (main guards its own observer for exactly this) | medium | patched: core-side dedupe — push only when `identityId + multiaddrs + observedExternalAddr` changes; `lastInvitePushKey` re-armed on stop. Pinned: core-ladder row asserts exactly ONE non-null push across windows |
| 3 | LAN block renders even when an invite exists — intent conditions it on "when no invite exists"; boot line is either/or | low | patched: gate is `invite === null && lanAddrs.length > 0` (dual-stack LAN host never sees mixed messages) |
| 4 | `copy()` throws synchronously if `navigator.clipboard` is undefined — matrix says "never throws" | low | patched: try/catch wraps the access; every path lands in the status line |
| 5a | Frozen row said "Copied briefly"; implementation shows it permanently | low (rejected) | fix would be editing this build's plan / adding a timer RENDERER_NO_POLL forbids; permanent status is the only compliant reading, recorded in Implementation Notes |
| 5b | LAN copy reused the invite-only success line ("send it as one whole message") contradicting the block's bootstrap.txt guidance | low | patched: per-call `done` line — LAN copy says "your friend pastes it into their bootstrap.txt" |
| 6 | Emit placed AFTER `ports.discovery?.onSelfInvite?.` in the shared try — a throwing host observer swallows that window's push | low | patched: emit runs BEFORE the observer; the dedupe key is set only after a successful emit, so a failed emit retries next window |

## Plan Change Log
