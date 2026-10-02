/**
 * `core/config` — the genesis config seam (spine Operational Envelope).
 *
 * `config/genesis.json` is the static boot parameters: bootstrap list,
 * emission, K (re-attestation cadence), L (uptime lookback), the
 * accepted-gate registry, and the protocol version. This module is the single
 * owner of that shape: `validateGenesis` type-checks a raw object (pure, no
 * I/O) and `loadGenesis` is the only I/O path (read + parse + validate).
 *
 * A malformed config fails fast with `SC-CONFIG-1` naming the offending field
 * (spine error convention) — a broken node must never silently boot.
 *
 * Hand-rolled (no validation dependency): the spine Stack lists none and the
 * spec forbids a second toolchain.
 */
import { readFile } from 'node:fs/promises'

/** Emission parameters. Amounts are decimal strings (AD-5), never floats. */
export interface GenesisEmission {
  /** Per-block reward, decimal string (e.g. "12.5"). */
  blockReward: string
  /** Hard cap on total supply, decimal string (e.g. "21000000"). */
  maxSupply: string
}

/** The typed genesis config every capability epic reads at boot. */
export interface GenesisConfig {
  protocolVersion: number
  bootstrap: string[]
  emission: GenesisEmission
  /** Re-attestation cadence in chain-time windows (K, AD-3). */
  reattestationK: number
  /** Uptime lookback in windows (L, AD-3). */
  uptimeLookbackL: number
  /** Accepted-gate registry ids (AD-4). */
  gates: string[]
}

/** Boot-time genesis-config error. Carries `{ code: 'SC-CONFIG-1', message }`. */
export class GenesisConfigError extends Error {
  readonly code = 'SC-CONFIG-1' as const
  constructor(message: string) {
    super(message)
    this.name = 'GenesisConfigError'
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v)
}

/** A clean non-negative decimal string: "0", "12.5" — not "1e5"/"12."/"-1". */
function isDecimalString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && /^\d+(\.\d+)?$/.test(v)
}

/** Throw the canonical `SC-CONFIG-1` error, naming the field. */
function fail(field: string, detail: string): never {
  throw new GenesisConfigError(`SC-CONFIG-1: ${field}: ${detail}`)
}

/**
 * Validate a raw (untrusted) genesis object and return the typed config.
 * Pure — no I/O — so it is testable without a filesystem. Throws
 * `GenesisConfigError` (`SC-CONFIG-1`) naming the first offending field.
 */
export function validateGenesis(raw: unknown): GenesisConfig {
  if (!isRecord(raw)) fail('$', 'genesis config must be a JSON object')

  if (!isInt(raw.protocolVersion) || raw.protocolVersion < 1)
    fail('protocolVersion', 'must be an integer >= 1')

  if (!Array.isArray(raw.bootstrap) || raw.bootstrap.length === 0)
    fail('bootstrap', 'must be a non-empty array of multiaddr strings')
  for (const [i, entry] of raw.bootstrap.entries()) {
    if (typeof entry !== 'string' || !entry.startsWith('/'))
      fail(`bootstrap[${i}]`, 'must be a multiaddr string starting with "/"')
  }

  if (!isRecord(raw.emission)) fail('emission', 'must be an object')
  if (!isDecimalString(raw.emission.blockReward))
    fail('emission.blockReward', 'must be a non-negative decimal string')
  if (!isDecimalString(raw.emission.maxSupply))
    fail('emission.maxSupply', 'must be a non-negative decimal string')

  if (!isInt(raw.reattestationK) || raw.reattestationK < 1)
    fail('reattestationK', 'must be an integer >= 1')

  if (!isInt(raw.uptimeLookbackL) || raw.uptimeLookbackL < 1)
    fail('uptimeLookbackL', 'must be an integer >= 1')

  if (!Array.isArray(raw.gates) || raw.gates.length === 0)
    fail('gates', 'must be a non-empty array of gate id strings')
  for (const [i, g] of raw.gates.entries()) {
    if (typeof g !== 'string' || g.length === 0)
      fail(`gates[${i}]`, 'must be a non-empty gate id string')
  }

  return {
    protocolVersion: raw.protocolVersion,
    bootstrap: raw.bootstrap as string[],
    emission: {
      blockReward: raw.emission.blockReward,
      maxSupply: raw.emission.maxSupply,
    },
    reattestationK: raw.reattestationK,
    uptimeLookbackL: raw.uptimeLookbackL,
    gates: raw.gates as string[],
  }
}

/**
 * The only I/O path: read a genesis file, parse it, and validate it.
 * Rejects with `SC-CONFIG-1` on a missing file, invalid JSON, or a malformed
 * config — so a host can `await loadGenesis(path)` at boot and fail fast.
 */
export async function loadGenesis(path: string): Promise<GenesisConfig> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    fail(path, `could not read genesis config file (${(err as Error).message})`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    fail(path, `invalid JSON in genesis config file (${(err as Error).message})`)
  }
  return validateGenesis(parsed)
}
