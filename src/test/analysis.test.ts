import * as assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test } from 'node:test'

import { cacheEvents } from '../analysis/cacheEvents'
import { cacheState } from '../analysis/estimate'
import { handoffEstimate } from '../analysis/handoff'
import { modelInfo } from '../data/pricing'
import { Thread } from '../data/transcript'

// Section: Fixtures
// Synthetic transcript records shaped like Claude Code's JSONL.
const T0 = Date.parse('2026-10-01T12:00:00Z')
const at = (min: number) => new Date(T0 + min * 60_000).toISOString()

function prompt(min: number, origin = 'human'): any {
  return { type: 'user', timestamp: at(min), origin: { kind: origin }, message: { content: 'do the thing' } }
}

function reply(min: number, id: string, read: number, write5m: number, opts: { model?: string; version?: string } = {}): any {
  return {
    type: 'assistant',
    timestamp: at(min),
    version: opts.version ?? '2.1.300',
    message: {
      id,
      model: opts.model ?? 'claude-opus-5-5',
      content: [{ type: 'tool_use', id: `tu_${id}` }],
      usage: {
        input_tokens: 2,
        output_tokens: 500,
        cache_read_input_tokens: read,
        cache_creation_input_tokens: write5m,
        cache_creation: { ephemeral_5m_input_tokens: write5m, ephemeral_1h_input_tokens: 0 },
      },
    },
  }
}

function thread(records: any[]): Thread {
  const t = new Thread()
  for (const r of records) t.ingest(r)
  return t
}

// Section: Parsing
test('a reply split over several lines counts once', () => {
  const r = reply(1, 'm1', 0, 50_000)
  const t = thread([prompt(0), r, r, r])
  assert.equal(t.requests.size, 1)
  assert.equal(t.toolCalls, 1)
  assert.equal(t.turns.length, 1)
})

// Section: Cache events
test('a reply after the 5-minute TTL is an expiry', () => {
  const t = thread([prompt(0), reply(1, 'a', 0, 60_000), prompt(9), reply(9.1, 'b', 0, 61_000)])
  const [e] = cacheEvents(t)
  assert.equal(e?.kind, 'expired')
  assert.ok(Math.abs(e!.minutesLate - 3) < 0.01)
})

test('background work waking the session after expiry is a wake-up', () => {
  const t = thread([prompt(0), reply(1, 'a', 0, 60_000), prompt(20, 'task-notification'), reply(20.1, 'b', 0, 61_000)])
  assert.equal(cacheEvents(t)[0]?.kind, 'woke')
})

test('a model switch inside the TTL is a warm reset', () => {
  const t = thread([prompt(0), reply(1, 'a', 0, 60_000), prompt(2), reply(2.1, 'b', 0, 61_000, { model: 'claude-sonnet-5-5' })])
  const [e] = cacheEvents(t)
  assert.equal(e?.kind, 'warm-reset')
  assert.equal(e?.cause, 'model switch')
})

test('a large new tool result that still reads the cache is growth, not a miss', () => {
  const t = thread([prompt(0), reply(1, 'a', 0, 30_000), reply(1.5, 'b', 30_000, 40_000)])
  assert.equal(cacheEvents(t).length, 0)
})

// Section: Estimate
test('an expired turn costs the warm turn plus the re-cache', () => {
  const t = thread([prompt(0), reply(1, 'a', 0, 60_000), reply(1.2, 'b', 60_000, 2_000), prompt(2), reply(2.1, 'c', 62_000, 1_500)])
  const c = cacheState(t)!
  assert.ok(Math.abs(c.turnColdCost - (c.turnWarmCost + c.recacheCost)) < 1e-9)
  assert.equal(c.ttlMs, 300_000)
})

// Section: Handoff
test('a handoff starts at the first request plus the handoff file, and MD re-reads come from disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-ho-'))
  const md = path.join(dir, 'notes.md')
  fs.writeFileSync(md, 'x'.repeat(3500))
  const read = { type: 'assistant', uuid: 'r1', timestamp: at(1.5), message: { id: 'b', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'tr', name: 'Read', input: { file_path: md } }], usage: { input_tokens: 2, output_tokens: 10, cache_read_input_tokens: 60_000, cache_creation_input_tokens: 4_000 } } }
  const t = thread([prompt(0), reply(1, 'a', 0, 40_000), read])
  const ho = handoffEstimate(t, cacheState(t), 'claude-opus-5-5')!
  assert.equal(ho.overhead, 40_002)
  assert.equal(ho.mdFiles, 1)
  assert.ok(Math.abs(ho.mdTokens - 1000) < 1e-9)
  assert.ok(Math.abs(ho.withMd.tokens - ho.base.tokens - 1000) < 1e-9)
  assert.ok(ho.base.firstCost > ho.base.nextCost)
})

// Section: Prices
test('prices.json loads; dated model ids match their family, unknown ones fall back', () => {
  const opus = modelInfo('claude-opus-5-5-20261001')
  assert.equal(opus.known, true)
  assert.equal(opus.card.input, 4)
  assert.equal(opus.card.write1h, 8)
  assert.equal(modelInfo('some-other-model').known, false)
  assert.equal(modelInfo('claude-haiku-5-5').longAbove, 100_000)
})
