import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'

// Vercel runs app/api as native ESM ("type": "module"), so every relative
// import reached from a function must carry an explicit .js extension.
const roots = ['../../api', '.'].map((dir) => path.resolve(__dirname, dir))

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(full)
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [full] : []
  })
}

describe('serverless function imports', () => {
  it('uses explicit .js extensions for relative imports', () => {
    const offenders: string[] = []
    for (const file of roots.flatMap(sourceFiles)) {
      const text = fs.readFileSync(file, 'utf8')
      for (const match of text.matchAll(/from '(\.\.?\/[^']+)'/g)) {
        if (!match[1].endsWith('.js')) offenders.push(`${path.relative(__dirname, file)}: ${match[1]}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('keeps shared helpers out of the function namespace', () => {
    const apiDir = path.resolve(__dirname, '../../api')
    const routes = fs.readdirSync(apiDir).filter((name) => name.endsWith('.ts') && !name.startsWith('_'))
    expect(routes.sort()).toEqual(['blast.ts', 'generate.ts', 'worlds.ts'])
  })
})
