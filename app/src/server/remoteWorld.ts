import type { World, WorldEntry } from '../types/world'
import { HttpError } from './httpError'

export const MARBLE_ENDPOINT = 'https://api.worldlabs.ai/marble/v1'
export const MARBLE_MODEL = 'marble-1.1'
export const MAX_IMAGE_BYTES = 2_500_000
export const MAX_IMAGE_BASE64_CHARS = 3_400_000
export const MAX_ASSET_BYTES = 120 * 1024 * 1024
export const MAX_ASSET_ATTEMPTS = 5
export const MAX_STARTS_PER_HOUR = 6
export const MAX_CONCURRENT_JOBS = 2

const RESERVED_SLUGS = new Set(['api', 'assets', 'worlds', 'butterfly'])
const IMAGE_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

export interface RemoteEnv {
  worldLabsApiKey?: string
  blobToken?: string
  gateSecret?: string
}

export interface PlannedAsset {
  id: string
  sourceUrl: string
  pathname: string
  contentType: string
  blobUrl?: string
  skipped?: boolean
  attempts?: number
  error?: string
}

export type JobStatus = 'running' | 'persisting' | 'completed' | 'failed'

export interface JobRecord {
  operationId: string
  slug: string
  displayName: string
  prompt?: string
  sourceImageUrl: string
  status: JobStatus
  createdAt: string
  updatedAt: string
  error?: string
  worldResponse?: unknown
  assets?: PlannedAsset[]
  entry?: WorldEntry
}

export interface ClientJob {
  operationId: string
  slug: string
  displayName: string
  status: JobStatus
  progress?: {
    done: number
    total: number
    current?: string
  }
  error?: string
  entry?: WorldEntry
}

export function gateMatches(provided: string | null | undefined, expected: string | null | undefined): boolean {
  if (!expected || !provided) return false
  const length = Math.max(provided.length, expected.length)
  let mismatch = provided.length === expected.length ? 0 : 1
  for (let index = 0; index < length; index += 1) {
    mismatch |= (provided.charCodeAt(index) || 0) ^ (expected.charCodeAt(index) || 0)
  }
  return mismatch === 0
}

export function authorize(
  gateHeader: string | undefined,
  env: RemoteEnv,
  needs: { worldLabs?: boolean; blob?: boolean } = {},
) {
  if (!env.gateSecret) throw new HttpError(503, 'Remote generation is not configured.')
  if (!gateMatches(gateHeader, env.gateSecret)) throw new HttpError(401, 'Unauthorized.')
  const missing: string[] = []
  if (needs.worldLabs && !env.worldLabsApiKey) missing.push('WORLD_LABS_API_KEY')
  if (needs.blob && !env.blobToken) missing.push('BLOB_READ_WRITE_TOKEN')
  if (missing.length) throw new HttpError(503, `Remote generation is missing ${missing.join(', ')}.`)
}

export function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

export function withSlugSuffix(slug: string, suffix: string): string {
  const extra = `-${suffix}`
  return `${slug.slice(0, Math.max(1, 48 - extra.length))}${extra}`
}

export function slugFromName(value: unknown, suffix: string): { slug: string; displayName: string } {
  const raw = typeof value === 'string' ? value.trim().slice(0, 80) : ''
  const displayName = raw || 'Untitled world'
  let slug = slugify(raw) || `world-${suffix}`
  if (RESERVED_SLUGS.has(slug)) slug = withSlugSuffix('world', suffix)
  return { slug, displayName }
}

export function cleanPrompt(value: unknown): string | undefined {
  if (value == null || value === '') return undefined
  if (typeof value !== 'string') throw new HttpError(400, 'Prompt must be text.')
  const trimmed = value.trim()
  if (!trimmed) return undefined
  if (trimmed.length > 2000) throw new HttpError(400, 'Prompt is too long.')
  return trimmed
}

export interface DecodedImage {
  bytes: Uint8Array
  base64: string
  mimeType: string
  extension: string
}

