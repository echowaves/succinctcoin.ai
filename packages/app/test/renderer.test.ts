/**
 * Story 6.3 matrix — the React renderer's HEADLESS-SAFE checks (no
 * electron import, no DOM — the `ui-state` module is PURE and the static
 * checks read the renderer SOURCE FILES as text):
 *
 *   RENDERER_UI_STATE_SNAPSHOT (AC1) the PURE `ui-state` module driven with
 *                                  a MOCK bridge (the DI seam): the
 *                                  one-time snapshot (`getChainHead`/
 *                                  `getBalances`/`getPeers`) builds the
 *                                  correct `UiState`.
 *   RENDERER_UI_STATE_REDUCE   (AC1) the event reducer: a `BlockApplied`
 *                                  (delivered through the mock's captured
 *                                  `on` callback) advances the head (the
 *                                  event's slot / hash / winner / counts,
 *                                  the snapshot's `totalSupplyDisplay`
 *                                  preserved); `CoreStarted`/`CoreStopped`
 *                                  flip the running flag. Event-driven —
 *                                  the module has NO timers (E1).
 *   RENDERER_NO_POLL           (AC2) the static check: NO `setInterval` /
 *                                  `setTimeout` in the renderer source —
 *                                  the data flows from the event stream +
 *                                  the one-time snapshot (E1).
 *   RENDERER_THIN_CLIENT       (AC3) the static check: NO
 *                                  `@succinctcoin/core` import in the
 *                                  renderer source — the renderer touches
 *                                  ONLY the bridge's typed surface (AD-1).
 *   RENDERER_AD11_NO_KEYS      (AC4) the static check: NO key material in
 *                                  the renderer source — only peer IDs,
 *                                  status, and signed artifacts (AD-11).
 *
 * The React components (`App.tsx`/`main.tsx`/the hook) are verified by the
 * app typecheck + the Vite build NOW, and by the 6.4 packaged e2e (the
 * 6.2 approach: the headless logic test + the typecheck/build now; the
 * actual launch in 6.4).
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { buildInitialSnapshot, initialUiState, reduce } from '../src/renderer/ui-state.js'
import type { BalanceState, ChainHead, Peer, UiState } from '../src/renderer/ui-state.js'

const here = dirname(fileURLToPath(import.meta.url))
/** The renderer source directory (the static checks scan its `.ts`/`.tsx`). */
const RENDERER_DIR = join(here, '..', 'src', 'renderer')

// ---------------------------------------------------------------------------
// pinned values (deterministic — the mock bridge + the expected states)
// ---------------------------------------------------------------------------

const SNAPSHOT_HEAD: ChainHead = {
  slot: 42,
  hash: 'aa'.repeat(32),
  winnerIdentityId: 'bb'.repeat(32),
  ticketCount: 3,
  txCount: 1,
  totalSupplyDisplay: '21000000',
}

const SNAPSHOT_BALANCES: BalanceState = {
  balances: {
    [SNAPSHOT_HEAD.winnerIdentityId]: '12345678901234567890',
  },
}

const SNAPSHOT_PEERS: Peer[] = [
  { peerId: 'cc'.repeat(32), multiaddrs: ['/memory/succinctcoin-app'] },
]

/** The `BlockApplied` event the mock delivers after the snapshot. */
const BLOCK_APPLIED = {
  slot: 43,
  hash: 'dd'.repeat(32),
  winnerIdentityId: 'ee'.repeat(32),
  ticketCount: 5,
  txCount: 2,
}

/** The expected head after the `BlockApplied` reduce (the supply is
 *  preserved from the snapshot — the event carries none). */
const EXPECTED_HEAD: ChainHead = {
  ...SNAPSHOT_HEAD,
  ...BLOCK_APPLIED,
}

// ---------------------------------------------------------------------------
// the mock bridge (the DI seam — the runtime provides `window.succinctcoin`)
// ---------------------------------------------------------------------------

/**
 * A mock bridge (the `ui-state` module's injected dependency): the read-API
 * returns the pinned snapshot values; `on` captures the callbacks so the
 * test can deliver events through them (like the real event stream). The
 * commands throw — the 6.3 view never calls one (AD-9 read-only).
 */
