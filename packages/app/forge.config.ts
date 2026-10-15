/**
 * `app/forge.config` — the electron-forge packaging config (story 6.4,
 * the spine pin `@electron-forge/cli` 8.0.1).
 *
 * A PLAIN OBJECT default export — NO type import from
 * `@electron-forge/shared-types`: that package is a TRANSITIVE dependency
 * of `@electron-forge/cli`, not a direct dep of `packages/app`, and
 * pnpm's strict node layout would not resolve it from here. The makers
 * are referenced by NAME string (not imported), so the config — and the
 * 6.4 e2e that asserts on it — do not need any maker package installed.
 *
 * The `package` script (`electron-forge package`, `packages/app`) needs
 * only the `packagerConfig` + the app's `main` entry
 * (`./dist/main/index.js`, the electron MAIN process — the app's entry);
 * the `makers` are for `make` (the per-platform bundles). The config is
 * valid for both. The e2e row `E2E_FORGE_CONFIG_RESOLVES` asserts this
 * shape + the entry statically (no electron launch — AD-10).
 */
const config = {
  packagerConfig: {
    name: 'SuccinctCoin',
    executableName: 'succinctcoin',
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin', 'win32', 'linux'],
      config: {},
    },
  ],
}

export default config
