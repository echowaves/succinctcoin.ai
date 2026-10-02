import { describe, expect, it } from 'vitest'

import { CORE_PACKAGE } from '../src/index.js'

describe('harness', () => {
  it('runs a trivial green test', () => {
    expect(CORE_PACKAGE).toBe('@succinctcoin/core')
  })
})