function makeBridge(): {
  bridge: Window['succinctcoin']
  deliver: (event: 'CoreStarted' | 'BlockApplied' | 'CoreStopped', payload: unknown) => void
} {
  const listeners = new Map<string, (payload: unknown) => void>()
  const unused = (): never => {
    throw new Error('the 6.3 view never calls a command (AD-9 read-only)')
  }
  const bridge: Window['succinctcoin'] = {
    start: unused,
    stop: unused,
    startMining: unused,
    getChainHead: async () => SNAPSHOT_HEAD,
    getBalances: async () => SNAPSHOT_BALANCES,
    getPeers: async () => SNAPSHOT_PEERS,
    getBlock: async () => {
      throw new Error('the 6.3 view never reads a block (the panels use the head + the peers)')
    },
    // 9.2: the invitation panel READS its invite on mount; null renders the
    // "no invite yet" state. Joining stays unexercised here (a command).
    getInvite: async () => null,
    // Post-9.5: the panel also reads the why-no-invite diagnostics.
    getInviteDiagnostics: async () => ({
      hasGlobal: false,
      globalCount: 0,
      linkLocalCount: 1,
      uniqueLocalCount: 0,
      loopbackCount: 1,
      otherCount: 0,
    }),
    // Invite-share UX: the LAN dial read ([] — this mock is not in LAN mode).
    getLanDial: async () => [],
    applyInvite: unused,
    on: (event, cb) => {
      listeners.set(event, cb as (payload: unknown) => void)
      return () => {
        listeners.delete(event)
      }
    },
  }
  return {
    bridge,
    deliver: (event, payload) => {
      const cb = listeners.get(event)
      if (cb === undefined) throw new Error(`no listener for ${event} (the hook subscribes first)`)
      cb(payload)
    },
  }
}

// ---------------------------------------------------------------------------
// the static checks (the renderer SOURCE FILES as text)
// ---------------------------------------------------------------------------

/** The renderer source files (the `.ts`/`.tsx` under `src/renderer/`). */
function rendererSources(): Record<string, string> {
  const sources: Record<string, string> = {}
  for (const name of readdirSync(RENDERER_DIR)) {
    if (name.endsWith('.ts') || name.endsWith('.tsx')) {
      sources[name] = readFileSync(join(RENDERER_DIR, name), 'utf8')
    }
  }
  return sources
}

/** Strip comments (the 6.2-style self-scan — comments may name a rule; code may not). */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

