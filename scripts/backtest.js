// Section: Backtest
// Predicts each turn's cost from the turns before it, for every session in a transcript folder,
// and reports how close the next-message model and the old median-of-turns method come.
// Usage: npm run compile && node scripts/backtest.js [projects/<workspace> folder]
const fs = require('fs')
const os = require('os')
const path = require('path')

const { Session } = require('../out/data/transcript')
const { cardFor, costOf, modelInfo, promptTokens } = require('../out/data/pricing')

const root = path.join(os.homedir(), '.claude', 'projects')
const dirs = process.argv[2] ? [process.argv[2]] : fs.readdirSync(root).map(d => path.join(root, d))
const files = dirs.flatMap(d => fs.readdirSync(d).filter(f => f.endsWith('.jsonl')).map(f => path.join(d, f)))
const newErr = []
const oldErr = []
const sums = { est: 0, old: 0, actual: 0 }

for (const f of files) {
  const s = new Session(f)
  s.refresh()
  const m = s.main
  const turns = m.turns.filter(t => t.requestIds.length).map(t => t.requestIds.map(id => m.requests.get(id)))
  const cost = rs => rs.reduce((a, r) => a + costOf(r.usage, r.model).total, 0)
  for (let k = 3; k < turns.length; k++) {
    const prev = turns.slice(Math.max(0, k - 5), k)
    const last = turns[k - 1].at(-1)
    if (turns[k][0].ts - last.ts > 3_600_000) continue // cold turns are priced separately
    const P = promptTokens(last.usage) + last.usage.output
    const card = cardFor(modelInfo(last.model), P)
    const counts = prev.map(t => t.length).sort((a, b) => a - b)
    const N = Math.max(1, Math.round(counts.reduce((a, k) => a + k, 0) / counts.length))
    const reqs = prev.flat()
    const nt = r => r.usage.write5m + r.usage.write1h + r.usage.input
    const g = reqs.filter(r => nt(r) < 0.5 * promptTokens(r.usage))
    const W = g.reduce((a, r) => a + nt(r), 0) / Math.max(1, g.length)
    const O = reqs.reduce((a, r) => a + r.usage.output, 0) / reqs.length
    const est = (N * P * card.read + (card.read * W * N * (N - 1)) / 2 + N * W * card.write1h + N * O * card.output) / 1e6
    const old = prev.map(cost).sort((a, b) => a - b)[Math.floor(prev.length / 2)]
    const actual = cost(turns[k])
    sums.est += est
    sums.old += old
    sums.actual += actual
    newErr.push(Math.log(est / actual))
    oldErr.push(Math.log(old / actual))
  }
}

const stats = e => {
  const s = [...e].sort((a, b) => a - b)
  const within2 = e.filter(x => Math.abs(x) < Math.log(2)).length / e.length
  return `median ratio ${Math.exp(s[Math.floor(s.length / 2)]).toFixed(2)}x, within 2x: ${(within2 * 100).toFixed(0)}%`
}
console.log(`turns tested: ${newErr.length}`)
console.log(`next-message model: ${stats(newErr)}`)
console.log(`old median of turns: ${stats(oldErr)}`)
console.log(`predicted ÷ actual spend over all turns: model ${(sums.est / sums.actual).toFixed(2)}x, old ${(sums.old / sums.actual).toFixed(2)}x`)
