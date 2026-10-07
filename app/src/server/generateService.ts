import { HttpError } from './httpError'
import {
  MAX_CONCURRENT_JOBS,
  MAX_STARTS_PER_HOUR,
  type JobRecord,
  type RemoteEnv,
  assetUrlsFromTasks,
  authorize,
  buildWorldEntry,
  buildWorldLabsRequest,
  cleanPrompt,
  decodeImagePayload,
  isSafeOperationId,
  isWorldEntry,
  nextPendingAsset,
  noteAssetFailure,
  operationDone,
  operationErrorMessage,
  readOperationId,
  slugFromName,
  startPersist,
  toClientJob,
  withSlugSuffix,
  assertSafeHttpsUrl,
} from './remoteWorld'

const HOUR_MS = 60 * 60 * 1000

export interface StoredObject {
  pathname: string
  url: string
  uploadedAt: Date
}

export interface RemoteStore {
  putPublic(pathname: string, body: Blob | string, contentType: string): Promise<string>
  getJson<T>(pathname: string): Promise<T | null>
  list(prefix: string): Promise<StoredObject[]>
}

export interface GenerateDeps {
  env: RemoteEnv
  store: RemoteStore
  worldLabs: {
    submit(request: unknown, apiKey: string): Promise<unknown>
    poll(operationId: string, apiKey: string): Promise<unknown>
  }
  download(url: string): Promise<{ bytes: Uint8Array }>
  now(): string
  nowMs(): number
  suffix(): string
}

export interface ApiResult {
  status: number
  body: unknown
}

export async function startWorldJob(
  input: { gateHeader?: string; body: unknown },
  deps: GenerateDeps,
): Promise<ApiResult> {
  try {
    authorize(input.gateHeader, deps.env, { worldLabs: true, blob: true })
    const record = input.body && typeof input.body === 'object' ? input.body as Record<string, unknown> : {}
    const image = decodeImagePayload(record)
    const prompt = cleanPrompt(record.prompt)
    await assertWithinRateLimit(deps)
    const identity = await uniqueSlug(record.name, deps)
    const sourceImageUrl = await deps.store.putPublic(
      `worlds/${identity.slug}/source.${image.extension}`,
      bytesToBlob(image.bytes, image.mimeType),
      image.mimeType,
    )
    const request = buildWorldLabsRequest({
      displayName: identity.displayName,
      prompt,
      image,
    })
    const operation = await deps.worldLabs.submit(request, deps.env.worldLabsApiKey || '')
    const operationId = readOperationId(operation)
    let job: JobRecord = {
      operationId,
      slug: identity.slug,
      displayName: identity.displayName,
      ...(prompt ? { prompt } : {}),
      sourceImageUrl,
      status: 'running',
      createdAt: deps.now(),
      updatedAt: deps.now(),
    }
    const failure = operationErrorMessage(operation)
    if (failure) {
      job = { ...job, status: 'failed', error: failure }
    } else if (operationDone(operation)) {
      job = startPersist(job, operation, deps.now())
    }
    await saveJob(deps, job)
    return { status: 202, body: toClientJob(job) }
  } catch (error) {
    return errorResult(error)
  }
}

export async function advanceWorldJob(
  input: { gateHeader?: string; operationId: string },
  deps: GenerateDeps,
): Promise<ApiResult> {
  try {
    authorize(input.gateHeader, deps.env, { blob: true })
    if (!isSafeOperationId(input.operationId)) throw new HttpError(400, 'Unknown operation.')
    const existing = await deps.store.getJson<JobRecord>(jobPath(input.operationId))
    if (!existing?.operationId) throw new HttpError(404, 'Unknown operation.')
    if (existing.status === 'completed' || existing.status === 'failed') {
      return { status: 200, body: toClientJob(existing) }
    }

    let job = existing
    if (job.status === 'running') {
      if (!deps.env.worldLabsApiKey) {
        throw new HttpError(503, 'Remote generation is missing WORLD_LABS_API_KEY.')
      }
      const operation = await deps.worldLabs.poll(job.operationId, deps.env.worldLabsApiKey)
      const failure = operationErrorMessage(operation)
      if (failure) {
        job = { ...job, status: 'failed', error: failure, updatedAt: deps.now() }
        await saveJob(deps, job)
        return { status: 200, body: toClientJob(job) }
      }
      if (!operationDone(operation)) {
        job = { ...job, updatedAt: deps.now() }
        await saveJob(deps, job)
        return { status: 200, body: toClientJob(job) }
      }
      job = startPersist(job, operation, deps.now())
      if (job.status === 'failed') {
        await saveJob(deps, job)
        return { status: 200, body: toClientJob(job) }
      }
    }

    job = await copyNextAsset(job, deps)
    await saveJob(deps, job)
    return { status: 200, body: toClientJob(job) }
  } catch (error) {
    return errorResult(error)
  }
}

