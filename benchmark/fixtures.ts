import { startSsrFixture } from '../fixtures/ssr.js'
import { startXhrFixture } from '../fixtures/xhr.js'
import { startSpaFixture } from '../fixtures/spa.js'
import { startRefusingFixture, startStubFixture } from '../fixtures/refusing.js'
import { startCoalesceFixture } from '../fixtures/coalesce.js'
import type { FixtureServer } from '../fixtures/harness.js'

export interface RunningFixtures {
  origins: Record<string, string>
  servers: Record<string, FixtureServer>
  close(): Promise<void>
}

/** Fixtures listen on ephemeral ports, so their origins are only known at runtime. */
export async function startAllFixtures(): Promise<RunningFixtures> {
  const siteA = await startSsrFixture()
  const siteB = await startXhrFixture()
  const siteC = await startSpaFixture()
  const siteRefusing = await startRefusingFixture()
  const siteCoalesce = await startCoalesceFixture()
  const siteStub = await startStubFixture()

  return {
    // siteBroken shares siteA's server; only its plan is wrong.
    origins: {
      siteA: siteA.url, siteB: siteB.url, siteC: siteC.url,
      siteBroken: siteA.url, siteOrdered: siteA.url, siteRefusing: siteRefusing.url,
      siteCoalesce: siteCoalesce.url, siteStub: siteStub.url,
    },
    servers: { siteA, siteB, siteC, siteRefusing, siteCoalesce, siteStub },
    close: async () => {
      await Promise.all([siteA.close(), siteB.close(), siteC.close(), siteRefusing.close(), siteCoalesce.close(), siteStub.close()])
    },
  }
}
