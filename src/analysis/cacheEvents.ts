import { cardFor, modelInfo, promptTokens } from '../data/pricing'
import type { Thread } from '../data/transcript'
import { ttlOf } from './estimate'
import type { CacheEvent } from './types'

// Section: Detection
// Finds main-thread requests that re-wrote most of the conversation, and why:
// the cache had expired (by the user, or by background work waking the session),
// or it was reset while still warm (model switch, Claude Code update, other change).
const MIN_TOKENS = 20_000

export function cacheEvents(main: Thread): CacheEvent[] {
  const reqs = [...main.requests.values()]
  const turnByIndex = new Map(main.turns.map(t => [t.index, t]))
  const events: CacheEvent[] = []

  for (let i = 1; i < reqs.length; i++) {
    const r = reqs[i]!
    const prev = reqs[i - 1]!
    const written = r.usage.write5m + r.usage.write1h
    const prompt = promptTokens(r.usage)
    const available = promptTokens(prev.usage)
    // A miss reads much less from cache than the previous request had cached; a big new
    // tool result alone (growth) still reads everything before it.
    if (written < MIN_TOKENS || r.usage.cacheRead >= 0.8 * available) continue
    // The context shrank (compaction, rewind): a re-write is expected, not a miss.
    if (prompt < 0.6 * available) continue

    const turn = turnByIndex.get(r.turnIndex)
    const isTurnStart = turn?.requestIds[0] === r.id
    const gapEnd = isTurnStart && turn && turn.ts > prev.ts ? turn.ts : r.ts
    const gap = gapEnd - prev.ts
    const ttl = ttlOf(prev, ttlOf(r))

    const card = cardFor(modelInfo(r.model), prompt)
    const cost = (r.usage.write5m * card.write5m + r.usage.write1h * card.write1h - written * card.read) / 1e6
    const base = { ts: r.ts, tokens: written, cost: Math.max(0, cost) }

    if (gap > ttl) {
      const isWoken = isTurnStart && !!turn && turn.origin !== 'human'
      events.push({
        ...base,
        kind: isWoken ? 'woke' : 'expired',
        cause: isWoken ? turn!.origin : 'idle',
        minutesLate: (gap - ttl) / 60_000,
      })
    } else {
      const cause = r.model !== prev.model ? 'model switch' : r.version && prev.version && r.version !== prev.version ? 'Claude Code update' : 'unknown'
      events.push({ ...base, kind: 'warm-reset', cause, minutesLate: 0 })
    }
  }
  return events
}
