import { HOUR } from './estimate'
import { minutes, tok, usd } from './format'
import type { CacheEvent, CacheState, Flag, Level, ThreadStats, Thresholds } from './types'

// Section: Inputs
// What the flags read; built once per snapshot.
export type FlagInput = {
  t: Thresholds
  contextLevel: Level
  contextPercent: number
  contextTokens: number
  rereads: number
  cost: number
  cache: CacheState | null
  events: CacheEvent[]
  lastTurn: { requests: number; cost: number; isLive: boolean } | null
  main: ThreadStats
  agents: ThreadStats[]
}

const RUNAWAY_REQUESTS = 40
const RUNAWAY_COST = 3
const RUNAWAY_STOP_COST = 8
const HEAVY_AGENT_COST = 2
const HEAVY_AGENT_PEAK = 100_000

// Section: Spend and size
// Cost limit, context window, long session, large conversation.
function spendFlags(x: FlagInput): Flag[] {
  const flags: Flag[] = []
  const { t } = x
  const perRequest = x.cache ? usd(x.cache.rereadCostPerRequest) : ''

  if (t.costLimit > 0 && x.cost >= t.costLimit) {
    flags.push({
      id: 'cost-limit',
      level: 3,
      short: `over your ${usd(t.costLimit)} limit`,
      title: 'Over your session cost limit',
      detail: `This session has cost ${usd(x.cost)}; your limit is ${usd(t.costLimit)}.`,
      tip: 'Finish the step you are on, ask Claude for a 3-line summary of where things stand, and start a new session with that summary.',
    })
  }
  if (x.contextLevel >= 2) {
    flags.push({
      id: 'window',
      level: x.contextLevel,
      short: 'almost full',
      title: `Context window ${x.contextPercent.toFixed(0)}% full`,
      detail: 'Claude gets less precise as the window fills, and every request costs more.',
      tip: 'Ask Claude for a short handoff note (what is done, what is next), then start a new session and paste it in.',
    })
  }
  if (t.longSessionRereads > 0 && x.rereads >= t.longSessionRereads) {
    const n = Math.round(x.rereads)
    flags.push({
      id: 'long-session',
      level: 1,
      short: 'long conversation',
      title: `Long session · re-read ${n}×`,
      detail: `Every request re-sends the whole conversation. You have now paid to read it about ${n} times${perRequest ? ` (${perRequest} per request at today's size)` : ''}.`,
      tip: 'Continue only if your next message is on the same topic. New topic? Start a new session or type /clear. It is cheaper, and Claude stays focused.',
    })
  }
  if (t.freshTokens > 0 && x.contextTokens >= t.freshTokens) {
    flags.push({
      id: 'big-context',
      level: 1,
      short: 'large conversation',
      title: `Large conversation · ${tok(x.contextTokens)} tokens`,
      detail: `Each request costs about ${perRequest || 'more'} just to re-read it, before any new work.`,
      tip: 'Same task: keep going, or type /compact to shrink the history. Different task: start a new session.',
    })
  }
  return flags
}

// Section: Cache
// 5-minute countdown, expiry tally, background wake-ups, resets while warm.
function cacheFlags(x: FlagInput): Flag[] {
  const flags: Flag[] = []
  const c = x.cache
  const isFiveMin = !!c && c.ttlMs < HOUR

  if (c && isFiveMin && c.prefixTokens >= 20_000) {
    flags.push({
      id: 'ttl-5m',
      level: 0,
      short: '5-minute timer',
      title: '5-minute cache',
      detail: `Reply before it expires, or the next message re-sends everything at full price (+${usd(c.recacheCost)}).`,
      tip: 'Put follow-up questions into one message and reply within 5 minutes. Before a break, ask Claude to finish up; after a break on a large conversation, start a new session instead.',
      hasCountdown: true,
    })
  }

  const expired = x.events.filter(e => e.kind !== 'warm-reset')
  if (expired.length) {
    const total = expired.reduce((s, e) => s + e.cost, 0)
    const last = expired[expired.length - 1]!
    const lastLine =
      last.kind === 'woke'
        ? `Last one: background work woke the session ${minutes(last.minutesLate)} after it expired (+${usd(last.cost)}).`
        : last.minutesLate < 10
          ? `Last one: you came back just ${minutes(last.minutesLate)} after it expired (+${usd(last.cost)}).`
          : `Last one: you came back ${minutes(last.minutesLate)} after it expired (+${usd(last.cost)}).`
    flags.push({
      id: 'recache-tally',
      level: expired.length >= 2 || total >= 1 ? 1 : 0,
      short: `timer ran out ${expired.length}×`,
      title: `Cache expired ${expired.length}× · ${usd(total)} re-caching`,
      detail: `Each expiry made Claude re-buy the whole conversation. ${lastLine}`,
      tip: isFiveMin
        ? 'Your cache lasts 5 minutes from the last reply. Reply within 5 minutes, or after a break start a new session with a short summary instead of continuing here.'
        : 'Your cache lasts an hour from the last reply. After a longer break, start a new session with a short summary instead of continuing here.',
    })
  }

  const woke = x.events.filter(e => e.kind === 'woke')
  if (woke.length) {
    const total = woke.reduce((s, e) => s + e.cost, 0)
    flags.push({
      id: 'woke-away',
      level: woke.length >= 2 ? 2 : 1,
      short: 'woken while away',
      title: `Background wake-ups after expiry · ${woke.length}×`,
      detail: `Background work (subagents, loops, monitors) finished after the cache expired, and Claude re-sent the whole conversation each time (${usd(total)}).`,
      tip: isFiveMin
        ? 'With a 5-minute cache, wait for background tasks to finish before stepping away, or stop them first (Esc). For short tasks, ask Claude to run subagents in the foreground.'
        : 'Wait for background tasks to finish before stepping away, or stop them first (Esc).',
    })
  }

  const resets = x.events.filter(e => e.kind === 'warm-reset')
  if (resets.length) {
    const total = resets.reduce((s, e) => s + e.cost, 0)
    const cause = resets[resets.length - 1]!.cause
    const why =
      cause === 'model switch'
        ? 'You switched model, and a cache only works for one model.'
        : cause === 'Claude Code update'
          ? 'Claude Code updated mid-session.'
          : 'Something early in the conversation changed (tools, MCP servers or settings).'
    flags.push({
      id: 'warm-reset',
      level: 1,
      short: 'unexpected reset',
      title: `Cache reset while warm · ${resets.length}× · ${usd(total)}`,
      detail: `The cache should still have been valid, but Claude re-sent everything. ${why}`,
      tip: 'Pick your model at the start of a session and avoid adding tools or MCP servers mid-session. For a quick side question on another model, ask for a subagent instead of switching.',
    })
  }
  return flags
}

// Section: Work
// A turn that keeps going, and subagents that cost a lot.
function workFlags(x: FlagInput): Flag[] {
  const flags: Flag[] = []
  const lt = x.lastTurn
  if (lt && lt.isLive && (lt.requests >= RUNAWAY_REQUESTS || lt.cost >= RUNAWAY_COST)) {
    flags.push({
      id: 'runaway',
      level: lt.cost >= RUNAWAY_STOP_COST ? 3 : 2,
      short: 'runaway task',
      title: `Runaway turn · ${lt.requests} steps · ${usd(lt.cost)}`,
      detail: `Claude has made ${lt.requests} requests for your last message.`,
      tip: 'Press Esc to pause it (Esc keeps the cache), check what it is doing, and steer it with a short correction.',
    })
  }

  const agentTotal = x.agents.reduce((s, a) => s + a.cost.total, 0)
  const heavy = x.agents.filter(a => a.cost.total >= HEAVY_AGENT_COST || a.peakPrompt >= HEAVY_AGENT_PEAK)
  const isOverMain = agentTotal > x.main.cost.total && agentTotal >= 1
  if (heavy.length || isOverMain) {
    const worst = [...x.agents].sort((a, b) => b.cost.total - a.cost.total)[0]!
    flags.push({
      id: 'heavy-subagent',
      level: 1,
      short: 'expensive helper',
      title: isOverMain ? `Subagents cost more than the main chat · ${usd(agentTotal)}` : `Heavy subagent · ${worst.label}`,
      detail: `${worst.label} cost ${usd(worst.cost.total)} and grew to ${tok(worst.peakPrompt)} tokens${worst.detail ? ` (${worst.detail})` : ''}.`,
      tip: "Give helpers narrow tasks ('find where X is defined'), and ask for a Sonnet subagent for searching. Each helper starts its own 5-minute cache.",
    })
  }
  return flags
}

// Section: Build
// All flags, most serious first.
export function buildFlags(x: FlagInput): Flag[] {
  return [...spendFlags(x), ...workFlags(x), ...cacheFlags(x)].sort((a, b) => b.level - a.level)
}
