import { BlobNotFoundError, get, list, put } from '@vercel/blob'
import type { RemoteStore } from './generateService'

const JSON_CACHE_SECONDS = 60
const ASSET_CACHE_SECONDS = 60 * 60 * 24 * 30

export function createBlobStore(): RemoteStore {
  return {
    async putPublic(pathname, body, contentType) {
      const blob = await put(pathname, body, {
        access: 'public',
        token: blobToken(),
        contentType,
        addRandomSuffix: false,
        allowOverwrite: true,
        cacheControlMaxAge: pathname.endsWith('.json') ? JSON_CACHE_SECONDS : ASSET_CACHE_SECONDS,
        multipart: typeof body !== 'string' && body.size > 4_000_000,
      })
      return blob.url
    },
    async getJson(pathname) {
      try {
        const result = await get(pathname, {
          access: 'public',
          token: blobToken(),
          useCache: false,
        })
        if (!result || result.statusCode !== 200 || !result.stream) return null
        return await new Response(result.stream).json()
      } catch (error) {
        if (error instanceof BlobNotFoundError) return null
        throw error
      }
    },
    async list(prefix) {
      const blobs = []
      let cursor: string | undefined
      do {
        const page = await list({ prefix, cursor, token: blobToken(), limit: 1000 })
        for (const blob of page.blobs) {
          blobs.push({
            pathname: blob.pathname,
            url: blob.url,
            uploadedAt: new Date(blob.uploadedAt),
          })
        }
        cursor = page.hasMore && page.cursor ? page.cursor : undefined
      } while (cursor)
      return blobs
    },
  }
}

function blobToken() {
  const token = process.env.BLOB_READ_WRITE_TOKEN
  if (!token) throw new Error('BLOB_READ_WRITE_TOKEN is not set.')
  return token
}
