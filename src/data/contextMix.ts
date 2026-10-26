import * as path from 'path'

// Section: Parts
// What the context is made of, in the order the panel stacks them.
export const PARTS = ['overhead', 'you', 'replies', 'thinking', 'md', 'scripts', 'sql', 'otherFiles', 'commands', 'skills'] as const
export type Part = (typeof PARTS)[number]
export type MixPart = { part: Part; tokens: number }

// Scripts include web front-end files; the 'sql' part also holds tabular data files.
const SCRIPT_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.ipynb', '.ps1', '.psm1', '.sh', '.bash', '.bat', '.cmd',
  '.go', '.rs', '.java', '.cs', '.rb', '.php', '.r', '.jl', '.kt', '.swift', '.c', '.cpp', '.h', '.scala', '.lua',
  '.html', '.htm', '.css', '.scss', '.sass', '.less', '.vue', '.svelte', '.astro',
])
const DATA_EXT = new Set(['.sql', '.csv', '.tsv', '.xlsx', '.xls', '.xlsm', '.parquet'])
const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const AGENT_TOOLS = new Set(['Skill', 'Agent', 'Task'])
const CHARS_PER_TOKEN = 3.5
// A non-text block of unknown kind, in characters (roughly 1.5k tokens).
const MEDIA_CHARS = 5_000

export function fileKind(file: string): Part {
  const ext = path.extname(file).toLowerCase()
  if (ext === '.md' || ext === '.mdx' || ext === '.markdown') return 'md'
  if (DATA_EXT.has(ext)) return 'sql'
  return SCRIPT_EXT.has(ext) ? 'scripts' : 'otherFiles'
}

// Characters of text in a content value; images and PDFs are counted apart, in tokens.
function size(content: unknown): number {
  if (typeof content === 'string') return content.length
  if (!Array.isArray(content)) return content ? JSON.stringify(content).length : 0
  return content.reduce((n, b) => n + (b?.type === 'text' ? (b.text?.length ?? 0) : isTokenBlock(b) ? 0 : MEDIA_CHARS), 0)
}

function isTokenBlock(b: any): boolean {
  return b?.type === 'tool_result' || b?.type === 'image' || b?.type === 'document'
}

// Section: Images and PDFs
// Claude's image cost: width × height / 750 tokens, after downscaling to a 1568px long edge and ~1.15MP.
// A PDF page is sent as its text plus an image of the page: about 1.5–3k tokens, so 2.25k a page.
const IMAGE_MAX_TOKENS = 1_600
const PDF_PAGE_TOKENS = 2_250

function mediaTokens(content: unknown): number {
  if (!Array.isArray(content)) return 0
  return content.reduce((n, b) => n + (b?.type === 'image' ? oneImage(b.source) : b?.type === 'document' ? oneDocument(b.source) : 0), 0)
}

function oneDocument(source: any): number {
  if (source?.type === 'text' && typeof source.data === 'string') return source.data.length / CHARS_PER_TOKEN
  if (typeof source?.data !== 'string') return PDF_PAGE_TOKENS
  return Math.max(1, pdfPages(Buffer.from(source.data, 'base64'))) * PDF_PAGE_TOKENS
}

