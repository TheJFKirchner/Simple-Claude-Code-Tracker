import * as fs from 'fs'
import * as path from 'path'

// Section: Types
// A price card is US dollars per million tokens, as the API bills each usage field.
export type Card = { input: number; output: number; write5m: number; write1h: number; read: number }
export type ModelInfo = { card: Card; window: number; longAbove?: number; longCard?: Card; known: boolean }

export type Usage = { input: number; output: number; cacheRead: number; write5m: number; write1h: number }

// Section: Price table
// Loaded from prices.json at the extension root (the one file to edit when prices change).
// Prefix match, longest first; a malformed file fails loudly with the field at fault.
export const PRICES_FILE = path.join(__dirname, '..', '..', 'prices.json')

type PriceCard = { input: number; output: number; cacheRead: number }
type PriceFile = {
  cacheWrite5mMultiplier: number
  cacheWrite1hMultiplier: number
  fallbackModel: string
  models: Record<string, PriceCard & { contextWindow: number; longContext?: PriceCard & { above: number } }>
}

function loadPrices(file: string): { byLength: [string, Omit<ModelInfo, 'known'>][]; fallback: Omit<ModelInfo, 'known'> } {
  const p: PriceFile = JSON.parse(fs.readFileSync(file, 'utf8'))
  const num = (v: unknown, where: string) => {
    if (typeof v !== 'number' || !(v >= 0)) throw new Error(`${file}: ${where} must be a number >= 0`)
    return v
  }
  const w5 = num(p.cacheWrite5mMultiplier, 'cacheWrite5mMultiplier')
  const w1 = num(p.cacheWrite1hMultiplier, 'cacheWrite1hMultiplier')
  const card = (c: PriceCard, where: string): Card => ({
    input: num(c?.input, `${where}.input`),
    output: num(c?.output, `${where}.output`),
    read: num(c?.cacheRead, `${where}.cacheRead`),
    write5m: c.input * w5,
    write1h: c.input * w1,
  })
  const models = Object.entries(p.models ?? {}).map(([id, m]): [string, Omit<ModelInfo, 'known'>] => [
    id.toLowerCase(),
    {
      card: card(m, `models.${id}`),
      window: num(m.contextWindow, `models.${id}.contextWindow`),
      ...(m.longContext
        ? { longAbove: num(m.longContext.above, `models.${id}.longContext.above`), longCard: card(m.longContext, `models.${id}.longContext`) }
        : {}),
    },
  ])
  const fallback = models.find(([id]) => id === String(p.fallbackModel).toLowerCase())?.[1]
  if (!fallback) throw new Error(`${file}: fallbackModel "${p.fallbackModel}" is not in models`)
  return { byLength: models.sort((a, b) => b[0].length - a[0].length), fallback }
}

const { byLength: BY_LENGTH, fallback: FALLBACK } = loadPrices(PRICES_FILE)

export function modelInfo(model: string): ModelInfo {
  const id = model.toLowerCase().replace(/^(anthropic\.|us\.anthropic\.)/, '')
  const hit = BY_LENGTH.find(([prefix]) => id.startsWith(prefix))
  return hit ? { ...hit[1], known: true } : { ...FALLBACK, known: false }
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
