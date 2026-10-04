/**
 * Ambient type shim for `big.js@7.0.1` — the package ships no TypeScript
 * declarations (no `types` field, no `.d.ts`) and the story's frozen
 * boundary allows no dependency beyond `big.js` itself (so no
 * `@types/big.js`). This declares exactly the surface `display.ts` uses,
 * keeping `strict` mode clean.
 *
 * This file does NOT import big.js — it only declares the module. The sole
 * big.js importer in `src/ledger/` remains `display.ts` (2.5's import scan
 * pins that; when building it, scan import statements, not prose comments).
 */
declare module 'big.js' {
  export default class Big {
    constructor(value: number | string | Big)
    div(n: number | string | Big): Big
    times(n: number | string | Big): Big
    eq(n: number | string | Big): boolean
    gte(n: number | string | Big): boolean
    toFixed(dp?: number): string
    toString(): string
  }
}
