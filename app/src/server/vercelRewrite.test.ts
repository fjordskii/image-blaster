import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'

describe('vercel rewrites', () => {
  it('sends viewer routes to the SPA and leaves the API alone', () => {
    const vercel = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../vercel.json'), 'utf8')) as {
      rewrites: Array<{ source: string, destination: string }>
    }
    const pattern = new RegExp(`^${vercel.rewrites[0].source}$`)
    expect(pattern.test('/')).toBe(true)
    expect(pattern.test('/harbor')).toBe(true)
    expect(pattern.test('/harbor/edit')).toBe(true)
    expect(pattern.test('/api/generate')).toBe(false)
    expect(pattern.test('/api/worlds')).toBe(false)
    expect(pattern.test('/api/blast')).toBe(false)
    expect(pattern.test('/api')).toBe(false)
    expect(pattern.test('/assets/index.js')).toBe(false)
    expect(pattern.test('/hdri.jpg')).toBe(false)
    expect(pattern.test('/butterfly/butterfly.glb')).toBe(false)
  })
})
