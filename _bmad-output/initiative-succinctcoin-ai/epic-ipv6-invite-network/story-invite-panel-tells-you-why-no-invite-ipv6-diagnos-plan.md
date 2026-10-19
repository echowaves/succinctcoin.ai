---
id: story-invite-panel-tells-you-why-no-invite-ipv6-diagnos
status: built
epic: epic-ipv6-invite-network (post-9.5 follow-up, user-reported)
title: The invite panel explains WHY there is no invite (IPv6 diagnostics)
---

# Invite-panel IPv6 diagnostics — plan

## Origin (user report)

Running the app shows *"No invite yet — this node announces once it has a
global IPv6 address. Refresh"* forever. Diagnosis on the user's machine:
`ifconfig` shows ONLY `fe80::` link-local addresses (+ `::1`), no global
IPv6, and `route -n get -inet6 default` → "not in table" (no v6 route). The
message is TRUE — the announce path (`node-loop.ts` L336
`filterPolicyAddresses(listenAddresses())`) yields zero addresses, so no
announcement, so `getInvite()` stays `null`. Policy works as designed
(epic 9 IPv6-only; IPv4 fallback explicitly rejected in deferred-work).

**Problem:** the panel states the precondition but not the diagnosis — the
user cannot tell "my network has no IPv6" from "the app is broken".

## Scope

The panel, when there is no invite, ALSO shows what the machine actually
has, classified:

- global present → "global IPv6 detected — waiting for the next announce
  window" (invite will appear without restart; announce re-reads addresses
  every window).
- only link-local (`fe80::/10`) → "this machine has no global IPv6 — check
  router/ISP IPv6 settings".
- unique-local present but no global (`fd00::` — Tailscale-class overlays)
  → explicitly called out as NOT accepted (common confusion: VPN IPv6 is
  not global).
- nothing routable at all → "no active IPv6 interfaces".

## Explicitly NOT in scope

- No policy relaxation of any kind: `filterPolicyAddresses`,
  `assertDialable`, and the loopback dev-flag stay EXACTLY as shipped.
- No announce-side override / dev escape hatch (candidate follow-up, see
  deferred-work).
- No IPv6 default-route probe (spawning `route` from main is platform-
  specific; interface classification already distinguishes every real case
  — a global address without a route is a routing problem beyond this UI).

## Design

1. **Core gains the classifier** (policy knowledge stays single-owned,
   E7): `classifyIp6Address(text)` in
   `packages/core/src/net/address-policy.ts` REUSES the existing
   `expandHextets` (no second expander); classes by top bits (global
   2000::/3, linkLocal fe80::/10, uniqueLocal fc00::/7, loopback ::1);
   malformed/zone-bearing → 'other', never throws. Barrel-exported.
2. **NEW pure module** `packages/app/src/main/invite-diagnostics.ts`
   (AD-1: NO electron import; interfaces passed IN):
   `inviteDiagnostics(interfaces): InviteDiagnostics` — strips `%zone`,
   classifies every IPv6 entry of an `os.networkInterfaces()`-shaped table
   via the core classifier, returns `{ hasGlobal, globalCount,
   linkLocalCount, uniqueLocalCount, loopbackCount, otherCount }` (plain
   JSON — IPC-safe, counts only, key-free AD-11).
3. **IPC** (`ipc-channels.ts`, ONE owner of the shape): `IPC_READ.inviteDiag:
   'inviteDiagnostics'`. Handler in `main/index.ts`:
   `() => inviteDiagnostics(networkInterfaces())` (os read lives in the
   glue, not the pure module).
4. **Bridge**: `getInviteDiagnostics()` in `preload.ts` + `preload.d.ts`.
5. **Renderer** (`App.tsx` InvitePanel + NEW pure `renderer/ipv6-hint.ts`,
   shape mirrored structurally like `InviteRejectReason`): ONE paired
   `Promise.all` refresh of invite + diagnostics (review F2 — the hint and
   the invite always describe the same snapshot); when `invite === null`,
   render `describeIpv6(diag)` after the existing message. No timers
   (RENDERER_NO_POLL holds — fetch rides the mount/Refresh). Renderer still
   imports NO core.

## Tests (app suite)

- NEW `test/invite-diagnostics.test.ts`: classifier vectors (global 2xxx/
  3fff boundary, fe80–febf boundary, fd00/fc00, ::1 forms incl. zone id,
  malformed → other); matrix rows: global-present wins; fe80-only; fd00-
  only (Tailscale row); IPv4-only (zero v6 counts); mixed.
- `test/renderer.test.ts`: mock bridge gains `getInviteDiagnostics` (type
  completeness — every required bridge member is mocked).

## Gates

app `tsc --noEmit` + app vitest; root typecheck + full suite (bridge type
is workspace-visible); build first (dist consumers). Review: quick-lens
subagent on staged diff. Commit via tmp-commit-msg.txt convention.

## Build log

- Diagnosis (user's machine, pre-code): `ifconfig` → ONLY `fe80::` link-local
  (+ `::1`, zone-bearing); `route -n get -inet6 default` → "not in table".
  The panel message was TRUE — announce filter (`node-loop.ts`
  `filterPolicyAddresses(listenAddresses())`) yields zero. Not a bug: the
  network has no IPv6. Story = make the panel SAY that.
- Shipped: core `classifyIp6Address` (reuses `expandHextets` — plan amended,
  review F5); app pure `invite-diagnostics.ts`; IPC read `inviteDiagnostics`
  (counts-only payload); bridge `getInviteDiagnostics`; renderer pure
  `ipv6-hint.ts` + paired `Promise.all` refresh (review F2). Guards
  re-entered with comments: renderer file list, IPC_READ list, epic6
  import-set list.
- Review (quick-lens subagent): F1 M wrong "no interfaces" sentence when
  only unclassifiable addresses → added HINT_OTHER branch + row; F2 M split
  fetches → paired; F3 global-class zone row; F4 full-count toEqual;
  F5 plan/record drift; F6 comment pointer. All fixed, re-gated.
- Gates: app tsc clean; app 48/9; root typecheck clean; FULL suite 460/64
  (core 412/55 + app 48/9). Policy code untouched — zero relaxation
  anywhere (diff contains additive classifier/diagnostics only).
