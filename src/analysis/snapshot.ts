import { addCost, hasCustomPrices, modelInfo, promptTokens } from '../data/pricing'
import type { Session } from '../data/transcript'
import { cacheEvents } from './cacheEvents'
import { cacheState } from './estimate'
import { buildFlags } from './flags'
import { handoffEstimate } from './handoff'
import type { Level, Snapshot, Thresholds, TurnBar } from './types'
import { addUsage, sumRequests, threadStats, turnRequests } from './usage'

// Section: Advice
// Context % against the thresholds, raised to level 1 past the fresh-session token mark;
// flags can raise it further, and a dead cache TTL always means "don't send".
export const ADVICE = [
  'Keep going',
  'Think about starting a new session',
  'Wrap up / start a fresh session',
  "Don't send another message unless you really need to",
] as const

export const ADVICE_SHORT = ['Keep going', 'New session?', 'Wrap up', "Don't send"] as const

export function contextLevel(pct: number, tokens: number, t: Thresholds): Level {
  if (pct >= t.stop) return 3
  if (pct >= t.wrapUp) return 2
  if (pct >= t.consider || (t.freshTokens > 0 && tokens >= t.freshTokens)) return 1
  return 0
}

export function isTtlDead(s: Snapshot, now: number): boolean {
  return s.cache !== null && now >= s.cache.expiresAt
}

export function adviceLevel(s: Snapshot, now: number): Level {
  return isTtlDead(s, now) ? 3 : s.baseLevel
}

// Section: Build
// Turns a Session into a Snapshot.
const LIVE_MS = 20_000
const LIVE_TURN_MS = 10 * 60_000

export function buildSnapshot(session: Session, thresholds: Thresholds, windowOverride: number): Snapshot {
  const main = session.main
  const reqs = [...main.requests.values()]
  const last = reqs[reqs.length - 1]
  const model = last?.model ?? ''
  const info = modelInfo(model)
  const window = windowOverride > 0 ? windowOverride : info.window
  const contextTokens = last ? promptTokens(last.usage) + last.usage.output : 0
  const now = Date.now()

  const turns: TurnBar[] = main.turns
    .filter(t => t.requestIds.length > 0)
    .map(t => {
      const tr = turnRequests(main, t.requestIds)
      const end = tr[tr.length - 1]!
      return {
        index: t.index,
        ts: t.ts,
        prompt: promptTokens(end.usage) + end.usage.output,
        cost: sumRequests(tr).cost.total,
        toolCalls: t.toolCalls,
      }
    })

  const agentList = [...session.agents.values()].sort((a, b) => a.thread.firstTs - b.thread.firstTs)
  const agents = agentList.map((a, i) =>
    threadStats(
      a.thread,
      `Agent ${i + 1} · ${a.meta.agentType}`,
      a.meta.description,
      Math.max(1, a.meta.spawnDepth),
      now - a.tail.mtimeMs < LIVE_MS,
    ),
  )
  const mainStats = threadStats(main, 'Main thread', '', 0, now - session.mainWriteMs < LIVE_MS)

  let usage = mainStats.usage
  let cost = mainStats.cost
  let toolCalls = mainStats.toolCalls
  let requests = mainStats.requests
  for (const a of agents) {
    usage = addUsage(usage, a.usage)
    cost = addCost(cost, a.cost)
    toolCalls += a.toolCalls
    requests += a.requests
  }

  const contextPercent = window > 0 ? (contextTokens / window) * 100 : 0
  const ctxLevel = contextLevel(contextPercent, contextTokens, thresholds)
  const rereads = contextTokens > 0 ? mainStats.usage.cacheRead / contextTokens : 0
  const cache = cacheState(main)
  const events = cacheEvents(main)
  const lastTurnBar = turns[turns.length - 1]
  const lastTurn = lastTurnBar
    ? {
        requests: main.turns.find(t => t.index === lastTurnBar.index)?.requestIds.length ?? 0,
        cost: lastTurnBar.cost,
        isLive: !!last && now - last.ts < LIVE_TURN_MS,
      }
    : null
  const flags = buildFlags({
    t: thresholds,
    contextLevel: ctxLevel,
    contextPercent,
    contextTokens,
    rereads,
    cost: cost.total,
    cache,
    events,
    lastTurn,
    main: mainStats,
    agents,
  })
  const baseLevel = Math.max(ctxLevel, ...flags.map(f => f.level)) as Level

  return {
    sessionId: session.id,
    title: main.title,
    model,
    isModelKnown: info.known,
    pricedAs: info.id,
    priceMatch: info.match,
    customPrices: hasCustomPrices(),
    window,
    contextTokens,
    contextPercent,
    contextLevel: ctxLevel,
    contextMix: main.mix.parts(contextTokens),
    rereads,
    baseLevel,
    adviceLabels: [...ADVICE],
    flags,
    thresholds,
    turns,
    main: mainStats,
    agents,
    total: { usage, cost, toolCalls, requests },
    cache,
    cacheEvents: events,
    handoff: handoffEstimate(main, cache, model),
    builtAt: now,
  }
}
