import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// Section: Folders
// Claude Code's config folder and the transcript folder it keeps per workspace.
export function claudeDir(setting: string): string {
  return setting || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
}

export function projectDir(root: string, workspace: string): string | undefined {
  const projects = path.join(root, 'projects')
  const slug = workspace.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()
  try {
    const hit = fs.readdirSync(projects).find(d => d.toLowerCase() === slug)
    return hit ? path.join(projects, hit) : undefined
  } catch {
    return undefined
  }
}

export function allProjectDirs(root: string): string[] {
  const projects = path.join(root, 'projects')
  try {
    return fs.readdirSync(projects).map(d => path.join(projects, d))
  } catch {
    return []
  }
}

// Section: Open conversations
// Claude Code keeps one sessions/<pid>.json per running process with its current session id
// (undocumented; changes on /clear). The one to follow is busy, else the most recently updated.
export type LiveSession = { pid: number; sessionId: string; cwd: string; isBusy: boolean; updatedAt: number }

const samePath = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e: any) {
    return e?.code === 'EPERM'
  }
}

export function liveSessions(root: string, workspaces: string[], alive = isAlive): LiveSession[] {
  const dir = path.join(root, 'sessions')
  const out: LiveSession[] = []
  let names: string[] = []
  try {
    names = fs.readdirSync(dir).filter(n => /^\d+\.json$/.test(n))
  } catch {
    return out
  }
  for (const n of names) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'))
      if (typeof s.sessionId !== 'string' || typeof s.cwd !== 'string' || typeof s.pid !== 'number') continue
      if (!workspaces.some(w => samePath(w, s.cwd)) || !alive(s.pid)) continue
      out.push({
        pid: s.pid,
        sessionId: s.sessionId,
        cwd: s.cwd,
        isBusy: s.status === 'busy',
        updatedAt: Math.max(s.updatedAt ?? 0, s.statusUpdatedAt ?? 0, s.startedAt ?? 0),
      })
    } catch {
      // being rewritten, or not a session file
    }
  }
  return out.sort((a, b) => Number(b.isBusy) - Number(a.isBusy) || b.updatedAt - a.updatedAt)
}

// Where a session's transcript lives (or will, once its first message is sent).
export function transcriptFile(root: string, s: LiveSession): string {
  const dir = projectDir(root, s.cwd) ?? path.join(root, 'projects', s.cwd.replace(/[^a-zA-Z0-9]/g, '-'))
  return path.join(dir, `${s.sessionId}.jsonl`)
}

// Section: Sessions
// Session transcripts in those folders, newest first, with a cheap title lookup.
export type SessionFile = { file: string; mtimeMs: number }

export function listSessions(dirs: string[]): SessionFile[] {
  const out: SessionFile[] = []
  for (const dir of dirs) {
    let names: string[] = []
    try {
      names = fs.readdirSync(dir).filter(n => n.endsWith('.jsonl'))
    } catch {
      continue
    }
    for (const n of names) {
      const file = path.join(dir, n)
      try {
        out.push({ file, mtimeMs: fs.statSync(file).mtimeMs })
      } catch {
        // removed between list and stat
      }
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

// Reads a session's AI title without parsing the whole file into a Thread.
export function quickTitle(file: string): string {
  try {
    const text = fs.readFileSync(file, 'utf8')
    const i = text.lastIndexOf('"type":"ai-title"')
    if (i < 0) return ''
    const start = text.lastIndexOf('\n', i) + 1
    const end = text.indexOf('\n', i)
    return JSON.parse(text.slice(start, end < 0 ? undefined : end)).aiTitle ?? ''
  } catch {
    return ''
  }
}
