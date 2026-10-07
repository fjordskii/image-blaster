import { describe, expect, it, vi } from 'vitest'
import { advanceWorldJob, errorResult, listRemoteWorlds, startWorldJob, type GenerateDeps, type RemoteStore } from './generateService'
import type { JobRecord } from './remoteWorld'

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00])
const NOW = '2026-10-07T00:00:00.000Z'

const sampleWorld = {
  world_id: 'wl_1',
  display_name: 'Harbor',
  world_marble_url: 'https://marble.worldlabs.ai/world/wl_1',
  assets: {
    caption: 'A harbor',
    thumbnail_url: 'https://cdn.worldlabs.ai/thumb.webp',
    mesh: { collider_mesh_url: 'https://cdn.worldlabs.ai/collider.glb' },
    imagery: { pano_url: 'https://cdn.worldlabs.ai/pano.png' },
    splats: {
      spz_urls: {
        full_res: 'https://cdn.worldlabs.ai/full.spz',
        '500k': 'https://cdn.worldlabs.ai/500.spz',
      },
      semantics_metadata: { metric_scale_factor: 1.2, ground_plane_offset: 0.25, flip_y: true },
    },
  },
}

function memoryStore(): RemoteStore & {
  files: Map<string, { text: string, uploadedAt: Date }>
} {
  const files = new Map<string, { text: string, uploadedAt: Date }>()
  return {
    files,
    async putPublic(pathname, body) {
      const text = typeof body === 'string' ? body : Buffer.from(await body.arrayBuffer()).toString('base64')
      files.set(pathname, { text, uploadedAt: new Date(NOW) })
      return `https://blob.example/${pathname}`
    },
    async getJson(pathname) {
      const file = files.get(pathname)
      if (!file) return null
      return JSON.parse(file.text)
    },
    async list(prefix) {
      return [...files.entries()]
        .filter(([pathname]) => pathname.startsWith(prefix))
        .map(([pathname, file]) => ({
          pathname,
          url: `https://blob.example/${pathname}`,
          uploadedAt: file.uploadedAt,
        }))
    },
  }
}

function deps(store: RemoteStore, worldLabs?: { submit: ReturnType<typeof vi.fn>, poll: ReturnType<typeof vi.fn> }): GenerateDeps {
  return {
    env: {
      worldLabsApiKey: 'world-labs-key',
      blobToken: 'blob-token',
      gateSecret: 'gate-secret',
    },
    store,
    worldLabs: worldLabs ?? {
      submit: vi.fn(async () => ({ operation_id: 'op_123', done: false })),
      poll: vi.fn(async () => ({ operation_id: 'op_123', done: false })),
    },
    download: vi.fn(async () => ({ bytes: Uint8Array.from([1, 2, 3]) })),
    now: () => NOW,
    nowMs: () => Date.parse(NOW),
    suffix: () => 'ab12',
  }
}

function uploadBody() {
  return {
    name: 'Harbor',
    prompt: 'evening tide',
    mimeType: 'image/jpeg',
    imageBase64: jpeg.toString('base64'),
  }
}

