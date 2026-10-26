import type { MixPart } from '../data/contextMix'
import type { CostParts, Usage } from '../data/pricing'

// Section: Settings-driven limits
// Thresholds the user can tune; read from settings each tick.
export type Thresholds = {
  consider: number
  wrapUp: number
  stop: number
  freshTokens: number
  longSessionRereads: number
  costLimit: number
}

export type Level = 0 | 1 | 2 | 3

// Section: Flags
// A condition worth telling the user about, with a plain-language next step.
export type Flag = {
  id: string
  level: Level
  short: string
  title: string
  detail: string
  tip: string
  hasCountdown?: boolean
}

// Section: Snapshot parts
// Everything the panel and status bar draw, as plain JSON for the webview.
export type TurnBar = { index: number; ts: number; prompt: number; cost: number; toolCalls: number }

export type ThreadStats = {
  label: string
  detail: string
  depth: number
  requests: number
  toolCalls: number
  usage: Usage
  cost: CostParts
  peakPrompt: number
  isRunning: boolean
}

export type CacheState = {
  ttlMs: number
  lastTs: number
  expiresAt: number
  prefixTokens: number
  requestsPerTurn: number
  writePerRequest: number
  outputPerRequest: number
  turnWarmCost: number
  turnColdCost: number
  turnLowWarmCost: number
  turnHighWarmCost: number
  quickWarmCost: number
  recacheCost: number
  rereadCostPerRequest: number
  lastTurnCost: number | null
}

// A request that re-wrote most of the conversation instead of reading it from cache.
export type CacheEvent = {
  ts: number
  kind: 'expired' | 'woke' | 'warm-reset'
  cause: string
  minutesLate: number
  tokens: number
  cost: number
}

// A new session after a handoff: its size and the cost of its first and later messages.
export type HandoffOption = { tokens: number; firstCost: number; nextCost: number }
// Cumulative cost of the next 1..10 messages, carrying on vs handing off; cold = the cache has expired.
export type HandoffCurve = { continueWarm: number[]; continueCold: number[]; handoffWarm: number[]; handoffCold: number[] }
export type Handoff = {
  overhead: number
  fileTokens: number
  mdTokens: number
  mdFiles: number
  base: HandoffOption
  withMd: HandoffOption
  curve: HandoffCurve
}

export type Snapshot = {
  sessionId: string
  title: string
  model: string
  isModelKnown: boolean
  window: number
  contextTokens: number
  contextPercent: number
  contextLevel: Level
  contextMix: MixPart[]
  rereads: number
  baseLevel: Level
  adviceLabels: string[]
  flags: Flag[]
  thresholds: Thresholds
  turns: TurnBar[]
  main: ThreadStats
  agents: ThreadStats[]
  total: { usage: Usage; cost: CostParts; toolCalls: number; requests: number }
  cache: CacheState | null
  cacheEvents: CacheEvent[]
  handoff: Handoff | null
  builtAt: number
}
