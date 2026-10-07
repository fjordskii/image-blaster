import worlds from 'virtual:worlds'
import { fetchRemoteWorldEntries } from '../remote/client'
import { type World, type WorldEntry } from '../types/world'

export function loadWorlds(): WorldEntry[] {
  return worlds as WorldEntry[]
}

export function mergeWorldEntries(local: WorldEntry[], remote: WorldEntry[]): WorldEntry[] {
  const localSlugs = new Set(local.map((entry) => entry.slug))
  return [...local, ...remote.filter((entry) => entry.slug && !localSlugs.has(entry.slug))]
}

export async function fetchWorlds(): Promise<WorldEntry[]> {
  const local = import.meta.env.DEV ? await fetchDevWorlds() : loadWorlds()
  return mergeWorldEntries(local, await fetchRemoteWorldEntries())
}

async function fetchDevWorlds(): Promise<WorldEntry[]> {
  const response = await fetch('/__worlds', { cache: 'no-store' })
  if (!response.ok) throw new Error(await response.text())
  return response.json() as Promise<WorldEntry[]>
}

export function loadableAssetUrl(url: string | undefined): string {
  if (!url) return ''
  if (url.startsWith('/worlds/') || url.startsWith('https://')) return url
  return ''
}

export function getSplatUrl(world: World): string {
  return loadableAssetUrl(world.assets.splats.spz_urls.full_res)
}
