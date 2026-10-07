import { describe, expect, it } from 'vitest'
import {
  assertSafeHttpsUrl,
  buildWorldLabsRequest,
  decodeImagePayload,
  gateMatches,
  planAssets,
  readOperationId,
  slugFromName,
  slugify,
} from './remoteWorld'

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00])

describe('remote world helpers', () => {
  it('compares the gate secret without accepting a missing value', () => {
    expect(gateMatches('secret', 'secret')).toBe(true)
    expect(gateMatches('secret', 'secreT')).toBe(false)
    expect(gateMatches('', 'secret')).toBe(false)
    expect(gateMatches('secret', undefined)).toBe(false)
  })

  it('slugifies a display name and avoids reserved routes', () => {
    expect(slugify('Harbor at Dusk!')).toBe('harbor-at-dusk')
    expect(slugFromName('api', 'ab12').slug).not.toBe('api')
    expect(slugFromName('', 'ab12')).toEqual({ slug: 'world-ab12', displayName: 'Untitled world' })
  })

  it('decodes a jpeg and rejects a mismatched type', () => {
    const image = decodeImagePayload({ imageBase64: jpeg.toString('base64'), mimeType: 'image/jpeg' })
    expect(image.extension).toBe('jpg')
    expect(image.bytes[0]).toBe(0xff)
    expect(() => decodeImagePayload({ imageBase64: jpeg.toString('base64'), mimeType: 'image/png' })).toThrow(/does not match/)
  })

  it('builds a Marble image request and omits an empty prompt', () => {
    const image = decodeImagePayload({ imageBase64: jpeg.toString('base64'), mimeType: 'image/jpeg' })
    const request = buildWorldLabsRequest({ displayName: 'Harbor', image })
    expect(request.model).toBe('marble-1.1')
    expect(request.world_prompt).not.toHaveProperty('text_prompt')
    expect(request.world_prompt.image_prompt.source).toBe('data_base64')
  })

  it('reads the trailing operation id', () => {
    expect(readOperationId({ name: 'operations/op_123' })).toBe('op_123')
  })

  it('aliases a smaller splat to full_res when Marble omits full_res', () => {
    const tasks = planAssets('harbor', {
      assets: { splats: { spz_urls: { '500k': 'https://cdn.worldlabs.ai/mid.spz' } } },
    })
    expect(tasks.map((task) => task.id)).toEqual(['spz:full_res'])
    expect(tasks[0].pathname).toBe('worlds/harbor/0-world-full_res.spz')
  })

  it('allows public https asset urls and rejects local targets', () => {
    expect(() => assertSafeHttpsUrl('https://cdn.worldlabs.ai/full.spz')).not.toThrow()
    expect(() => assertSafeHttpsUrl('http://127.0.0.1/full.spz')).toThrow(/not allowed|must be https/)
    expect(() => assertSafeHttpsUrl('https://169.254.169.254/latest')).toThrow(/not allowed/)
  })
})