// Page objects in a PDF ("/Type /Page", not "/Pages").
export function pdfPages(b: Buffer): number {
  return (b.toString('latin1').match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length
}

function oneImage(source: any): number {
  const dims = typeof source?.data === 'string' ? imageSize(Buffer.from(source.data.slice(0, 100_000), 'base64')) : undefined
  if (!dims) return IMAGE_MAX_TOKENS
  const [w, h] = dims
  const s = Math.min(1, 1568 / Math.max(w, h), Math.sqrt(1_150_000 / (w * h)))
  return Math.min(IMAGE_MAX_TOKENS, Math.ceil((w * s * h * s) / 750))
}

// Width and height from a PNG, GIF, JPEG or WebP header.
export function imageSize(b: Buffer): [number, number] | undefined {
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47) return [b.readUInt32BE(16), b.readUInt32BE(20)]
  if (b.length >= 10 && b.toString('ascii', 0, 3) === 'GIF') return [b.readUInt16LE(6), b.readUInt16LE(8)]
  if (b.length >= 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const kind = b.toString('ascii', 12, 16)
    if (kind === 'VP8X') return [1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3)]
    if (kind === 'VP8L') return [1 + (b.readUInt16LE(21) & 0x3fff), 1 + ((b.readUInt32LE(21) >> 14) & 0x3fff)]
    if (kind === 'VP8 ') return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff]
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    // Walk JPEG segments to the first start-of-frame marker.
    let i = 2
    while (i + 9 < b.length && b[i] === 0xff) {
      const marker = b[i + 1]!
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)]
      }
      i += 2 + b.readUInt16BE(i + 2)
    }
  }
  return undefined
}

function text(content: unknown): string {
  if (typeof content === 'string') return content
  return Array.isArray(content) ? content.map(b => (typeof b?.text === 'string' ? b.text : '')).join('') : ''
}

// Section: Labels
// What each item is called in the detail view.
const ATTACHMENT_NAMES: Record<string, string> = {
  instructions: 'CLAUDE.md and other instructions',
  skill_listing: 'Skill listing',
  deferred_tools_delta: 'Deferred tool list',
  deferred_tools_record: 'Deferred tool list',
  agent_listing_delta: 'Agent listing',
  mcp_instructions_delta: 'MCP server instructions',
  environment: 'Environment and git status',
  total_tokens_reminder: 'Token budget reminders',
  hook_success: 'Hook output',
  session_context: 'Session context',
}

