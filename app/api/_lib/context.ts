import { createBlobStore } from '../../src/server/blobStore.js'
import type { GenerateDeps } from '../../src/server/generateService.js'
import { downloadAsset, pollOperation, submitWorld } from '../../src/server/worldLabsClient.js'

export function createDeps(): GenerateDeps {
  return {
    env: {
      worldLabsApiKey: process.env.WORLD_LABS_API_KEY,
      blobToken: process.env.BLOB_READ_WRITE_TOKEN,
      gateSecret: process.env.BLAST_GATE_SECRET,
    },
    store: createBlobStore(),
    worldLabs: {
      submit: submitWorld,
      poll: pollOperation,
    },
    download: downloadAsset,
    now: () => new Date().toISOString(),
    nowMs: () => Date.now(),
    suffix: () => Math.random().toString(36).slice(2, 6),
  }
}