describe('6.3 — the React renderer (headless-safe)', () => {
  it('RENDERER_UI_STATE_SNAPSHOT: the mock-bridge snapshot builds the correct UiState (AC1)', async () => {
    const { bridge } = makeBridge()

    // The initial (pre-snapshot) state.
    expect(initialUiState()).toEqual({ head: null, balances: null, peers: [], mining: false, error: null })

    // The one-time read-API snapshot (AD-9).
    const snap = await buildInitialSnapshot(bridge)
    expect(snap.head).toEqual(SNAPSHOT_HEAD)
    expect(snap.balances).toEqual(SNAPSHOT_BALANCES)
    expect(snap.peers).toEqual(SNAPSHOT_PEERS)
    expect(snap.mining).toBe(false) // the events own the flag
  })

  it('RENDERER_UI_STATE_REDUCE: BlockApplied advances the head; CoreStarted/CoreStopped flip the flag (AC1, E1)', async () => {
    const { bridge, deliver } = makeBridge()
    let state: UiState = await buildInitialSnapshot(bridge)

    // Subscribe like the hook does (the event stream FIRST).
    const unsubs = [
      bridge.on('BlockApplied', (payload) => {
        state = reduce(state, { type: 'BlockApplied', payload })
      }),
      bridge.on('CoreStarted', (payload) => {
        state = reduce(state, { type: 'CoreStarted', payload })
      }),
      bridge.on('CoreStopped', (payload) => {
        state = reduce(state, { type: 'CoreStopped', payload })
      }),
    ]

    // Deliver the events through the captured callbacks (the mock stream).
    deliver('CoreStarted', { slot: 42 })
    expect(state.mining).toBe(true)

    deliver('BlockApplied', BLOCK_APPLIED)
    // The head advanced: the event's slot / hash / winner / ticket count /
    // tx count; the snapshot's totalSupplyDisplay preserved.
    expect(state.head).toEqual(EXPECTED_HEAD)
    expect(state.head?.totalSupplyDisplay).toBe(SNAPSHOT_HEAD.totalSupplyDisplay)
    // The snapshot fields the event does not carry are untouched.
    expect(state.balances).toEqual(SNAPSHOT_BALANCES)
    expect(state.peers).toEqual(SNAPSHOT_PEERS)

    deliver('CoreStopped', { slot: 43 })
    expect(state.mining).toBe(false)
    expect(state.head).toEqual(EXPECTED_HEAD) // the stop does not clear the head

    // F1: a `BlockApplied` after a halt sets `mining` true (a block was just
    // applied → the core is running — recovers the flag if the `CoreStarted`
    // event was missed before the renderer subscribed).
    deliver('BlockApplied', {
      slot: 44,
      hash: 'ff'.repeat(32),
      winnerIdentityId: 'ee'.repeat(32),
      ticketCount: 7,
      txCount: 3,
    })
    expect(state.mining).toBe(true)

    for (const unsubscribe of unsubs) unsubscribe()
  })

  it('RENDERER_NO_POLL: no setInterval/setTimeout in the renderer source (E1, AC2)', () => {
    const sources = rendererSources()
    // The four renderer modules are all present + scanned (the file set is
    // pinned — a new renderer module must re-enter this guard).
    expect(Object.keys(sources).sort()).toEqual([
      'App.tsx',
      'ipv6-hint.ts', // post-9.5: pure hint module (no timers, no core import)
      'main.tsx',
      'ui-state.ts',
      'useSuccinctcoin.ts',
    ])
    for (const [name, src] of Object.entries(sources)) {
      const code = stripComments(src)
      expect(code, `setInterval in ${name}`).not.toMatch(/setInterval/)
      expect(code, `setTimeout in ${name}`).not.toMatch(/setTimeout/)
    }
  })

  it('RENDERER_THIN_CLIENT: no @succinctcoin/core import in the renderer source (AD-1, AC3)', () => {
    const sources = rendererSources()
    for (const [name, src] of Object.entries(sources)) {
      const code = stripComments(src)
      expect(code, `core import in ${name}`).not.toMatch(/@succinctcoin\/core/)
      expect(code, `core import in ${name}`).not.toMatch(/from\s+['"]@succinctcoin\/core/)
    }
  })

  it('11.3 — the no-invite copy names BOTH paths (global IPv6 or a held relay hop)', () => {
    // The post-11.2 truth: global IPv6 is no longer the only way in, and
    // the panel copy must not imply otherwise (AD-1: still no core import —
    // RENDERER_THIN_CLIENT above keeps that guard).
    const app = rendererSources()['App.tsx'] as string
    expect(app).toMatch(
      /global IPv6 address or holds a circuit\s*\n?\s*through a relay hop/,
    )
  })

  it('invite-share UX: event-driven invite + copy-on-click + LAN block (plan-invite-share-ux)', () => {
    // The frozen I/O matrix rows this static row pins (the runtime halves
    // live in `core-ladder.test.ts` — the push, and the null-push on stop):
    //  - the invite ARRIVES by event, so it appears without a Refresh click
    //    (RENDERER_NO_POLL above keeps this push-based — no polling timer);
    //  - the handler passes the payload THROUGH (`setInvite(payload.invite)`),
    //    so the stop-time `null` clears the panel back to the no-invite copy;
    //  - Copy issues a real clipboard CALL with the invite text (pinned as
    //    the call, not OS state — Electron tests cannot read the clipboard);
    //  - the null-at-mount path still pairs invite + diagnostics (review F2);
    //  - LAN mode shows the honest display-only block ("not an invite",
    //    CAP-9), fed by the `getLanDial` read (mode check owned by main).
    const app = rendererSources()['App.tsx'] as string
    expect(app).toMatch(/on\('SelfInviteUpdated'/)
    expect(app).toMatch(/setInvite\(payload\.invite\)/)
    expect(app).toMatch(/navigator\.clipboard\b[\s\S]{0,40}writeText/)
    // Copy is click-wired with the invite text and its own success line…
    expect(app).toMatch(/copy\(\s*invite,\s*'Invite copied/)
    // …and the LAN read re-runs on CoreStarted (boot loads the renderer
    // before host.start — the mount-only read would race the adapter).
    expect(app).toMatch(/on\('CoreStarted', readLan\)/)
    // The LAN block is the boot line's either/or: an invite always wins.
    expect(app).toMatch(/invite === null && lanAddrs\.length > 0/)
    expect(app).toMatch(/getInviteDiagnostics/)
    expect(app).toMatch(/not an invite/)
  })

  it('RENDERER_AD11_NO_KEYS: no key material in the renderer source (AD-11, AC4)', () => {
    const sources = rendererSources()
    const KEY_MATERIAL_RE = /keypair|\.secret\b|deriveIdentityKeypair|privateKey|secretKey/i
    for (const [name, src] of Object.entries(sources)) {
      const code = stripComments(src)
      expect(code, `key material in ${name}`).not.toMatch(KEY_MATERIAL_RE)
    }
  })
})
