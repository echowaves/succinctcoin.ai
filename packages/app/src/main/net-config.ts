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
  RelaySeedEvent,
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
 * 11.3 — the SHIPPED default relay seeds: EMPTY today, and that is the pin.
 * This is a provisioned constant, not an absence: 11.5's flip replaces this
 * empty list with pinned dual-stack seed multiaddrs once 11.4 lands, and a
 * config test pins the empty constant itself (an install without the env
 * var must keep behaving exactly like pre-seam until then). Merged BEFORE
 * the operator's `SUCCINCTCOIN_RELAY_SEEDS` via {@link mergeRelaySeeds}.
 */
export const DEFAULT_RELAY_SEEDS: readonly string[] = []

/**
 * 11.3 — merge shipped defaults with env-configured seeds: defaults FIRST,
 * env additive, deduped by exact string (the same shape as the bootstrap
 * merge in {@link defaultNetConfig}). Pure. With `DEFAULT_RELAY_SEEDS` empty
 * today every env list passes through unchanged, order included.
 */
export function mergeRelaySeeds(
  defaults: readonly string[],
  envSeeds: readonly string[],
): string[] {
  return [...new Set([...defaults, ...envSeeds])]
}

/**
 * 11.3 — the hop family a seed is dialed through, derived from its FIRST IP
 * component wherever it sits (`/ip4/` ⇒ `'v4'`, `/ip6/` ⇒ `'v6'`; `null`
 * only when the seed carries no IP at all — a dns-named or malformed seed;
 * pure string shape, NO DNS). "First IP component" deliberately matches
 * core's seed law (`firstIpIsGlobalScope` scans components in order), so
 * the boot line and the adapter agree on what family a seed is. Both boot
 * paths tag their relay HOLD/FAIL lines via {@link relaySeedLine}.
 */
export function seedHopFamily(seed: string): 'v4' | 'v6' | null {
  const first = seed.match(/\/ip(4|6)\//)
  if (first?.[1] === '4') return 'v4'
  if (first?.[1] === '6') return 'v6'
  return null
}

/**
 * 11.3 — THE boot line for one relay-seed event, shared by both boot paths
 * (electron `index.ts` and the headless runner): family-tagged HOLD/FAIL,
 * FAIL keeps the error. One formatter means one tested truth — the electron
 * path has no headless log-injection harness, so what it prints IS this
 * pure function's output at its call site (pinned by source pin + live pins
 * here).
 */
export function relaySeedLine(event: RelaySeedEvent): string {
  const family = seedHopFamily(event.seed)
  const tag = family === null ? '' : ` (${family})`
  return event.ok
    ? `[boot] relay HOLD${tag} ${event.seed}`
    : `[boot] relay FAIL${tag} ${event.seed}: ${String(event.error)}`
}

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
    // 10.2/11.3 — relay seeds: the shipped defaults (DEFAULT_RELAY_SEEDS,
    // EMPTY today — 11.5's flip provisions it) merged BEFORE the env seeds
    // (SUCCINCTCOIN_RELAY_SEEDS): defaults first, env additive, deduped by
    // exact string. Empty + empty ⇒ [] — byte-identical to the pre-seam
    // default (the exact-config pins); when set, the adapter holds
    // reservations and announces circuit addresses.
    relaySeeds: mergeRelaySeeds(DEFAULT_RELAY_SEEDS, opts.relaySeeds ?? []),
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
  /** 10.2 — circuit-relay seeds (multiaddrs carrying /p2p/<relayId>),
   * env SUCCINCTCOIN_RELAY_SEEDS. Merged additive AFTER
   * `DEFAULT_RELAY_SEEDS` (defaults first, deduped by exact string); with
   * the shipped defaults empty today this is the operator's only channel.
   * The adapter holds reservations on each and advertises
   * `<seed>/p2p-circuit/p2p/<self>` alongside direct addrs. */
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
