import { advanceWorldJob, errorResult, listRemoteWorlds, startWorldJob } from '../../src/server/generateService'
import { authorize } from '../../src/server/remoteWorld'
import { createDeps } from './context'
import { json, readJson } from './http'

const BLAST_TODO = [
  'FAL_KEY is optional. Marble world generation does not call FAL.',
  'POST /api/blast is the follow-up hook after a world manifest exists.',
  'Ambience: submit fal-ai/elevenlabs/sound-effects/v2, poll that queue on a later request, store the mp3 in Blob, and append the URL to worldSfxUrls.',
  'Objects: Hunyuan needs one reference image per object. Accept an explicit objects list here. Do not invent objects in this route; the local uncover step is still a Claude skill.',
  'Keep each FAL submit and each download in its own request so a function does not wait for the whole blast.',
]

export async function handleGenerate(request: Request): Promise<Response> {
  const deps = createDeps()
  const gateHeader = request.headers.get('x-blast-secret') ?? undefined
  if (request.method === 'POST') {
    try {
      const body = await readJson(request)
      const result = await startWorldJob({ gateHeader, body }, deps)
      return json(result.status, result.body)
    } catch (error) {
      const result = errorResult(error)
      return json(result.status, result.body)
    }
  }
  if (request.method === 'GET') {
    const operationId = new URL(request.url).searchParams.get('operationId') ?? ''
    const result = await advanceWorldJob({ gateHeader, operationId }, deps)
    return json(result.status, result.body)
  }
  return json(405, { error: 'Method not allowed.' })
}

export async function handleWorlds(request: Request): Promise<Response> {
  if (request.method !== 'GET') return json(405, { error: 'Method not allowed.' })
  const result = await listRemoteWorlds({
    gateHeader: request.headers.get('x-blast-secret') ?? undefined,
  }, createDeps())
  return json(result.status, result.body)
}

export async function handleBlast(request: Request): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'POST') {
    return json(405, { error: 'Method not allowed.' })
  }
  try {
    authorize(request.headers.get('x-blast-secret') ?? undefined, {
      gateSecret: process.env.BLAST_GATE_SECRET,
    })
  } catch (error) {
    const result = errorResult(error)
    return json(result.status, result.body)
  }
  return json(501, {
    error: 'Object meshes and ambient SFX are not generated on the hosted pipeline yet.',
    falRequired: false,
    todo: BLAST_TODO,
  })
}
