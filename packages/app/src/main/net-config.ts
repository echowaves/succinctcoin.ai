/**
 * `app/main/net-config` — the PURE net-config seam (7.2, R1).
 *
 * ONE pure function turns the validated genesis + the operator's protocol
 * identity id into the `createNetAdapter` config the app boots on: the REAL
 * stack — `transport: 'tcp'` (noise + yamux), mDNS ON for LAN discovery,
 * and the genesis `bootstrap` list for joining wider networks. This is the
 * app-side selection of the core's epic-5 adapter; the adapter itself is
 * untouched (its tcp/mdns/bootstrap/circuit-relay code paths already exist
 * and are already inlined in the app bundle — verified at 0bba993).
 *
 * AD-10 discipline: this module is PURE — type-only imports from the core,
 * no electron, no I/O, no clock, no RNG — so plain-Node tests run it
 * directly. The memory transport stays exactly where AD-10 puts it:
 * TEST-ONLY, reachable only via explicit test injection of a net config
 * (the app suites build their own memory adapters); NOTHING on the boot
 * path can select it (R1 — pinned by the source scan in
 * `test/net-config.test.ts`).
 *
 * AD-11: `protocolIdentityId` passes through UNCHANGED — the identity
 * keypair stays in main (`index.ts` creates it); the config carries only
 * the plain public id string, never key material.
 */
import type { GenesisConfig, NetAdapterConfig } from '@succinctcoin/core'

/**
 * The production listen address: `/ip4/0.0.0.0/tcp/0` — all interfaces,
 * EPHEMERAL port (epic Notes, Decision 2026-10-16). Ephemeral so multiple
 * instances coexist on one machine; the public multiaddr is read back from
 * the started node. Fixed ports arrive later with public-bootstrap
 * infrastructure, not here.
 */
export const LAN_LISTEN_ADDRESS = '/ip4/0.0.0.0/tcp/0'

/**
 * The boot-time net config (7.2 R1): tcp + mDNS + genesis bootstrap.
 *
 * `genesis` is typed `Pick<GenesisConfig, 'bootstrap'>` — the seam reads
 * exactly ONE genesis field, so callers pass the whole validated config and
 * tests pass a literal. The bootstrap list passes through VERBATIM (an
 * empty list is valid post-7.1: LAN-only testnet; the adapter's own gate
 * wires `@libp2p/bootstrap` only when non-empty). No key material in the
 * result (AD-11): `protocolIdentityId` is returned unchanged.
 */
export function defaultNetConfig(
  genesis: Pick<GenesisConfig, 'bootstrap'>,
  protocolIdentityId: string,
  opts: NetConfigOptions = {},
): NetAdapterConfig {
  const port = opts.listenPort
  const listenAddress =
    typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535
      ? `/ip4/0.0.0.0/tcp/${port}`
      : LAN_LISTEN_ADDRESS
  const extra = opts.extraBootstrap ?? []
  // Merge order: genesis first, then local hints; dedupe by exact string.
  // With no hints the list passes through VERBATIM (the pinned 7.2 shape).
  const bootstrap =
    extra.length === 0
      ? genesis.bootstrap
      : [...new Set([...genesis.bootstrap, ...extra])]
  return {
    transport: 'tcp',
    listenAddress,
    mdns: true,
    bootstrap,
    protocolIdentityId,
  }
}

/** Optional boot overrides (resolved from env/files by the thin glue). */
export interface NetConfigOptions {
  /** Fixed TCP listen port (1–65535) instead of ephemeral — stable LAN
   * addresses for bootstrap hints when multicast is blocked. Invalid or
   * absent ⇒ ephemeral (`tcp/0`), the pinned default. */
  listenPort?: number | undefined
  /** Locally-configured bootstrap multiaddrs (e.g. a LAN peer whose address
   * was copied from its boot log) MERGED after `genesis.bootstrap`. */
  extraBootstrap?: readonly string[] | undefined
}

/**
 * Parse a local bootstrap-hints file (one multiaddr per line; `#` comments
 * and blank lines ignored; a line that does not start with `/` is dropped —
 * the adapter's own bootstrap service remains the validity authority). The
 * glue reads the file; this stays pure.
 */
export function parseBootstrapFile(text: string): string[] {
  const out: string[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    if (!line.startsWith('/')) continue
    out.push(line)
  }
  return out
}