export function decodeImagePayload(input: unknown): DecodedImage {
  if (!input || typeof input !== 'object') throw new HttpError(400, 'Expected an image upload.')
  const record = input as Record<string, unknown>
  const mimeType = typeof record.mimeType === 'string' ? record.mimeType.toLowerCase() : ''
  const extension = IMAGE_TYPES[mimeType]
  if (!extension) throw new HttpError(400, 'Use a JPEG, PNG, or WebP image.')
  if (typeof record.imageBase64 !== 'string' || !record.imageBase64.trim()) {
    throw new HttpError(400, 'Expected an image upload.')
  }
  const base64 = record.imageBase64.replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '')
  if (base64.length > MAX_IMAGE_BASE64_CHARS) throw new HttpError(413, 'Image is too large. Try a smaller photo.')
  const bytes = new Uint8Array(Buffer.from(base64, 'base64'))
  if (!bytes.byteLength || bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new HttpError(413, 'Image is too large. Try a smaller photo.')
  }
  if (!matchesMagic(bytes, mimeType)) throw new HttpError(400, 'Image file does not match its type.')
  return { bytes, base64, mimeType, extension }
}

function matchesMagic(bytes: Uint8Array, mimeType: string): boolean {
  if (mimeType === 'image/jpeg') {
    return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  }
  if (mimeType === 'image/png') {
    return bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
  }
  if (mimeType === 'image/webp') {
    return bytes.length > 12
      && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
      && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  }
  return false
}

export function buildWorldLabsRequest(input: {
  displayName: string
  prompt?: string
  image: DecodedImage
}) {
  return {
    display_name: input.displayName,
    model: MARBLE_MODEL,
    world_prompt: {
      type: 'image',
      image_prompt: {
        source: 'data_base64',
        data_base64: input.image.base64,
        extension: input.image.extension,
        mime_type: input.image.mimeType,
      },
      ...(input.prompt ? { text_prompt: input.prompt } : {}),
    },
  }
}

export function readOperationId(operation: unknown): string {
  const record = asRecord(operation)
  const raw = record?.operation_id || record?.id || record?.name
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new HttpError(502, 'World Labs did not return an operation id.')
  }
  const parts = raw.split('/')
  const id = parts[parts.length - 1] ?? ''
  if (!isSafeOperationId(id)) throw new HttpError(502, 'World Labs returned an unexpected operation id.')
  return id
}

export function isSafeOperationId(value: string): boolean {
  return /^[A-Za-z0-9._-]{1,200}$/.test(value) && !value.includes('..')
}

export function operationDone(operation: unknown): boolean {
  return Boolean(asRecord(operation)?.done)
}

export function operationErrorMessage(operation: unknown): string | undefined {
  const error = asRecord(operation)?.error
  if (!error) return undefined
  if (typeof error === 'string' && error.trim()) return error.trim().slice(0, 500)
  const message = asRecord(error)?.message
  if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 500)
  return 'World Labs generation failed.'
}

export function assertSafeHttpsUrl(value: string) {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Asset URL is invalid.')
  }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Asset URL must be https.')
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (
    host === 'localhost'
    || host.endsWith('.localhost')
    || host.endsWith('.local')
    || host.endsWith('.internal')
    || isPrivateIp(host)
  ) {
    throw new Error('Asset URL host is not allowed.')
  }
}

