import * as fs from 'fs'
import * as path from 'path'

import { allProjectDirs, listSessions } from './discovery'

// Section: Models in use
// Every model name Claude Code recorded on a reply, across all projects and their subagents, with
// how many sessions used it and when last. Runs when the configure tab opens, off the poll; a file
// is re-read only when it changed since the last scan.
export type ModelUse = { name: string; sessions: number; lastSeen: number }

const MAX_SESSIONS = 400
const scanned = new Map<string, { mtimeMs: number; models: Map<string, number> }>()

export async function modelsInUse(root: string): Promise<ModelUse[]> {
  const out = new Map<string, ModelUse>()
  for (const s of listSessions(allProjectDirs(root)).slice(0, MAX_SESSIONS)) {
    const models = new Map<string, number>()
    for (const file of [s.file, ...(await subagentFiles(s.file))]) {
      for (const [name, ts] of await modelsIn(file)) models.set(name, Math.max(models.get(name) ?? 0, ts))
    }
    for (const [name, ts] of models) {
      const m = out.get(name) ?? { name, sessions: 0, lastSeen: 0 }
      m.sessions += 1
      m.lastSeen = Math.max(m.lastSeen, ts)
      out.set(name, m)
    }
  }
  return [...out.values()].sort((a, b) => b.lastSeen - a.lastSeen)
}

async function subagentFiles(file: string): Promise<string[]> {
  const dir = path.join(path.dirname(file), path.basename(file, '.jsonl'), 'subagents')
  try {
    return (await fs.promises.readdir(dir)).filter(n => n.endsWith('.jsonl')).map(n => path.join(dir, n))
  } catch {
    return []
  }
}

// Model name → latest timestamp, from assistant records only (tool inputs can carry a "model" too).
async function modelsIn(file: string): Promise<Map<string, number>> {
  let mtimeMs: number
  try {
    mtimeMs = (await fs.promises.stat(file)).mtimeMs
  } catch {
    return new Map()
  }
  const hit = scanned.get(file)
  if (hit?.mtimeMs === mtimeMs) return hit.models
  const models = new Map<string, number>()
  let text = ''
  try {
    text = await fs.promises.readFile(file, 'utf8')
  } catch {
    // removed between list and read
  }
  for (const line of text.split('\n')) {
    if (!line.includes('"type":"assistant"')) continue
    try {
      const rec = JSON.parse(line)
      const name = rec.message?.model
      if (rec.type !== 'assistant' || typeof name !== 'string' || !name || name === '<synthetic>') continue
      const ts = Date.parse(rec.timestamp) || mtimeMs
      models.set(name, Math.max(models.get(name) ?? 0, ts))
    } catch {
      // a line another process is still writing
    }
  }
  scanned.set(file, { mtimeMs, models })
  return models
}