function oneLine(s: string, max = 90): string {
  const line = s.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

function toolLabel(name: string, input: any): string {
  if (FILE_TOOLS.has(name)) return String(input.file_path ?? input.notebook_path ?? name)
  if (name === 'Skill') return `Skill: ${input.skill ?? '?'}`
  if (name === 'Agent' || name === 'Task') return `Agent: ${oneLine(String(input.description ?? input.subagent_type ?? '?'), 70)}`
  if (name === 'ToolSearch') return `Tool search: ${oneLine(String(input.query ?? ''), 60)}`
  const arg = input.command ?? input.pattern ?? input.url ?? input.query ?? input.description
  return typeof arg === 'string' ? `${name}: ${oneLine(arg)}` : name
}

// Section: Context mix
// Sorts the main thread's transcript records into items (a file, a command, a skill...) under each
// part, by size in characters, then scales them to the real context size. Overhead is the logged
// system prompt + tool definitions plus attachments; thinking is not stored as text, so it is output
// tokens minus the visible reply. Images and PDFs are already in tokens, so they and thinking sit
// outside the scaling.
export type MixItem = { part: Part; label: string; tokens: number; count: number }
// What tools/handoff/handoff.py would write: typed messages, Claude's last reply per turn, files touched.
export type HandoffInputs = { turns: number; promptChars: number; replyChars: number; changed: string[]; read: string[] }
type Item = { part: Part; label: string; chars: number; media: number; count: number }

export class ContextMix {
  private items = new Map<string, Item>()
  private shapeItems: Item[] = []
  private snapshotItem: Item | undefined
  private readonly tools = new Map<string, { name: string; file: string; label: string }>()
  private replies = new Map<string, { output: number; visible: number; turn: number }>()
  private readonly seen = new Set<string>()
  private turn = 0
  // Handoff inputs cover the whole session, so /compact does not reset them.
  private promptChars = 0
  private readonly finalReply = new Map<number, number>()
  private readonly changed = new Set<string>()
  private readonly read = new Set<string>()

  ingest(rec: any): void {
    if (rec.uuid) {
      if (this.seen.has(rec.uuid)) return
      this.seen.add(rec.uuid)
    }
    switch (rec.type) {
      case 'api-request-shape':
        return this.shape(rec.shape ?? {})
      case 'attachment':
        return this.attachment(rec.attachment ?? {})
      case 'system':
        if (rec.subtype === 'compact_boundary') this.compacted()
        return
      case 'user':
        return this.user(rec)
      case 'assistant':
        return this.assistant(rec.message)
    }
  }

  // Parts in tokens, scaled so they add up to the context size.
  parts(contextTokens: number): MixPart[] {
    if (contextTokens <= 0) return []
    const totals = Object.fromEntries(PARTS.map(p => [p, 0])) as Record<Part, number>
    for (const i of this.details(contextTokens)) totals[i.part] += i.tokens
    return PARTS.map(part => ({ part, tokens: totals[part] }))
  }

  // Every item in tokens (optionally one part's), largest first.
  details(contextTokens: number, part?: Part): MixItem[] {
    if (contextTokens <= 0) return []
    const thinking = this.thinkingByTurn()
    const thinkingTotal = [...thinking.values()].reduce((a, b) => a + b, 0)
    const all = this.allItems()
    const media = all.reduce((n, i) => n + i.media, 0)
    // Thinking and media are estimates too; if they overshoot the context, shrink them to fit.
    const fit = Math.min(1, contextTokens / (thinkingTotal + media || 1))
    const chars = all.reduce((n, i) => n + i.chars, 0)
    const scale = chars > 0 ? Math.max(0, contextTokens - (thinkingTotal + media) * fit) / chars : 0
    const out: MixItem[] = all.map(i => ({ part: i.part, label: i.label, count: i.count, tokens: i.chars * scale + i.media * fit }))
    for (const [turn, t] of thinking) out.push({ part: 'thinking', label: `Turn ${turn}`, count: 1, tokens: t * fit })
    return out.filter(i => (!part || i.part === part) && i.tokens > 0).sort((a, b) => b.tokens - a.tokens)
  }

  handoffInputs(): HandoffInputs {
    return {
      turns: this.turn,
      promptChars: this.promptChars,
      replyChars: [...this.finalReply.values()].reduce((a, b) => a + b, 0),
      changed: [...this.changed],
      read: [...this.read].filter(f => !this.changed.has(f)),
    }
  }

  private allItems(): Item[] {
    const overhead = this.shapeItems.length ? this.shapeItems : this.snapshotItem ? [this.snapshotItem] : []
    return [...overhead, ...this.items.values()]
  }

  private thinkingByTurn(): Map<number, number> {
    const out = new Map<number, number>()
    for (const r of this.replies.values()) {
      const t = Math.max(0, r.output - r.visible / CHARS_PER_TOKEN)
      if (t > 0) out.set(r.turn, (out.get(r.turn) ?? 0) + t)
    }
    return out
  }

  // Text by its characters, images and PDFs by their tokens; the same part + label adds up.
  private add(part: Part, label: string, content: unknown, count = 1): void {
    const key = `${part}|${label}`
    const item = this.items.get(key) ?? { part, label, chars: 0, media: 0, count: 0 }
    item.chars += size(content)
    item.media += mediaTokens(content)
    item.count += count
    this.items.set(key, item)
  }

  private shape(s: any): void {
    const tools: any[] = Array.isArray(s.tools) ? s.tools : []
    this.shapeItems = [
      { part: 'overhead', label: 'System prompt', chars: size(s.system), media: 0, count: 1 },
      ...tools.map(t => ({
        part: 'overhead' as Part,
        label: `Tool definition: ${t?.name ?? '?'}`,
        chars: JSON.stringify(t).length,
        media: 0,
        count: 1,
      })),
    ]
  }

  private attachment(a: any): void {
    if (a.type === 'prompt_snapshot') {
      this.snapshotItem = { part: 'overhead', label: 'System prompt', chars: size(a.systemPrompt), media: 0, count: 1 }
    } else if (a.type === 'edited_text_file') {
      this.add(fileKind(a.filename ?? ''), a.filename ?? 'Edited file', a.snippet)
    } else if (a.type === 'queued_command') {
      this.add('you', 'Queued messages', JSON.stringify(a))
    } else {
      this.add('overhead', ATTACHMENT_NAMES[a.type] ?? `Reminder: ${a.type ?? '?'}`, JSON.stringify(a))
    }
  }

  private user(rec: any): void {
    const content = rec.message?.content
    if (rec.isCompactSummary) return this.add('overhead', 'Compaction summary', content)
    if (rec.isMeta) {
      const t = text(content).slice(0, 400)
      const tool = rec.sourceToolUseID ? this.tools.get(rec.sourceToolUseID) : undefined
      if (tool) return this.add('skills', tool.label, content, 0)
      if (t.includes('<agent-message')) return this.add('skills', 'Agent reports', content)
      if (t.includes('<task-notification')) return this.add('skills', 'Background task notices', content)
      return this.add('overhead', 'Injected notes', content)
    }
    const isWoken = typeof rec.origin?.kind === 'string' && rec.origin.kind !== 'human'
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []
    let isPrompt = false
    for (const b of blocks) {
      if (b?.type === 'tool_result') this.toolResult(b)
      else if (b?.type === 'text' && b.text?.startsWith('<system-reminder>')) this.add('overhead', 'System reminders in messages', b.text)
      else if (b?.type === 'text' && isWoken) this.add('skills', 'Agent and task messages', b.text)
      else if (b?.type === 'text') {
        if (!isPrompt) this.turn += 1
        isPrompt = true
        this.promptChars += b.text?.length ?? 0
        this.add('you', `Turn ${this.turn}: ${oneLine(b.text ?? '', 70)}`, b.text)
      } else this.add('you', 'Pasted images and documents', [b])
    }
  }

  private toolResult(b: any): void {
    const tool = this.tools.get(b.tool_use_id)
    const part: Part = !tool
      ? 'commands'
      : FILE_TOOLS.has(tool.name)
        ? fileKind(tool.file)
        : AGENT_TOOLS.has(tool.name)
          ? 'skills'
          : tool.name === 'ToolSearch'
            ? 'overhead'
            : 'commands'
    this.add(part, tool?.label ?? 'Unknown tool', b.content)
  }

  private assistant(m: any): void {
    if (!m || m.model === '<synthetic>') return
    let visible = 0
    for (const b of Array.isArray(m.content) ? m.content : []) {
      if (b?.type === 'text') {
        visible += b.text?.length ?? 0
        this.add('replies', 'Reply text', b.text ?? '')
        if (b.text?.trim()) this.finalReply.set(this.turn, b.text.length)
      } else if (b?.type === 'tool_use') {
        const name: string = b.name ?? ''
        const input = b.input ?? {}
        const file = String(input.file_path ?? input.notebook_path ?? '')
        const json = JSON.stringify(input)
        visible += json.length
        const label = toolLabel(name, input)
        if (b.id) this.tools.set(b.id, { name, file, label })
        if (file && WRITE_TOOLS.has(name)) this.changed.add(file)
        else if (file && name === 'Read') this.read.add(file)
        // Written or edited file content counts as that file; other tool calls as the reply.
        if (WRITE_TOOLS.has(name) && file) this.add(fileKind(file), label, json, 0)
        else this.add('replies', `Tool calls: ${name}`, json)
      }
    }
    const id: string | undefined = m.id
    if (!id) return
    const prev = this.replies.get(id)
    this.replies.set(id, {
      output: m.usage?.output_tokens ?? prev?.output ?? 0,
      visible: (prev?.visible ?? 0) + visible,
      turn: prev?.turn ?? this.turn,
    })
  }

  // After /compact the conversation is replaced by its summary; only overhead carries over.
  private compacted(): void {
    this.items = new Map()
    this.replies = new Map()
  }
}
