/**
 * `app/renderer/useSuccinctcoin` — the React hook wiring the 6.2 bridge
 * (`window.succinctcoin`) to the PURE `ui-state` module (6.3).
 *
 * On mount: the core event stream is subscribed FIRST (the `on(...)` calls
 * — no event is missed), then the one-time read-API snapshot is built. Each
 * core event re-renders through the PURE reducer. `CoreStarted` re-runs the
 * snapshot — the AD-9 read-API is PART of the complete UI data source
 * ("no polling" means never poll, not "events alone suffice"): an
 * event-driven re-read. There are NO timers anywhere in the renderer (E1 —
 * a static check in the test asserts it).
 *
 * AD-1 (the thin client): the ONLY core surface touched is the bridge
 * global (the `./preload.d.ts` typing) — never the core package.
 * AD-9 (read-only): this view never calls a command — the start/stop/
 * startMining commands are exposed on the bridge for the host; driving
 * them is not this 6.3 view's job.
 * AD-11: the hook surfaces only the key-free read-models + event payloads.
 */
import { useEffect, useState } from 'react'

import { buildInitialSnapshot, initialUiState, reduce } from './ui-state.js'
import type { UiState } from './ui-state.js'

/**
 * The renderer's data source: the current `UiState`, built from the
 * one-time read-API snapshot + updated by the core event stream (E1).
 *
 * F6: the bridge is read INSIDE the effect (not at module top level) — if
 * the preload surface is absent (a preload failure, or the page opened
 * outside the Electron shell), a VISIBLE error is set (the App renders an
 * error panel) instead of the module throwing at import (a silent blank
 * window).
 */
export function useSuccinctcoin(): UiState {
  const [state, setState] = useState<UiState>(initialUiState)

  useEffect(() => {
    // F6: read the bridge inside the effect + guard it (a missing bridge is
    // a VISIBLE error, not a silent blank window).
    const bridge: typeof window.succinctcoin | undefined = window.succinctcoin
    if (bridge === undefined) {
      setState((s) => ({
        ...s,
        error:
          'the succinctcoin bridge is missing — the preload did not expose window.succinctcoin',
      }))
      return
    }

    // The event stream FIRST (AD-9: nothing is missed between the
    // subscription and the snapshot).
    const unsubs = [
      bridge.on('BlockApplied', (payload) => {
        setState((s) => reduce(s, { type: 'BlockApplied', payload }))
        // F3: the balance / peers / total-supply change each block (the
        // `BlockApplied` event carries only the head fields) — re-read the
        // read-API (event-driven, NOT polling: the event triggers the
        // re-read, there is no timer).
        void buildInitialSnapshot(bridge).then((snapshot) =>
          setState((s) => ({
            ...s,
            head: snapshot.head ?? s.head,
            balances: snapshot.balances ?? s.balances,
            peers: snapshot.peers.length > 0 ? snapshot.peers : s.peers,
          })),
        )
      }),
      bridge.on('CoreStarted', (payload) => {
        setState((s) => reduce(s, { type: 'CoreStarted', payload }))
        // The core just booted: re-run the read-API snapshot (event-driven,
        // NOT polling). The reducer already set `mining` — the merge
        // preserves it.
        void buildInitialSnapshot(bridge).then((snapshot) =>
          setState((s) => ({ ...snapshot, mining: s.mining })),
        )
      }),
      bridge.on('CoreStopped', (payload) => {
        setState((s) => reduce(s, { type: 'CoreStopped', payload }))
      }),
    ]

    // The one-time snapshot (the AD-9 read-API).
    void buildInitialSnapshot(bridge).then((snapshot) =>
      setState((s) => ({ ...snapshot, mining: s.mining })),
    )

    return () => {
      for (const unsubscribe of unsubs) unsubscribe()
    }
  }, [])

  return state
}