export async function listRemoteWorlds(
  input: { gateHeader?: string },
  deps: GenerateDeps,
): Promise<ApiResult> {
  try {
    authorize(input.gateHeader, deps.env, { blob: true })
    const listed = await deps.store.list('worlds/')
    const manifests = listed.filter((item) => item.pathname.endsWith('/manifest.json'))
    const worlds = []
    for (const item of manifests) {
      const entry = await deps.store.getJson(item.pathname)
      if (isWorldEntry(entry)) worlds.push(entry)
    }
    worlds.sort((a, b) => String(b.project.updated_at || '').localeCompare(String(a.project.updated_at || '')))

    const jobs = []
    const recentJobs = (await deps.store.list('jobs/'))
      .filter((item) => item.pathname.endsWith('.json'))
      .sort((a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime())
      .slice(0, 20)
    for (const item of recentJobs) {
      const job = await deps.store.getJson<JobRecord>(item.pathname)
      if (!job || (job.status !== 'running' && job.status !== 'persisting')) continue
      jobs.push(toClientJob(job))
      if (jobs.length === 3) break
    }
    return { status: 200, body: { worlds, jobs } }
  } catch (error) {
    return errorResult(error)
  }
}

async function assertWithinRateLimit(deps: GenerateDeps) {
  const jobs = (await deps.store.list('jobs/')).filter((item) => item.pathname.endsWith('.json'))
  const recentStarts = jobs.filter((item) => deps.nowMs() - item.uploadedAt.getTime() < HOUR_MS)
  if (recentStarts.length >= MAX_STARTS_PER_HOUR) {
    throw new HttpError(429, 'Too many worlds started this hour.')
  }
  const candidates = jobs
    .filter((item) => deps.nowMs() - item.uploadedAt.getTime() < 6 * HOUR_MS)
    .sort((a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime())
    .slice(0, 10)
  let active = 0
  for (const item of candidates) {
    const job = await deps.store.getJson<JobRecord>(item.pathname)
    if (job?.status === 'running' || job?.status === 'persisting') active += 1
  }
  if (active >= MAX_CONCURRENT_JOBS) {
    throw new HttpError(429, 'Two worlds are already generating. Wait for one to finish.')
  }
}

async function uniqueSlug(name: unknown, deps: GenerateDeps) {
  const suffix = deps.suffix()
  let identity = slugFromName(name, suffix)
  const taken = new Set(
    (await deps.store.list('worlds/'))
      .map((item) => item.pathname.split('/')[1])
      .filter((part): part is string => Boolean(part)),
  )
  if (taken.has(identity.slug)) identity = { ...identity, slug: withSlugSuffix(identity.slug, suffix) }
  return identity
}

async function copyNextAsset(job: JobRecord, deps: GenerateDeps): Promise<JobRecord> {
  const current = nextPendingAsset(job.assets ?? [])
  if (!current) return finishJob(job, deps)
  try {
    assertSafeHttpsUrl(current.sourceUrl)
    const downloaded = await deps.download(current.sourceUrl)
    const url = await deps.store.putPublic(
      current.pathname,
      bytesToBlob(downloaded.bytes, current.contentType),
      current.contentType,
    )
    const assets = (job.assets ?? []).map((asset) => (
      asset.id === current.id ? { ...asset, blobUrl: url, error: undefined } : asset
    ))
    const updated: JobRecord = { ...job, assets, updatedAt: deps.now() }
    if (!nextPendingAsset(assets)) return finishJob(updated, deps)
    return updated
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not store an asset.'
    return noteAssetFailure(job, current.id, message, deps.now())
  }
}

async function finishJob(job: JobRecord, deps: GenerateDeps): Promise<JobRecord> {
  const urls = assetUrlsFromTasks(job.assets ?? [])
  if (!urls.spz.full_res) {
    return { ...job, status: 'failed', error: 'World Labs finished without a splat.', updatedAt: deps.now() }
  }
  const entry = buildWorldEntry({
    slug: job.slug,
    displayName: job.displayName,
    prompt: job.prompt,
    sourceImageUrl: job.sourceImageUrl,
    world: job.worldResponse,
    urls,
    createdAt: job.createdAt,
    updatedAt: deps.now(),
  })
  await deps.store.putPublic(
    `worlds/${job.slug}/manifest.json`,
    JSON.stringify(entry),
    'application/json',
  )
  return { ...job, status: 'completed', entry, updatedAt: deps.now() }
}

async function saveJob(deps: GenerateDeps, job: JobRecord) {
  await deps.store.putPublic(jobPath(job.operationId), JSON.stringify(job), 'application/json')
}

function jobPath(operationId: string) {
  return `jobs/${operationId}.json`
}

function bytesToBlob(bytes: Uint8Array, type: string): Blob {
  const copy = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(copy).set(bytes)
  return new Blob([copy], { type })
}

export function errorResult(error: unknown): ApiResult {
  if (error instanceof HttpError) return { status: error.status, body: { error: error.message } }
  const message = error instanceof Error ? error.message : 'Remote generation failed.'
  if (/Access denied, please provide a valid token/.test(message)) {
    return { status: 503, body: { error: 'BLOB_READ_WRITE_TOKEN was rejected.' } }
  }
  if (/BLOB_READ_WRITE_TOKEN|WORLD_LABS_API_KEY|BLAST_GATE_SECRET|not configured/.test(message)) {
    return { status: 503, body: { error: 'Remote generation is not configured.' } }
  }
  console.error(message)
  return { status: 500, body: { error: message.slice(0, 300) } }
}
