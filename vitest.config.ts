import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 30_000,
    // Several suites launch a browser in beforeAll; the default 10s hook budget
    // is not enough once those run alongside each other.
    hookTimeout: 60_000,
  },
})
