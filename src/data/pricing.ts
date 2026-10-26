import * as fs from 'fs'
import * as path from 'path'

// Section: Types
// A price card is US dollars per million tokens, as the API bills each usage field.
export type Card = { input: number; output: number; write5m: number; write1h: number; read: number }
// match: 'name' when the model name matched the price table, 'mapped' when the user's model map
// chose the entry, 'guessed' when neither did and the fallback model's prices apply.
export type Match = 'name' | 'mapped' | 'guessed'
// rule: the model-map entry that chose the prices, when match is 'mapped'.
export type ModelInfo = { id: string; card: Card; window: number; longAbove?: number; longCard?: Card; known: boolean; match: Match; rule?: string }

export type Usage = { input: number; output: number; cacheRead: number; write5m: number; write1h: number }

// Section: Price table
// Loaded from prices.json at the extension root (the list prices; ships with the extension).
// Prefix match, longest first; a malformed file fails loudly with the field at fault.
export const PRICES_FILE = path.join(__dirname, '..', '..', 'prices.json')

export type PriceCard = { input: number; output: number; cacheRead: number }
type PriceFile = {
  cacheWrite5mMultiplier: number
  cacheWrite1hMultiplier: number
  fallbackModel: string
  models: Record<string, PriceCard & { contextWindow: number; longContext?: PriceCard & { above: number } }>
}
export type ListEntry = { id: string; card: PriceCard; window: number; long?: PriceCard & { above: number } }
export type PriceTable = { entries: ListEntry[]; fallback: string; write5m: number; write1h: number }

function loadPrices(file: string): PriceTable {
  const p: PriceFile = JSON.parse(fs.readFileSync(file, 'utf8'))
  const num = (v: unknown, where: string) => {
    if (typeof v !== 'number' || !(v >= 0)) throw new Error(`${file}: ${where} must be a number >= 0`)
    return v
  }
  const card = (c: PriceCard, where: string): PriceCard => ({
    input: num(c?.input, `${where}.input`),
    output: num(c?.output, `${where}.output`),
    cacheRead: num(c?.cacheRead, `${where}.cacheRead`),
  })
  const entries = Object.entries(p.models ?? {}).map(([id, m]): ListEntry => ({
    id: id.toLowerCase(),
    card: card(m, `models.${id}`),
    window: num(m.contextWindow, `models.${id}.contextWindow`),
    ...(m.longContext ? { long: { ...card(m.longContext, `models.${id}.longContext`), above: num(m.longContext.above, `models.${id}.longContext.above`) } } : {}),
  }))
  const fallback = String(p.fallbackModel).toLowerCase()
  if (!entries.some(e => e.id === fallback)) throw new Error(`${file}: fallbackModel "${p.fallbackModel}" is not in models`)
  return {
    entries,
    fallback,
    write5m: num(p.cacheWrite5mMultiplier, 'cacheWrite5mMultiplier'),
    write1h: num(p.cacheWrite1hMultiplier, 'cacheWrite1hMultiplier'),
  }
}

export const PRICE_TABLE = loadPrices(PRICES_FILE)

// Section: Overrides
// The user's own prices and model map, from settings. Prices: a discount off every list price, and
// per-model dollar figures that replace it field by field. A model's long-prompt card moves by the
// same ratio as its base card. Model map: a recorded model name (or the start of one) → a table id.
export type PriceOverrides = {
  discountPercent: number
  models: Record<string, Partial<PriceCard>>
  modelMap: Record<string, string>
}
export const NO_OVERRIDES: PriceOverrides = { discountPercent: 0, models: {}, modelMap: {} }

export type Resolved = Omit<ModelInfo, 'known' | 'match' | 'rule'>
let overrides = NO_OVERRIDES
let overridesKey = JSON.stringify(NO_OVERRIDES)
let version = 0
let byLength: Resolved[] = []
let byId = new Map<string, Resolved>()
let mapByLength: [string, string][] = []

