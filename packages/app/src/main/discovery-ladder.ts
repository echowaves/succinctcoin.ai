/**
 * `app/main/discovery-ladder` — the PURE discovery-path seam (8.5, R4).
 *
 * Turns host inputs (platform, env, the userData dir, an optional shared
 * root) into the core's `DiscoveryPorts` — WHERE the ladder's file rungs
 * read from, and WHAT gets announced. Like `net-config.ts` (the 7.2
 * pattern this follows), the module is PURE: type-only imports from the
 * core, no electron, no I/O, no ambient platform reads — `process.platform`
 * / `process.env` / `app.getPath('userData')` arrive as PARAMETERS from the
 * thin glue (`index.ts`), so plain-Node tests run every row.
 *
 * The two paths:
 *  - LAN hints file (rung 2): OS-appropriate SHARED location via the core's
 *    `defaultLanBookPath` (env override `SUCCINCTCOIN_LAN_BOOK`) — records
 *    ingest hint-grade there (stored, never dialed without 3 vouchs).
 *  - artifact file (rung 3): per-install, INSIDE userData — the local copy
 *    of block-grade announcement records the user (or a repair flow) drops
 *    for an amnesiac boot.
 */
import { defaultArtifactPath, defaultLanBookPath } from '@succinctcoin/core'

import type { DiscoveryPorts, LadderReport } from '@succinctcoin/core'

/** Host inputs to the seam (all injected — see module purity note). */
export interface LadderSeamInputs {
  /** `process.platform` at the glue. */
  platform: NodeJS.Platform
  /** `process.env` at the glue (only `SUCCINCTCOIN_LAN_BOOK` is read). */
  env: Record<string, string | undefined>
  /** `app.getPath('userData')` — the per-install data dir. */
  userDataDir: string
  /** Optional shared-root override for the LAN file (tests, odd mounts). */
  lanSharedDir?: string
}

/** The resolved ladder file paths (pure function of the inputs). */
export interface LadderPaths {
  hintsFilePath: string
  artifactFilePath: string
}

export function resolveLadderPaths(inputs: LadderSeamInputs): LadderPaths {
  return {
    hintsFilePath: defaultLanBookPath(inputs.platform, inputs.env, inputs.lanSharedDir),
    artifactFilePath: defaultArtifactPath(inputs.userDataDir),
  }
}

/**
 * The `CorePorts.discovery` bundle for the app boot: resolved paths + the
 * announce-address hook (bound to the started adapter by the glue) + a
 * report sink that LOGS counts only — the report shape is AD-9-safe by
 * construction (no keys, no PII beyond public multiaddrs; the UI surface
 * for it is a later ticket, noted in the plan).
 */
export function buildDiscoveryPorts(
  inputs: LadderSeamInputs,
  announceAddresses: () => string[],
  log: (report: LadderReport) => void = (report) => {
    // The what-worked line (design: "how did this node find its way").
    console.info('[discovery-ladder]', JSON.stringify(report))
  },
): DiscoveryPorts {
  const paths = resolveLadderPaths(inputs)
  return {
    hintsFilePath: paths.hintsFilePath,
    artifactFilePath: paths.artifactFilePath,
    announceAddresses,
    onLadderReport: log,
  }
}
