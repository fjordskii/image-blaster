import { handleBlast, handleGenerate, handleWorlds } from './_lib/handlers.js'

export async function handleApiRequest(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url)
  if (pathname === '/api/generate') return handleGenerate(request)
  if (pathname === '/api/worlds') return handleWorlds(request)
  if (pathname === '/api/blast') return handleBlast(request)
  return new Response(JSON.stringify({ error: 'Not found.' }), {
    status: 404,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}
