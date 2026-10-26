import * as fs from 'fs'
import * as path from 'path'

import { cardFor, modelInfo, promptTokens } from '../data/pricing'
import type { Thread } from '../data/transcript'
import { HOUR, turnCost } from './estimate'
import type { CacheState, Handoff, HandoffCurve, HandoffOption } from './types'

// Section: Handoff estimate
// What a new session would start at after handing off with tools/handoff/handoff.py, with and
// without re-reading every markdown file this session touched, and what its messages would cost.
// New-session overhead is this session's first request (exact); everything else is estimated.
const CHARS_PER_TOKEN = 3.5
const SUMMARY_TOKENS = 300 // "Where we are", capped at 200 words
const HEADER_CHARS = 300
const TURN_CHARS = 120 // turn headings and the tool-call line
const MD_EXT = new Set(['.md', '.mdx', '.markdown'])

export function handoffEstimate(main: Thread, cache: CacheState | null, model: string): Handoff | null {
  const first = main.requests.values().next().value
  if (!first || !cache) return null
  const h = main.mix.handoffInputs()
  const files = [...h.changed, ...h.read]
  const fileChars =
    HEADER_CHARS + h.promptChars + h.replyChars + h.turns * TURN_CHARS + files.reduce((n, f) => n + f.length + 16, 0)
  const overhead = promptTokens(first.usage)
  const fileTokens = fileChars / CHARS_PER_TOKEN + SUMMARY_TOKENS

  let mdTokens = 0
  let mdFiles = 0
  for (const f of files.filter(f => MD_EXT.has(path.extname(f).toLowerCase()))) {
    try {
      mdTokens += fs.statSync(f).size / CHARS_PER_TOKEN
      mdFiles += 1
    } catch {
      // deleted or moved since
    }
  }

  // Same turn shape as the next-message estimate, at the smaller context; the first message
  // writes the whole new context to cache, later ones read it.
  const turn = (P: number, isCold: boolean) => {
    const card = cardFor(modelInfo(model), P)
    const write = cache.ttlMs === HOUR ? card.write1h : card.write5m
    return turnCost(P, cache.requestsPerTurn, cache.writePerRequest, cache.outputPerRequest, card.read, write, card.output, isCold)
  }
  const option = (tokens: number): HandoffOption => ({ tokens, firstCost: turn(tokens, true), nextCost: turn(tokens, false) })
  const base = overhead + fileTokens
  const withMd = base + mdTokens
  // Writing the handoff: one request that reads the current context and writes the summary.
  const card = cardFor(modelInfo(model), cache.prefixTokens)
  const summary = (cache.prefixTokens * card.read + SUMMARY_OUTPUT * card.output) / 1e6
  return {
    overhead,
    fileTokens,
    mdTokens,
    mdFiles,
    base: option(base),
    withMd: option(withMd),
    curve: curve(cache, withMd, summary, turn),
  }
}

// Section: Break-even curve
// Cumulative cost of the next 1..10 messages: carrying on (context growing at the recent rate)
// against handing off (one short request to write the summary, then the new session, MD files
// re-read). Warm and cold variants, as the cache may expire while the panel is open.
const HORIZON = 10
const SUMMARY_OUTPUT = 400

function curve(cache: CacheState, start: number, summary: number, turn: (P: number, isCold: boolean) => number): HandoffCurve {
  const growth = cache.requestsPerTurn * (cache.writePerRequest + cache.outputPerRequest)
  const P = cache.prefixTokens
  const run = (from: number, first: number, isCold: boolean) => {
    const out: number[] = []
    let total = first
    for (let i = 0; i < HORIZON; i++) {
      total += turn(from + i * growth, isCold && i === 0)
      out.push(total)
    }
    return out
  }
  return {
    continueWarm: run(P, 0, false),
    continueCold: run(P, 0, true),
    handoffWarm: run(start, summary, true),
    handoffCold: run(start, summary + cache.recacheCost, true),
  }
}