export function planAssets(slug: string, world: unknown): PlannedAsset[] {
  const assets = asRecord(asRecord(world)?.assets) ?? {}
  const tasks: PlannedAsset[] = []
  const thumbnail = assets.thumbnail_url
  if (typeof thumbnail === 'string') {
    const extension = extensionFromUrl(thumbnail, '.webp')
    tasks.push(asset('thumbnail', thumbnail, `worlds/${slug}/0-world-thumbnail${extension}`, contentTypeFor(extension)))
  }

  const spzUrls = asRecord(asRecord(assets.splats)?.spz_urls) ?? {}
  const fullUrl = firstString(spzUrls.full_res, spzUrls['500k'], spzUrls['150k'], spzUrls['100k'])
  if (fullUrl) {
    tasks.push(asset('spz:full_res', fullUrl, `worlds/${slug}/0-world-full_res.spz`, 'application/octet-stream'))
  }
  for (const [key, url] of Object.entries(spzUrls)) {
    if (typeof url !== 'string' || url === fullUrl || !/^[a-z0-9_]+$/i.test(key)) continue
    tasks.push(asset(`spz:${key}`, url, `worlds/${slug}/0-world-${key}.spz`, 'application/octet-stream'))
  }

  const glb = asRecord(assets.mesh)?.collider_mesh_url
  if (typeof glb === 'string') {
    tasks.push(asset('glb', glb, `worlds/${slug}/0-world.glb`, 'model/gltf-binary'))
  }
  const pano = asRecord(assets.imagery)?.pano_url
  if (typeof pano === 'string') {
    const extension = extensionFromUrl(pano, '.png')
    tasks.push(asset('pano', pano, `worlds/${slug}/0-world-pano${extension}`, contentTypeFor(extension)))
  }
  return tasks
}

export function nextPendingAsset(assets: PlannedAsset[]): PlannedAsset | undefined {
  return assets.find((asset) => !asset.blobUrl && !asset.skipped)
}

export function noteAssetFailure(job: JobRecord, assetId: string, message: string, now: string): JobRecord {
  const assets = (job.assets ?? []).map((asset) => {
    if (asset.id !== assetId) return asset
    const attempts = (asset.attempts ?? 0) + 1
    const failedOut = attempts >= MAX_ASSET_ATTEMPTS
    return {
      ...asset,
      attempts,
      error: message.slice(0, 300),
      skipped: failedOut && asset.id !== 'spz:full_res',
    }
  })
  const splatFailed = assets.some((asset) => (
    asset.id === 'spz:full_res' && !asset.blobUrl && (asset.attempts ?? 0) >= MAX_ASSET_ATTEMPTS
  ))
  if (splatFailed) {
    return {
      ...job,
      assets,
      status: 'failed',
      error: `Could not store the environment splat. ${message}`.slice(0, 500),
      updatedAt: now,
    }
  }
  return { ...job, assets, updatedAt: now }
}

export function startPersist(job: JobRecord, operation: unknown, now: string): JobRecord {
  const response = asRecord(operation)?.response
  if (!response) {
    return { ...job, status: 'failed', error: 'World Labs finished without a world.', updatedAt: now }
  }
  const assets = planAssets(job.slug, response)
  if (!assets.some((asset) => asset.id === 'spz:full_res')) {
    return {
      ...job,
      status: 'failed',
      error: 'World Labs finished without a splat.',
      worldResponse: response,
      updatedAt: now,
    }
  }
  return { ...job, status: 'persisting', worldResponse: response, assets, updatedAt: now }
}

export function buildWorldEntry(input: {
  slug: string
  displayName: string
  prompt?: string
  sourceImageUrl: string
  world: unknown
  urls: { glb: string; pano: string; thumbnail: string; spz: Record<string, string> }
  createdAt: string
  updatedAt: string
}): WorldEntry {
  const world = asRecord(input.world) ?? {}
  const semantics = asRecord(asRecord(asRecord(world.assets)?.splats)?.semantics_metadata) ?? {}
  const stored: World = {
    world_id: typeof world.world_id === 'string' ? world.world_id : input.slug,
    display_name: input.displayName,
    world_marble_url: typeof world.world_marble_url === 'string' ? world.world_marble_url : '',
    tags: Array.isArray(world.tags) ? world.tags.filter((tag): tag is string => typeof tag === 'string') : null,
    world_prompt: worldPromptText(world.world_prompt, input.prompt),
    created_at: typeof world.created_at === 'string' ? world.created_at : input.createdAt,
    updated_at: typeof world.updated_at === 'string' ? world.updated_at : input.updatedAt,
    assets: {
      mesh: { collider_mesh_url: input.urls.glb },
      imagery: { pano_url: input.urls.pano },
      splats: {
        spz_urls: input.urls.spz,
        semantics_metadata: {
          metric_scale_factor: finiteNumber(semantics.metric_scale_factor, 1),
          ground_plane_offset: finiteNumber(semantics.ground_plane_offset, 0),
          flip_y: typeof semantics.flip_y === 'boolean' ? semantics.flip_y : true,
        },
      },
      thumbnail_url: input.urls.thumbnail || input.sourceImageUrl,
      caption: captionText(world, input.prompt, input.displayName),
    },
  }
  const version = {
    index: 0,
    label: 'v0',
    world: stored,
    plateImageUrl: input.sourceImageUrl,
    complete: Boolean(input.urls.spz.full_res),
  }
  return {
    slug: input.slug,
    project: {
      slug: input.slug,
      display_name: input.displayName,
      created_at: input.createdAt,
      updated_at: input.updatedAt,
    },
    world: stored,
    worldVersions: [version],
    objectAssets: [],
    allObjectAssets: [],
    sourceImageUrl: input.sourceImageUrl,
    sourceImageVersions: [{
      url: input.sourceImageUrl,
      label: 'v0',
      fileName: '0-source.jpg',
      index: 0,
    }],
    worldSfxUrls: [],
  }
}

