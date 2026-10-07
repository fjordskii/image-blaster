import { MARBLE_ENDPOINT, MAX_ASSET_BYTES, assertSafeHttpsUrl } from './remoteWorld'

export async function submitWorld(request: unknown, apiKey: string): Promise<unknown> {
  const response = await fetch(`${MARBLE_ENDPOINT}/worlds:generate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'WLT-Api-Key': apiKey,
    },
    body: JSON.stringify(request),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`World Labs submit failed (${response.status}).`)
  return body
}

export async function pollOperation(operationId: string, apiKey: string): Promise<unknown> {
  const response = await fetch(`${MARBLE_ENDPOINT}/operations/${encodeURIComponent(operationId)}`, {
    headers: { 'WLT-Api-Key': apiKey },
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`World Labs poll failed (${response.status}).`)
  return body
}

export async function downloadAsset(url: string): Promise<{ bytes: Uint8Array }> {
  assertSafeHttpsUrl(url)
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(55_000),
  })
  assertSafeHttpsUrl(response.url)
  if (!response.ok) throw new Error(`Asset download failed (${response.status}).`)
  const advertised = Number(response.headers.get('content-length') || 0)
  if (advertised > MAX_ASSET_BYTES) throw new Error('Asset is too large to store.')
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > MAX_ASSET_BYTES) throw new Error('Asset is too large to store.')
  return { bytes }
}
