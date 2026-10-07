import type { WorldEntry } from '../types/world'

export const GATE_SECRET_STORAGE_KEY = 'image-blaster.gate-secret'
export const ACTIVE_JOB_STORAGE_KEY = 'image-blaster.active-job'

export type RemoteJobStatus = 'running' | 'persisting' | 'completed' | 'failed'

export interface RemoteJob {
  operationId: string
  slug: string
  displayName?: string
  status: RemoteJobStatus
  progress?: {
    done: number
    total: number
    current?: string
  }
  error?: string
  entry?: WorldEntry
}

export class RemoteApiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'RemoteApiError'
    this.status = status
  }
}

export function readGateSecret(): string {
  if (typeof window === 'undefined') return ''
  return window.localStorage.getItem(GATE_SECRET_STORAGE_KEY)?.trim() ?? ''
}

export function writeGateSecret(secret: string) {
  if (typeof window === 'undefined') return
  const trimmed = secret.trim()
  if (!trimmed) window.localStorage.removeItem(GATE_SECRET_STORAGE_KEY)
  else window.localStorage.setItem(GATE_SECRET_STORAGE_KEY, trimmed)
}

export async function fetchRemoteWorldEntries(): Promise<WorldEntry[]> {
  const state = await listRemoteState()
  return state?.worlds ?? []
}

export async function listRemoteState(): Promise<{ worlds: WorldEntry[], jobs: RemoteJob[] } | null> {
  const secret = readGateSecret()
  if (!secret) return null
  try {
    const body = await apiRequest<{ worlds?: WorldEntry[], jobs?: RemoteJob[] }>('/api/worlds', secret)
    return {
      worlds: Array.isArray(body.worlds) ? body.worlds : [],
      jobs: Array.isArray(body.jobs) ? body.jobs : [],
    }
  } catch (error) {
    if (!(error instanceof RemoteApiError && (error.status === 401 || error.status === 503))) {
      console.warn('Could not load remote worlds.', error)
    }
    return { worlds: [], jobs: [] }
  }
}

export async function startGeneration(input: {
  secret: string
  name: string
  prompt: string
  imageBase64: string
  mimeType: string
}): Promise<RemoteJob> {
  return apiRequest<RemoteJob>('/api/generate', input.secret, {
    method: 'POST',
    body: JSON.stringify({
      name: input.name,
      prompt: input.prompt,
      imageBase64: input.imageBase64,
      mimeType: input.mimeType,
    }),
  })
}

export async function pollGeneration(operationId: string, secret = readGateSecret()): Promise<RemoteJob> {
  const params = new URLSearchParams({ operationId })
  return apiRequest<RemoteJob>(`/api/generate?${params.toString()}`, secret)
}

export async function compressImageFile(file: File): Promise<{ base64: string, mimeType: string }> {
  const maxBytes = 2_400_000
  const bitmap = await createImageBitmap(file)
  try {
    let edge = 1600
    let quality = 0.86
    let blob: Blob | null = null
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height, 1))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(bitmap.width * scale))
      canvas.height = Math.max(1, Math.round(bitmap.height * scale))
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Could not read that image.')
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
      blob = await new Promise((resolve) => canvas.toBlob((value) => resolve(value), 'image/jpeg', quality))
      if (blob && blob.size <= maxBytes) break
      edge = Math.round(edge * 0.8)
      quality = Math.max(0.55, quality - 0.08)
    }
    if (!blob || blob.size > maxBytes) throw new Error('That image is still too large after compression.')
    return { base64: bytesToBase64(new Uint8Array(await blob.arrayBuffer())), mimeType: 'image/jpeg' }
  } finally {
    bitmap.close()
  }
}

async function apiRequest<T>(path: string, secret: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    cache: 'no-store',
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      'x-blast-secret': secret,
      ...(init.headers ?? {}),
    },
  })
  const body = await response.json().catch(() => ({})) as { error?: string }
  if (!response.ok) {
    const message = body.error || (response.status === 401 ? 'That gate secret was rejected.' : 'Remote generation failed.')
    throw new RemoteApiError(message, response.status)
  }
  return body as T
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
  }
  return btoa(binary)
}
