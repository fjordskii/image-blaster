import { HttpError } from '../../src/server/httpError.js'

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

export async function readJson(request: Request): Promise<unknown> {
  const advertised = Number(request.headers.get('content-length') || 0)
  if (advertised > 4_500_000) throw new HttpError(413, 'Request body is too large.')
  const text = await request.text()
  if (text.length > 4_500_000) throw new HttpError(413, 'Request body is too large.')
  if (!text.trim()) throw new HttpError(400, 'Expected JSON.')
  try {
    return JSON.parse(text)
  } catch {
    throw new HttpError(400, 'Expected JSON.')
  }
}