export function assetUrlsFromTasks(assets: PlannedAsset[]) {
  const spz: Record<string, string> = {}
  let glb = ''
  let pano = ''
  let thumbnail = ''
  for (const asset of assets) {
    if (!asset.blobUrl) continue
    if (asset.id === 'glb') glb = asset.blobUrl
    else if (asset.id === 'pano') pano = asset.blobUrl
    else if (asset.id === 'thumbnail') thumbnail = asset.blobUrl
    else if (asset.id.startsWith('spz:')) spz[asset.id.slice(4)] = asset.blobUrl
  }
  return { glb, pano, thumbnail, spz }
}

export function toClientJob(job: JobRecord): ClientJob {
  const assets = job.assets ?? []
  const current = nextPendingAsset(assets)
  return {
    operationId: job.operationId,
    slug: job.slug,
    displayName: job.displayName,
    status: job.status,
    ...(assets.length ? {
      progress: {
        done: assets.filter((asset) => asset.blobUrl || asset.skipped).length,
        total: assets.length,
        ...(current ? { current: current.id } : {}),
      },
    } : {}),
    ...(job.error ? { error: job.error } : {}),
    ...(job.status === 'completed' && job.entry ? { entry: job.entry } : {}),
  }
}

export function isWorldEntry(value: unknown): value is WorldEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as WorldEntry
  return typeof entry.slug === 'string'
    && Boolean(entry.project)
    && Array.isArray(entry.worldVersions)
    && Array.isArray(entry.objectAssets)
    && Array.isArray(entry.allObjectAssets)
    && Array.isArray(entry.worldSfxUrls)
}

function asset(id: string, sourceUrl: string, pathname: string, contentType: string): PlannedAsset {
  return { id, sourceUrl, pathname, contentType }
}

function extensionFromUrl(url: string, fallback: string): string {
  try {
    const match = new URL(url).pathname.match(/(\.[a-z0-9]+)$/i)
    return match ? match[1].toLowerCase() : fallback
  } catch {
    return fallback
  }
}

function contentTypeFor(extension: string): string {
  if (extension === '.png') return 'image/png'
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg'
  if (extension === '.webp') return 'image/webp'
  return 'application/octet-stream'
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0)
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function worldPromptText(value: unknown, fallback?: string): string | null {
  if (typeof value === 'string' && value.trim()) return value
  const text = asRecord(value)?.text_prompt
  if (typeof text === 'string' && text.trim()) return text
  return fallback ?? null
}

function captionText(world: Record<string, unknown>, prompt: string | undefined, displayName: string): string {
  const caption = asRecord(world.assets)?.caption
  if (typeof caption === 'string' && caption.trim()) return caption
  return prompt || displayName
}

function isPrivateIp(host: string): boolean {
  if (host.includes(':')) {
    const lower = host.toLowerCase()
    return lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80:')
  }
  const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!match) return false
  const parts = match.slice(1).map(Number)
  if (parts.some((part) => part > 255)) return false
  const [a, b] = parts
  if (a === 10 || a === 127 || a === 0) return true
  if (a === 169 && b === 254) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  return false
}