describe('generate service', () => {
  it('starts a world job without storing the image payload or api key', async () => {
    const store = memoryStore()
    const submit = vi.fn(async (_request: unknown, _apiKey: string) => ({ operation_id: 'op_123', done: false }))
    const service = deps(store, {
      submit,
      poll: vi.fn(async () => ({ operation_id: 'op_123', done: false })),
    })
    const result = await startWorldJob({ gateHeader: 'gate-secret', body: uploadBody() }, service)
    expect(result.status).toBe(202)
    expect(result.body).toMatchObject({ operationId: 'op_123', slug: 'harbor', status: 'running' })
    const job = store.files.get('jobs/op_123.json')?.text ?? ''
    expect(job).not.toContain(jpeg.toString('base64'))
    expect(job).not.toContain('world-labs-key')
    expect(job).not.toContain('gate-secret')
    expect(submit).toHaveBeenCalledOnce()
    const request = submit.mock.calls[0][0] as { world_prompt: { text_prompt?: string } }
    expect(request.world_prompt.text_prompt).toBe('evening tide')
  })

  it('rejects a missing or wrong gate before calling Marble', async () => {
    const store = memoryStore()
    const service = deps(store)
    expect((await startWorldJob({ gateHeader: 'nope', body: uploadBody() }, service)).status).toBe(401)
    service.env.gateSecret = undefined
    expect((await startWorldJob({ gateHeader: 'gate-secret', body: uploadBody() }, service)).status).toBe(503)
    expect(service.worldLabs.submit).not.toHaveBeenCalled()
  })

  it('does not require FAL to start a world', async () => {
    const store = memoryStore()
    const service = deps(store)
    const result = await startWorldJob({ gateHeader: 'gate-secret', body: uploadBody() }, service)
    expect(result.status).toBe(202)
  })

  it('copies one asset per poll and publishes blob urls', async () => {
    const store = memoryStore()
    let polls = 0
    const service = deps(store, {
      submit: vi.fn(async () => ({ operation_id: 'op_123', done: false })),
      poll: vi.fn(async () => {
        polls += 1
        if (polls < 2) return { operation_id: 'op_123', done: false }
        return { operation_id: 'op_123', done: true, response: sampleWorld }
      }),
    })
    await startWorldJob({ gateHeader: 'gate-secret', body: uploadBody() }, service)
    let body: { status?: string, entry?: { world?: { assets: { splats: { spz_urls: { full_res?: string } }, mesh: { collider_mesh_url: string } } } } } = {}
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const result = await advanceWorldJob({ gateHeader: 'gate-secret', operationId: 'op_123' }, service)
      body = result.body as typeof body
      if (body.status === 'completed' || body.status === 'failed') break
    }
    expect(body.status).toBe('completed')
    expect(body.entry?.world?.assets.splats.spz_urls.full_res).toBe('https://blob.example/worlds/harbor/0-world-full_res.spz')
    expect(body.entry?.world?.assets.mesh.collider_mesh_url).toBe('https://blob.example/worlds/harbor/0-world.glb')
    expect(body.entry?.world?.assets.mesh.collider_mesh_url).not.toContain('worldlabs.ai')
    expect(store.files.has('worlds/harbor/manifest.json')).toBe(true)
    const listed = await listRemoteWorlds({ gateHeader: 'gate-secret' }, service)
    expect(listed.status).toBe(200)
    expect((listed.body as { worlds: unknown[] }).worlds).toHaveLength(1)
  })

  it('fails a private splat url instead of downloading it', async () => {
    const store = memoryStore()
    const service = deps(store, {
      submit: vi.fn(async () => ({ operation_id: 'op_bad', done: false })),
      poll: vi.fn(async () => ({
        done: true,
        response: { assets: { splats: { spz_urls: { full_res: 'http://127.0.0.1/full.spz' } } } },
      })),
    })
    service.worldLabs.submit = vi.fn(async () => ({ operation_id: 'op_bad', done: false }))
    await startWorldJob({ gateHeader: 'gate-secret', body: uploadBody() }, service)
    let status = ''
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const result = await advanceWorldJob({ gateHeader: 'gate-secret', operationId: 'op_bad' }, service)
      status = (result.body as { status: string }).status
    }
    expect(status).toBe('failed')
    expect(service.download).not.toHaveBeenCalled()
  })

  it('does not echo a rejected blob token', () => {
    const result = errorResult(new Error('Vercel Blob: Access denied, please provide a valid token for this resource.'))
    expect(result).toEqual({ status: 503, body: { error: 'BLOB_READ_WRITE_TOKEN was rejected.' } })
  })

  it('rate limits new starts', async () => {
    const store = memoryStore()
    const service = deps(store)
    for (let index = 0; index < 6; index += 1) {
      store.files.set(`jobs/old-${index}.json`, {
        text: JSON.stringify({ operationId: `old-${index}`, status: 'completed' } satisfies Partial<JobRecord>),
        uploadedAt: new Date(NOW),
      })
    }
    const result = await startWorldJob({ gateHeader: 'gate-secret', body: uploadBody() }, service)
    expect(result.status).toBe(429)
    expect(service.worldLabs.submit).not.toHaveBeenCalled()
  })
})
