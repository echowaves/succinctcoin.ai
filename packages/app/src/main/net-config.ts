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
import type {
  AutoRelayMode,
  GenesisConfig,
  NetAdapterConfig,
} from '@succinctcoin/core'

/**
 * The production listen address: `/ip6/::/tcp/0` — all interfaces, EPHEMERAL
 * port. 9.1 IPv6-only (spec constraint 2026-10-18): the ONE family is global
 * IPv6 unicast; Node's dual-stack `::` bind still ACCEPTS v4-mapped sockets,
 * but every announce/dial boundary applies the address policy, so nothing
 * non-v6 is ever used. Ephemeral so multiple instances coexist on one
 * machine; the public multiaddr is read back from the started node.
 */
export const LAN_LISTEN_ADDRESS = '/ip6/::/tcp/0'

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
      ? `/ip6/::/tcp/${port}`
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
    // 9.1: mDNS is OFF by default — its IPv4 multicast is middlebox-hostile
    // (the pivot's field evidence) and off-policy for an IPv6-only network.
    // Opt in with `mdns: true` (env SUCCINCTCOIN_MDNS=1) on friendly LANs.
    mdns: opts.mdns === true,
    bootstrap,
    // 10.2 — relay seeds (env SUCCINCTCOIN_RELAY_SEEDS): EMPTY by default
    // (no operated infrastructure — the Epic-10 non-goal); when set, the
    // adapter holds reservations and announces circuit addresses.
    relaySeeds: opts.relaySeeds ?? [],
    // 10.3 — the volunteer-relay role (env SUCCINCTCOIN_RELAY_SERVER=1) is
    // opt-in AND key-absent when off: default builds stay byte-identical to
    // pre-10.3 (exact-config pins). `as const` keeps the literal type.
    ...(opts.relayServer === true ? { relayRole: 'relay' as const } : {}),
    // Ticket 7 — auto-relay is ON unless the kill switch says otherwise, so
    // the key is ABSENT only when a caller passes no mode (the pinned
    // exact-config default); the app boot always passes `resolveRelayAuto`.
    ...(opts.relayAuto !== undefined ? { relayAuto: opts.relayAuto } : {}),
    protocolIdentityId,
  }
}

/**
 * Ticket 7 — resolve the auto-relay mode from the environment. DEFAULT ON:
 * a plain install serves hops while reachable and holds circuits through
 * hop-advertising direct peers once proven-unreachable (the discovery
 * ladder's rung 3; zero operator config). KILL SWITCH: `SUCCINCTCOIN_RELAY_AUTO=0`
 * ⇒ `'explicit-only'` — the pre-ticket behavior (explicit seeds +
 * `SUCCINCTCOIN_RELAY_SERVER` only), byte-identical to today. Pure: env in,
 * mode out.
 */
export function resolveRelayAuto(env: NodeJS.ProcessEnv): AutoRelayMode {
  return env.SUCCINCTCOIN_RELAY_AUTO === '0' ? 'explicit-only' : 'auto'
}

/** Optional boot overrides (resolved from env/files by the thin glue). */
export interface NetConfigOptions {
  /** Fixed TCP listen port (1–65535) instead of ephemeral — stable LAN
   * addresses for bootstrap hints when multicast is blocked. Invalid or
   * absent ⇒ ephemeral (`tcp/0`), the pinned default. */
  listenPort?: number | undefined
  /** Locally-configured bootstrap multiaddrs (e.g. a LAN peer whose address
   * was copied from its boot log) MERGED after `genesis.bootstrap`. The
   * adapter policy-filters the list on the real transport. */
  extraBootstrap?: readonly string[] | undefined
  /** Opt INTO LAN mDNS discovery (default OFF since 9.1). */
  mdns?: boolean | undefined
  /** 10.2 — circuit-relay seeds (multiaddrs carrying /p2p/<relayId>).
   * Default EMPTY (pinned); the adapter holds reservations on each and
   * advertises `<seed>/p2p-circuit/p2p/<self>` alongside direct addrs. */
  relaySeeds?: readonly string[] | undefined
  /** 10.3 — serve as a circuit relay (5.7 role; env
   * SUCCINCTCOIN_RELAY_SERVER=1). Default false (pinned): volunteering is
   * opt-in. A server bootstraps like any peer and should NOT itself need
   * seeds — it is the seed. */
  relayServer?: boolean | undefined
  /** Ticket 7 — auto-relay mode (env SUCCINCTCOIN_RELAY_AUTO; default
   * `'auto'`, kill switch `'0'` ⇒ `'explicit-only'`). ABSENT by default so
   * the pinned exact-config builds don't grow a key; the app boot always
   * passes `resolveRelayAuto(env)`. */
  relayAuto?: AutoRelayMode | undefined
}

/**
 * Parse `SUCCINCTCOIN_RELAY_SEEDS` (10.2): comma-separated multiaddrs,
 * each trimmed, empty entries dropped. Unset/blank ⇒ `[]` — the pinned
 * default (an install with no seeds behaves exactly like pre-10.2). The
 * adapter validates shape (parse + `/p2p/<relayId>`) and NEVER throws on a
 * bad seed; this parser only splits.
 */
export function parseRelaySeeds(value: string | undefined): string[] {
  if (value === undefined) return []
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
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
