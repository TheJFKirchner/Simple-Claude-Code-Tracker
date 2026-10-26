import { addCost, costOf, promptTokens, ZERO_COST } from '../data/pricing'
import type { CostParts, Usage } from '../data/pricing'
import type { Request, Thread } from '../data/transcript'
import type { ThreadStats } from './types'

// Section: Sums
// Adds requests into usage, cost and peak context.
export const ZERO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, write5m: 0, write1h: 0 }

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    write5m: a.write5m + b.write5m,
    write1h: a.write1h + b.write1h,
  }
}

export function sumRequests(reqs: Iterable<Request>): { usage: Usage; cost: CostParts; peak: number; n: number } {
  let usage = ZERO_USAGE
  let cost = ZERO_COST
  let peak = 0
  let n = 0
  for (const r of reqs) {
    usage = addUsage(usage, r.usage)
    cost = addCost(cost, costOf(r.usage, r.model))
    peak = Math.max(peak, promptTokens(r.usage))
    n += 1
  }
  return { usage, cost, peak, n }
}

// Section: Thread stats
// One row of the panel's thread list.
export function threadStats(t: Thread, label: string, detail: string, depth: number, isRunning: boolean): ThreadStats {
  const s = sumRequests(t.requests.values())
  return {
    label,
    detail,
    depth,
    requests: s.n,
    toolCalls: t.toolCalls,
    usage: s.usage,
    cost: s.cost,
    peakPrompt: s.peak,
    isRunning,
  }
}

export function turnRequests(t: Thread, requestIds: string[]): Request[] {
  return requestIds.map(id => t.requests.get(id)).filter((r): r is Request => !!r)
}