function resolve(o: PriceOverrides): void {
  const keep = 1 - Math.min(100, Math.max(0, o.discountPercent)) / 100
  const toCard = (c: PriceCard): Card => ({
    input: c.input,
    output: c.output,
    read: c.cacheRead,
    write5m: c.input * PRICE_TABLE.write5m,
    write1h: c.input * PRICE_TABLE.write1h,
  })
  const all = PRICE_TABLE.entries.map((e): Resolved => {
    const set = o.models[e.id] ?? {}
    const field = (f: keyof PriceCard) => set[f] ?? e.card[f] * keep
    const base: PriceCard = { input: field('input'), output: field('output'), cacheRead: field('cacheRead') }
    const ratio = (f: keyof PriceCard) => (e.card[f] > 0 ? base[f] / e.card[f] : keep)
    return {
      id: e.id,
      card: toCard(base),
      window: e.window,
      ...(e.long
        ? {
            longAbove: e.long.above,
            longCard: toCard({ input: e.long.input * ratio('input'), output: e.long.output * ratio('output'), cacheRead: e.long.cacheRead * ratio('cacheRead') }),
          }
        : {}),
    }
  })
  byLength = [...all].sort((a, b) => b.id.length - a.id.length)
  byId = new Map(all.map(r => [r.id, r]))
  mapByLength = Object.entries(o.modelMap)
    .map(([k, v]): [string, string] => [k.trim().toLowerCase(), String(v).toLowerCase()])
    .filter(([k, v]) => k && byId.has(v))
    .sort((a, b) => b[0].length - a[0].length)
}
resolve(NO_OVERRIDES)

// Returns whether anything changed, so callers can rebuild what they priced.
export function setPriceOverrides(o: PriceOverrides): boolean {
  const key = JSON.stringify(o)
  if (key === overridesKey) return false
  overrides = o
  overridesKey = key
  version += 1
  resolve(o)
  return true
}

// Bumped on every change, for callers that need to know whether their figures are stale.
export function priceVersion(): number {
  return version
}

export function priceOverrides(): PriceOverrides {
  return overrides
}

export function hasCustomPrices(): boolean {
  return overrides.discountPercent > 0 || Object.values(overrides.models).some(m => Object.keys(m).length > 0)
}

// A price-table model by its id, with the user's prices applied.
export function pricesFor(id: string): Resolved | undefined {
  return byId.get(id)
}

// Section: Model lookup
// The user's map first (exact name, else the longest entry the name starts with), then the price
// table by the name with any provider wrapping removed (Bedrock region prefixes, ARNs and gateway
// paths such as "bedrock/eu.anthropic.claude-…"), then the fallback model.
export function tableId(model: string): string {
  const id = model.trim().toLowerCase()
  return id.slice(id.lastIndexOf('/') + 1).replace(/^([a-z0-9-]+\.)?anthropic\./, '')
}

export function modelInfo(model: string): ModelInfo {
  const raw = model.trim().toLowerCase()
  const mapped = mapByLength.find(([k]) => raw === k) ?? mapByLength.find(([k]) => raw.startsWith(k))
  return mapped ? { ...byId.get(mapped[1])!, known: true, match: 'mapped', rule: mapped[0] } : nameMatch(raw)
}

// The price table alone, without the user's model map.
export function nameMatch(model: string): ModelInfo {
  const id = tableId(model)
  const hit = byLength.find(r => id.startsWith(r.id))
  return hit ? { ...hit, known: true, match: 'name' } : { ...byId.get(PRICE_TABLE.fallback)!, known: false, match: 'guessed' }
}

// Section: Cost
// Dollars for one request's usage, choosing the long-prompt card where a model has one.
export function promptTokens(u: Usage): number {
  return u.input + u.cacheRead + u.write5m + u.write1h
}

export function cardFor(info: ModelInfo, prompt: number): Card {
  return info.longCard && info.longAbove !== undefined && prompt > info.longAbove ? info.longCard : info.card
}

export type CostParts = { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }

export function costOf(u: Usage, model: string): CostParts {
  const c = cardFor(modelInfo(model), promptTokens(u))
  const input = (u.input * c.input) / 1e6
  const output = (u.output * c.output) / 1e6
  const cacheRead = (u.cacheRead * c.read) / 1e6
  const cacheWrite = (u.write5m * c.write5m + u.write1h * c.write1h) / 1e6
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite }
}

export const ZERO_COST: CostParts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }

export function addCost(a: CostParts, b: CostParts): CostParts {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    total: a.total + b.total,
  }
}
