/**
 * Auto-relay policy rows (zero-config reachability story). PURE module, so the
 * rows are pure too: matrices over mode × reachability, and determinism rules
 * for candidate selection. The adapter's application of these answers is a
 * separate set of rows (memory transport, injected reachability source).
 */
import { describe, expect, it } from 'vitest'

import {
  autoHoldWanted,
  autoServeEnabled,
  MAX_AUTO_RELAYS,
  pickRelayCandidates,
} from '../src/net/auto-relay.js'

describe('auto-relay — serve policy', () => {
  it('SERVE matrix: auto serves reachable/unknown, never proven-unreachable', () => {
    expect(autoServeEnabled('auto', 'reachable')).toBe(true)
    expect(autoServeEnabled('auto', 'unknown')).toBe(true)
    // A node whose inbound is proven dead cannot serve a hop — advertising one
    // would send peers to a relay that never answers.
    expect(autoServeEnabled('auto', 'unreachable')).toBe(false)
  })

  it('EXPLICIT-ONLY mode serves nothing automatically (kill switch)', () => {
    for (const reach of ['reachable', 'unknown', 'unreachable'] as const) {
      expect(autoServeEnabled('explicit-only', reach)).toBe(false)
    }
  })
})

describe('auto-relay — hold policy', () => {
  it('HOLD matrix: hold ONLY where direct addressing is proven dead', () => {
    // The ladder rule: rung 3 starts where rung 1 leaves off. Unknown still
    // announces direct (no capacity burned on an evidence-free guess).
    expect(autoHoldWanted('auto', 'unreachable')).toBe(true)
    expect(autoHoldWanted('auto', 'unknown')).toBe(false)
    expect(autoHoldWanted('auto', 'reachable')).toBe(false)
  })

  it('EXPLICIT-ONLY mode holds nothing automatically (kill switch)', () => {
    for (const reach of ['unreachable', 'unknown', 'reachable'] as const) {
      expect(autoHoldWanted('explicit-only', reach)).toBe(false)
    }
  })

  it('serve and hold are not simultaneously driven by the same evidence', () => {
    // Sanity on the pair: exactly one of the two is true for a KNOWN state,
    // so a node never both advertises a hop and depends on someone else's.
    expect(autoServeEnabled('auto', 'reachable')).toBe(true)
    expect(autoHoldWanted('auto', 'reachable')).toBe(false)
    expect(autoServeEnabled('auto', 'unreachable')).toBe(false)
    expect(autoHoldWanted('auto', 'unreachable')).toBe(true)
  })
})

describe('auto-relay — candidate selection', () => {
  it('DIRECT-CONNECTED ONLY: relayed/undialed peers prove nothing', () => {
    const got = pickRelayCandidates([
      { peerId: 'QmDirect', direct: true },
      { peerId: 'QmRelayed', direct: false },
    ])
    expect(got).toEqual(['QmDirect'])
  })

  it('SELF excluded, duplicates collapsed, deterministic sorted order', () => {
    const candidates = [
      { peerId: 'QmSelf', direct: true },
      { peerId: 'Qmb', direct: true },
      { peerId: 'Qma', direct: true },
      { peerId: 'Qmb', direct: true },
    ]
    const first = pickRelayCandidates(candidates, { selfPeerId: 'QmSelf' })
    expect(first).toEqual(['Qma', 'Qmb'])
    // Same view ⇒ same pick, whatever the arrival order was.
    const shuffled = [...candidates].reverse()
    expect(pickRelayCandidates(shuffled, { selfPeerId: 'QmSelf' })).toEqual(first)
  })

  it('CAPS at MAX_AUTO_RELAYS by default and honors an explicit max', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      peerId: `Qm${String(i).padStart(2, '0')}`,
      direct: true,
    }))
    expect(pickRelayCandidates(many)).toHaveLength(MAX_AUTO_RELAYS)
    expect(pickRelayCandidates(many, { max: 1 })).toEqual(['Qm00'])
    expect(pickRelayCandidates([])).toEqual([])
  })
})
