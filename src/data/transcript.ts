import * as fs from 'fs'
import * as path from 'path'

import { ContextMix } from './contextMix'
import type { Usage } from './pricing'

// Section: Types
// One API request (deduped by message id) and one user turn, as read from a transcript.
export type Request = { id: string; ts: number; model: string; version: string; turnIndex: number; usage: Usage }
export type Turn = { index: number; ts: number; origin: string; requestIds: string[]; toolCalls: number }
export type AgentMeta = { agentType: string; description: string; spawnDepth: number }

// Section: File tail
// Reads only the bytes appended since the last read, cut at the last full line.
export class FileTail {
  private offset = 0
  mtimeMs = 0

  constructor(readonly file: string) {}

  read(): { records: any[]; isReset: boolean } {
    let stat: fs.Stats
    try {
      stat = fs.statSync(this.file)
    } catch {
      return { records: [], isReset: false }
    }
    this.mtimeMs = stat.mtimeMs
    const isReset = stat.size < this.offset
    if (isReset) this.offset = 0
    if (stat.size === this.offset) return { records: [], isReset }

    const buf = Buffer.alloc(stat.size - this.offset)
    const fd = fs.openSync(this.file, 'r')
    try {
      fs.readSync(fd, buf, 0, buf.length, this.offset)
    } finally {
      fs.closeSync(fd)
    }
    const end = buf.lastIndexOf(0x0a)
    if (end < 0) return { records: [], isReset }
    this.offset += end + 1

    const records: any[] = []
    for (const line of buf.subarray(0, end + 1).toString('utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        records.push(JSON.parse(line))
      } catch {
        // a line another process is still writing; skipped
      }
    }
    return { records, isReset }
  }
}

// Section: Thread
// Folds one transcript (main loop or one subagent) into requests, turns and tool calls.
function toUsage(u: any): Usage {
  const cc = u.cache_creation
  const write1h = cc?.ephemeral_1h_input_tokens ?? 0
  const write5m = cc ? cc.ephemeral_5m_input_tokens ?? 0 : u.cache_creation_input_tokens ?? 0
  return {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    write5m,
    write1h,
  }
}

function isPrompt(content: unknown): boolean {
  if (typeof content === 'string') return true
  if (!Array.isArray(content)) return false
  return content.some(b => b?.type === 'text') && !content.some(b => b?.type === 'tool_result')
}

export class Thread {
  readonly requests = new Map<string, Request>()
  readonly turns: Turn[] = []
  readonly mix = new ContextMix()
  private readonly toolIds = new Set<string>()
  title = ''
  firstTs = 0
  lastTs = 0

  // A subagent's transcript marks every record as a sidechain; the main one marks none it keeps.
  constructor(private readonly isAgent = false) {}

  get toolCalls(): number {
    return this.toolIds.size
  }

  ingest(rec: any): void {
    if (rec.type === 'ai-title' && typeof rec.aiTitle === 'string') this.title = rec.aiTitle
    if (rec.isSidechain && !this.isAgent) return
    if (!this.isAgent) this.mix.ingest(rec)
    const ts = rec.timestamp ? Date.parse(rec.timestamp) : 0
    if (ts) {
      this.firstTs = this.firstTs || ts
      this.lastTs = Math.max(this.lastTs, ts)
    }

    if (rec.type === 'user' && !rec.isMeta && isPrompt(rec.message?.content)) {
      // origin.kind: 'human', or what woke the session (task-notification, peer, ...)
      const origin = typeof rec.origin?.kind === 'string' ? rec.origin.kind : 'human'
      this.turns.push({ index: this.turns.length + 1, ts, origin, requestIds: [], toolCalls: 0 })
      return
    }
    if (rec.type !== 'assistant') return
    const m = rec.message
    if (!m?.usage || m.model === '<synthetic>') return

    if (this.turns.length === 0) this.turns.push({ index: 1, ts, origin: 'human', requestIds: [], toolCalls: 0 })
    const turn = this.turns[this.turns.length - 1]!
    const id: string = m.id ?? rec.requestId ?? rec.uuid
    const existing = this.requests.get(id)
    if (!existing) turn.requestIds.push(id)
    this.requests.set(id, {
      id,
      ts,
      model: m.model ?? '',
      version: rec.version ?? '',
      turnIndex: existing?.turnIndex ?? turn.index,
      usage: toUsage(m.usage),
    })

    for (const b of Array.isArray(m.content) ? m.content : []) {
      if (b?.type === 'tool_use' && b.id && !this.toolIds.has(b.id)) {
        this.toolIds.add(b.id)
        turn.toolCalls += 1
      }
    }
  }
}

// Section: Session
// The main transcript plus every subagent transcript beside it, read incrementally.
export type AgentThread = { file: string; meta: AgentMeta; tail: FileTail; thread: Thread }

export class Session {
  readonly id: string
  main = new Thread()
  private mainTail: FileTail
  readonly agents = new Map<string, AgentThread>()

  constructor(readonly file: string) {
    this.id = path.basename(file, '.jsonl')
    this.mainTail = new FileTail(file)
  }

  get mainWriteMs(): number {
    return this.mainTail.mtimeMs
  }

  // Returns whether anything new was read.
  refresh(): boolean {
    let isChanged = false
    const main = this.mainTail.read()
    if (main.isReset) {
      this.main = new Thread()
      isChanged = true
    }
    for (const r of main.records) this.main.ingest(r)
    isChanged ||= main.records.length > 0

    const dir = path.join(path.dirname(this.file), this.id, 'subagents')
    let names: string[] = []
    try {
      names = fs.readdirSync(dir).filter(n => n.endsWith('.jsonl'))
    } catch {
      // no subagents yet
    }
    for (const name of names) {
      const file = path.join(dir, name)
      let a = this.agents.get(file)
      if (!a) {
        a = { file, meta: readMeta(file), tail: new FileTail(file), thread: new Thread(true) }
        this.agents.set(file, a)
        isChanged = true
      }
      const got = a.tail.read()
      if (got.isReset) a.thread = new Thread(true)
      for (const r of got.records) a.thread.ingest(r)
      isChanged ||= got.records.length > 0 || got.isReset
    }
    return isChanged
  }
}

function readMeta(jsonl: string): AgentMeta {
  try {
    const m = JSON.parse(fs.readFileSync(jsonl.replace(/\.jsonl$/, '.meta.json'), 'utf8'))
    return {
      agentType: m.agentType ?? 'agent',
      description: m.description ?? '',
      spawnDepth: typeof m.spawnDepth === 'number' ? m.spawnDepth : 1,
    }
  } catch {
    return { agentType: 'agent', description: '', spawnDepth: 1 }
  }
}
