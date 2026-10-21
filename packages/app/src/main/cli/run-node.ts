/**
 * `app/main/cli/run-node` — the plain-Node entry point for running a node
 * without Electron (ticket 8; built to `dist/node/run-node.js`).
 *
 * Deliberately the thinnest possible shell: parse argv, boot via
 * {@link runNode}, translate signals into a clean shutdown. ALL behavior lives
 * in `../run-node.ts` (the testable module); this file has no electron import
 * and no logic worth testing beyond what `parseRunnerArgs` already pins.
 *
 * Lifecycle: SIGINT/SIGTERM → `stop()` (halt the loop, close the store, stop
 * the transport) → exit 0. The handlers are armed BEFORE booting (a supervisor
 * sends SIGTERM to whatever is running, including a node still booting), and a
 * second signal exits immediately rather than waiting out a stuck shutdown. A
 * crash is NOT caught: under a supervisor (`systemd Restart=always`) dying
 * loudly with a stack trace in the journal is the honest behavior — a swallowed
 * error would look like a healthy node.
 */
import { RUNNER_USAGE, defaultGenesisPath, parseRunnerArgs, runNode } from '../run-node.js'
import type { NodeRunHandle } from '../run-node.js'

async function main(): Promise<void> {
  let args: ReturnType<typeof parseRunnerArgs>
  try {
    args = parseRunnerArgs(process.argv.slice(2), defaultGenesisPath(import.meta.url))
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err))
    process.exitCode = 2
    return
  }
  if (args.help) {
    console.log(RUNNER_USAGE)
    return
  }
  if (args.dataDir === undefined || args.dataDir === '') {
    console.error(`--data-dir is required (the node's identity.seed + chain live there)\n\n${RUNNER_USAGE}`)
    process.exitCode = 2
    return
  }

  // Signals arrive during boot too (a contended store lock, a slow bind), and
  // a supervisor's patience is finite — so the handlers are armed BEFORE
  // booting: remember the signal, stop as soon as there is something to stop.
  // A second signal means "now": exit at once, no graceful path (systemd would
  // otherwise wait its StopTimeout and SIGKILL).
  let handle: NodeRunHandle | undefined
  let signalled: string | undefined
  let stopping = false
  const shutdown = (signal: string): void => {
    if (stopping) return
    stopping = true
    console.log(`[stop] ${signal} — shutting down`)
    if (handle === undefined) {
      // Still booting: there is nothing to stop gracefully yet, and dying here
      // is safe — the OS closes whatever `runNode` had opened by then. (A boot
      // that fails on its own rejects, and `runNode` stops its transport first.)
      process.exit(0)
    }
    void handle
      .stop()
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        console.error('[stop] shutdown failed', err)
        process.exit(1)
      })
  }
  const onSignal = (signal: string) => (): void => {
    if (signalled !== undefined) {
      console.log(`[stop] ${signal} during shutdown — exiting now`)
      process.exit(1)
    }
    signalled = signal
    shutdown(signal)
  }
  process.once('SIGINT', onSignal('SIGINT'))
  process.once('SIGTERM', onSignal('SIGTERM'))

  handle = await runNode({
    dataDir: args.dataDir,
    genesisPath: args.genesisPath,
    flags: args.flags,
    startMining: args.mine,
  })
}

void main().catch((err: unknown) => {
  console.error('succinctcoin: boot failed', err)
  process.exit(1)
})
