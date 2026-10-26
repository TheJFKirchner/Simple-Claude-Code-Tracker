import { cardFor, modelInfo, promptTokens } from '../data/pricing'
import type { Request, Thread } from '../data/transcript'
import type { CacheState } from './types'
import { sumRequests, turnRequests } from './usage'

// Section: TTL
// The cache lifetime a request wrote with: 1h when it wrote 1h tokens, else 5m.
export const HOUR = 3_600_000
export const FIVE_MIN = 300_000

export function ttlOf(r: Request | undefined, fallback = HOUR): number {
  if (!r) return fallback
  if (r.usage.write1h > 0) return HOUR
  if (r.usage.write5m > 0) return FIVE_MIN
  return fallback
}

// Section: Next-turn estimate
// Each request in a turn re-reads the whole context (P, growing by W per request),
// writes W new tokens (tool results, the new message) and generates O. Shape (N, W, O)
// comes from recent turns; size (P) is the context now, so old, smaller turns don't drag it down.
export function turnCost(P: number, N: number, W: number, O: number, read: number, write: number, out: number, isCold: boolean): number {
  const reads = N * P * read + (read * W * N * (N - 1)) / 2
  const firstFix = isCold ? P * (write - read) : 0
  return (reads + firstFix + N * W * write + N * O * out) / 1e6
}

export function cacheState(main: Thread): CacheState | null {
  const reqs = [...main.requests.values()]
  const last = reqs[reqs.length - 1]
  if (!last) return null

  const lastWrite = [...reqs].reverse().find(r => r.usage.write1h + r.usage.write5m > 0)
  const ttlMs = ttlOf(lastWrite)

  const P = promptTokens(last.usage) + last.usage.output
  const card = cardFor(modelInfo(last.model), P)
  const write = ttlMs === HOUR ? card.write1h : card.write5m

  // Turn shape from your own recent messages; background wake-ups are not "your next message".
  const recent = main.turns.filter(t => t.requestIds.length > 0 && t.origin === 'human').slice(-5)
  const counts = recent.map(t => t.requestIds.length).sort((a, b) => a - b)
  // The average, not the median: one long turn among short ones is part of the expected cost.
  const N = Math.max(1, Math.round(counts.reduce((s, k) => s + k, 0) / Math.max(1, counts.length)))
  const recentReqs = recent.flatMap(t => turnRequests(main, t.requestIds))
  const n = Math.max(1, recentReqs.length)
  const newTokens = (r: Request) => r.usage.write5m + r.usage.write1h + r.usage.input
  // A request that re-wrote most of its prompt was a cache miss, not growth; left out of W.
  const growth = recentReqs.filter(r => newTokens(r) < 0.5 * promptTokens(r.usage))
  const W = growth.reduce((s, r) => s + newTokens(r), 0) / Math.max(1, growth.length)
  const O = recentReqs.reduce((s, r) => s + r.usage.output, 0) / n

  const lastTurn = recent[recent.length - 1]
  const lastTurnCost = lastTurn ? sumRequests(turnRequests(main, lastTurn.requestIds)).cost.total : null
  const cost = (k: number, isCold = false) => turnCost(P, k, W, O, card.read, write, card.output, isCold)

  return {
    ttlMs,
    lastTs: last.ts,
    expiresAt: last.ts + ttlMs,
    prefixTokens: P,
    requestsPerTurn: N,
    writePerRequest: W,
    outputPerRequest: O,
    turnWarmCost: cost(N),
    turnColdCost: cost(N, true),
    turnLowWarmCost: cost(Math.max(1, counts[0] ?? 1)),
    turnHighWarmCost: cost(Math.max(1, counts[counts.length - 1] ?? 1)),
    quickWarmCost: cost(1),
    recacheCost: (P * (write - card.read)) / 1e6,
    rereadCostPerRequest: (P * card.read) / 1e6,
    lastTurnCost,
  }
}
