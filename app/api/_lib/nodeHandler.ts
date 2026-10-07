import { errorResult } from '../../src/server/generateService.js'
import { HttpError } from '../../src/server/httpError.js'
import { json } from './http.js'

const BODY_LIMIT = 4_500_000

type NodeRequest = {
  method?: string
  url?: string
  headers?: Record<string, string | string[] | undefined>
  body?: unknown
  [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array | string>
}

type NodeResponse = {
  statusCode: number
  setHeader(name: string, value: string): void
  end(body?: string | Buffer): void
}

export function nodeHandler(handle: (request: Request) => Promise<Response>) {
  return async function handler(req: unknown, res?: unknown): Promise<Response | void> {
    try {
      if (isNodeResponse(res)) {
        const request = await nodeRequestToWeb(req as NodeRequest)
        const response = await handle(request)
        await writeWebResponse(res, response)
        return
      }
      if (req instanceof Request) return handle(req)
      throw new Error('Unsupported function request.')
    } catch (error) {
      const result = errorResult(error)
      if (isNodeResponse(res)) {
        res.statusCode = result.status
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(JSON.stringify(result.body))
        return
      }
      return json(result.status, result.body)
    }
  }
}

export async function nodeRequestToWeb(req: NodeRequest, origin = 'http://localhost'): Promise<Request> {
  const url = new URL(req.url || '/', origin)
  const method = (req.method || 'GET').toUpperCase()
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers || {})) {
    if (typeof value === 'string') headers.set(key, value)
    else if (Array.isArray(value)) headers.set(key, value.join(', '))
  }
  if (method === 'GET' || method === 'HEAD') return new Request(url, { method, headers })

  let body: BodyInit
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(req.body)) {
    body = bytesToBlob(req.body)
  } else if (typeof req.body === 'string') {
    body = req.body
  } else if (req.body && typeof req.body === 'object') {
    body = JSON.stringify(req.body)
    if (!headers.has('content-type')) headers.set('content-type', 'application/json')
  } else {
    body = bytesToBlob(await readNodeBody(req))
  }
  return new Request(url, { method, headers, body })
}

export async function writeWebResponse(res: NodeResponse, response: Response) {
  res.statusCode = response.status
  response.headers.forEach((value, key) => {
    if (key === 'transfer-encoding' || key === 'content-length') return
    res.setHeader(key, value)
  })
  const bytes = Buffer.from(await response.arrayBuffer())
  res.end(bytes)
}

async function readNodeBody(req: NodeRequest): Promise<Uint8Array> {
  if (!req[Symbol.asyncIterator]) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Uint8Array | string>) {
    const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk
    size += bytes.byteLength
    if (size > BODY_LIMIT) throw new HttpError(413, 'Request body is too large.')
    chunks.push(bytes)
  }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

function bytesToBlob(bytes: Uint8Array): Blob {
  const copy = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(copy).set(bytes)
  return new Blob([copy])
}

function isNodeResponse(value: unknown): value is NodeResponse {
  return Boolean(
    value
    && typeof value === 'object'
    && 'statusCode' in value
    && typeof (value as NodeResponse).setHeader === 'function'
    && typeof (value as NodeResponse).end === 'function',
  )
}
