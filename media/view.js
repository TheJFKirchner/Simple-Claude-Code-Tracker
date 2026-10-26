// Section: Setup
// Receives snapshots from the extension and redraws; a 1s tick keeps the TTL countdown live.
const vscode = acquireVsCodeApi()
const root = document.getElementById('root')
let snap = null
let following = 'latest'
let wasDead = null

const STATUS = ['var(--good)', 'var(--warning)', 'var(--serious)', 'var(--critical)']
const ICON = ['✓', '!', '!', '✕']
const FOLLOWING = { pinned: 'pinned', open: 'open conversation', latest: 'latest' }
// After the model name: nothing when the name matched the price table, else what it is priced as.
const PRICED = { name: () => '', mapped: id => ` · priced as ${id}`, guessed: id => ` · price guessed (${id})` }

// Sections open by default; the user's toggles are saved by the extension and sent with each snapshot.
const OPEN_BY_DEFAULT = { next: true, context: true, cost: false, threads: false, flags: false }
let sections = {}

window.addEventListener('message', e => {
  if (e.data?.type !== 'snapshot') return
  snap = e.data.snapshot
  following = e.data.following
  sections = e.data.sections ?? {}
  render()
})
vscode.postMessage({ type: 'ready' })
setInterval(() => {
  if (!snap) return
  const dead = isDead(Date.now())
  if (dead !== wasDead) render()
  else updateCountdowns()
}, 1000)
// The break-even chart is drawn at the panel's width.
window.addEventListener('resize', () => snap && render())

// Section: Helpers
// Number formats (h and tok are in common.js).
function usd(n) {
  if (n > 0 && n < 0.01) return '<$0.01'
  return `$${n >= 100 ? n.toFixed(0) : n.toFixed(2)}`
}

function dur(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h >= 48) return `${Math.floor(h / 24)}d`
  if (h) return `${h}h ${m}m`
  if (m >= 10) return `${m}m`
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

function isDead(now) {
  return !!snap?.cache && now >= snap.cache.expiresAt
}

// Section: Collapsible sections
// A heading that opens and closes its section; a closed one shows a one-line summary instead.
// Handoff opens by itself once the advice reaches "think about starting a new session".
function isOpen(id) {
  return sections[id] ?? (id === 'handoff' ? snap.baseLevel >= 1 : OPEN_BY_DEFAULT[id] ?? true)
}

function section(id, title, summary, ...body) {
  const open = isOpen(id)
  const toggle = () => {
    sections = { ...sections, [id]: !open }
    vscode.postMessage({ type: 'section', id, open: !open })
    render()
  }
  return h(
    'div',
    { class: 'section' },
    h(
      'h3',
      { class: 'toggle', onclick: toggle },
      h('span', {}, `${open ? '▾' : '▸'} ${title}`),
      !open && summary ? h('span', { class: 'sum num' }, summary) : null,
    ),
    open ? body : null,
  )
}

// Section: Render
// Whole-panel redraw from the latest snapshot.
function render() {
  const now = Date.now()
  wasDead = isDead(now)
  document.body.classList.toggle('ttl-dead', wasDead)
  root.replaceChildren()
  if (!snap) {
    root.append(h('p', { class: 'muted' }, 'No Claude Code session found for this workspace yet.'))
    return
  }
  if (!snap.total.requests) {
    root.append(header(), h('p', { class: 'muted section' }, 'No messages yet. Stats appear after the first reply.'))
    return
  }
  root.append(header(), advice(now), nextMessage(now), context(), handoff(now), costBreakdown(), threads(), flags(now))
}

function header() {
  return h(
    'div',
    {},
    h(
      'div',
      { class: 'title', title: snap.title || snap.sessionId },
      snap.title || (snap.total.requests ? 'Untitled session' : 'New conversation'),
    ),
    h(
      'div',
      { class: 'row small muted' },
      h(
        'span',
        {},
        snap.model ? `${snap.model} · ${tok(snap.window)} window${PRICED[snap.priceMatch](snap.pricedAs)}` : 'no messages yet',
        snap.model && snap.priceMatch === 'guessed'
          ? h('a', { class: 'link', onclick: () => vscode.postMessage({ type: 'configure' }) }, ' · set')
          : null,
      ),
      h(
        'a',
        { class: 'link', onclick: () => vscode.postMessage({ type: 'choose' }) },
        `${FOLLOWING[following] ?? following} · change`,
      ),
    ),
  )
}

function advice(now) {
  const dead = isDead(now)
  const level = dead ? 3 : snap.baseLevel
  const top = snap.flags.find(f => f.level > 0)
  const why = dead
    ? 'Cache TTL has expired.'
    : top
      ? top.title
      : `Context ${tok(snap.contextTokens)} tokens, ${snap.contextPercent.toFixed(0)}% of the window.`
  const parts = [
    h(
      'div',
      { class: 'advice section' },
      h('span', { class: 'icon', style: { background: STATUS[level] } }, ICON[level]),
      h('div', {}, h('div', { class: 'label' }, snap.adviceLabels[level]), h('div', { class: 'small muted' }, why)),
    ),
  ]
  const c = snap.cache
  if (c && dead) {
    parts.push(
      h(
        'div',
        { class: 'banner' },
        h('strong', {}, '⚠ TTL is dead'),
        h('span', { 'data-countdown': 'ago' }, `Cache expired ${dur(now - c.expiresAt)} ago.`),
        ` Your next message re-caches ~${tok(c.prefixTokens)} tokens (+${usd(c.recacheCost)}). Start a fresh session unless you need this context.`,
        h(
          'div',
          { class: 'tipline' },
          'Tip: if you were away, start a new session and paste a 2–3 line summary of where you were. ' +
            (c.ttlMs < 3600000
              ? 'Your cache only lasts 5 minutes, so this happens after any short break on a large conversation.'
              : ''),
        ),
      ),
    )
  } else if (c) {
    parts.push(
      h(
        'div',
        { class: 'small muted', style: { marginTop: '6px' } },
        `Cache warm · ${c.ttlMs >= 3600000 ? '1h' : '5m'} TTL · expires in `,
        h('span', { class: 'num', 'data-countdown': 'left' }, dur(c.expiresAt - now)),
      ),
    )
  }
  return h('div', {}, parts)
}

// Section: Flags and tips
// One card per flag, most serious first, each with a plain-language next step.
function flags(now) {
  const dead = isDead(now)
  const list = snap.flags.filter(f => !(dead && f.hasCountdown))
  if (!list.length) return h('div')
  return section(
    'flags',
    'Flags & tips',
    `${list.length} flag${list.length === 1 ? '' : 's'}`,
    list.map(f =>
      h(
        'div',
        { class: 'flag' },
        h('span', { class: 'dot', style: { background: f.level ? STATUS[f.level] : 'var(--series)' } }),
        h(
          'div',
          {},
          h(
            'div',
            { class: 'label' },
            f.title,
            f.hasCountdown && snap.cache
              ? h('span', { class: 'muted num' }, ' · expires in ', h('span', { 'data-countdown': 'left' }, dur(snap.cache.expiresAt - now)))
              : null,
          ),
          h('div', { class: 'small muted' }, f.detail),
          h('div', { class: 'tipline' }, `Tip: ${f.tip}`),
        ),
      ),
    ),
  )
}

function nextMessage(now) {
  const c = snap.cache
  if (!c) return h('div')
  const dead = isDead(now)
  const estimate = dead ? c.turnColdCost : c.turnWarmCost
  const extra = dead ? c.recacheCost : 0
  const N = c.requestsPerTurn
  return section(
    'next',
    'Estimated cost of next message',
    usd(estimate),
    h('div', { class: 'value num tile' }, usd(estimate)),
    h(
      'div',
      { class: 'small' },
      `Likely ${usd(c.turnLowWarmCost + extra)}–${usd(c.turnHighWarmCost + extra)}, from your shortest to longest recent turn.`,
    ),
    h(
      'div',
      { class: 'small muted' },
      `Your recent messages averaged ${N} request${N === 1 ? '' : 's'} each, every one re-reading today's ${tok(c.prefixTokens)} context` +
        ` (+${tok(c.writePerRequest)} new, ${tok(c.outputPerRequest)} out per request).`,
    ),
    h(
      'div',
      { class: 'small muted' },
      dead
        ? `Includes ${usd(c.recacheCost)} to re-cache the stale conversation.`
        : `If the cache expires first: ${usd(c.turnColdCost)} (+${usd(c.recacheCost)} re-cache).`,
    ),
    h(
      'div',
      { class: 'small muted' },
      `Quick one-request reply: ${usd(c.quickWarmCost + (dead ? c.recacheCost : 0))}` +
        (c.lastTurnCost !== null ? ` · last turn cost ${usd(c.lastTurnCost)}` : '') +
        (snap.customPrices ? '. Your prices.' : '. API list prices.'),
    ),
  )
}

function context() {
  const level = snap.contextLevel
  return section(
    'context',
    'Context',
    `${tok(snap.contextTokens)} · ${snap.contextPercent.toFixed(0)}%`,
    h(
      'div',
      { class: 'row num' },
      h('span', {}, `${tok(snap.contextTokens)} / ${tok(snap.window)}`),
      h('span', {}, `${snap.contextPercent.toFixed(1)}%`),
    ),
    h(
      'div',
      { class: 'meter', tip: `Context ${snap.contextPercent.toFixed(1)}% of ${tok(snap.window)}` },
      h('div', { style: { width: `${Math.min(100, snap.contextPercent)}%`, background: STATUS[level] } }),
    ),
    h(
      'div',
      {
        class: 'small muted num',
        tip: 'Cache reads ÷ current context: roughly how many times you have paid to re-read this conversation.',
      },
      `Re-read ${snap.rereads.toFixed(0)}× so far` +
        (snap.thresholds.longSessionRereads > 0 ? ` · long session at ${snap.thresholds.longSessionRereads}×` : ''),
    ),
    buildup(),
    mix(),
  )
}

// Section: Context buildup chart
// Inside the Context section: one bar per turn, context size when the turn ended, with a dashed
// line at each threshold in range.
function buildup() {
  const turns = snap.turns.slice(-40)
  if (!turns.length) return null

  const peak = Math.max(...turns.map(t => t.prompt))
  const yMax = peak * 1.15 || 1
  const box = h('div', { class: 'chart' })
  const t = snap.thresholds
  const lines = [
    [t.freshTokens, `${tok(t.freshTokens)} new session?`],
    [(t.consider / 100) * snap.window, `${t.consider}%`],
    [(t.wrapUp / 100) * snap.window, `${t.wrapUp}% wrap up`],
    [(t.stop / 100) * snap.window, `${t.stop}% stop`],
  ]
  for (const [y, name] of lines) {
    if (y > 0 && y <= yMax) {
      box.append(h('div', { class: 'line', style: { bottom: `${(y / yMax) * 100}%` } }, h('span', {}, name)))
    }
  }
  const cols = h('div', { class: 'cols' })
  for (const t of turns) {
    cols.append(
      h(
        'div',
        {
          class: 'col',
          tip: `Turn ${t.index}\n${tok(t.prompt)} tokens in context\n${usd(t.cost)} · ${t.toolCalls} tool calls`,
        },
        h('div', { class: 'bar', style: { height: `${(t.prompt / yMax) * 100}%` } }),
      ),
    )
  }
  box.append(cols)
  return h(
    'div',
    { class: 'buildup' },
    h('div', { class: 'axis' }, h('span', {}, `Buildup per turn · peak ${tok(peak)}`), h('span', {}, '')),
    box,
    h('div', { class: 'axis' }, h('span', {}, `turn ${turns[0].index}`), h('span', {}, `turn ${turns[turns.length - 1].index}`)),
  )
}

// Section: Context mix
// One stacked line of what the context holds now (100% = current context), with a legend.
// Clicking a segment or legend item opens the detail tab for that part.
function mix() {
  const parts = snap.contextMix.filter(p => p.tokens >= 1)
  const total = parts.reduce((n, p) => n + p.tokens, 0)
  if (!total) return h('div')
  const pct = p => `${((p.tokens / total) * 100).toFixed(p.tokens / total < 0.1 ? 1 : 0)}%`
  const hover = p => `${MIX[p.part][0]}\n${MIX[p.part][1]}\nClick for details`
  const open = p => () => vscode.postMessage({ type: 'detail', part: p.part })
  return h(
    'div',
    { class: 'mix' },
    h('div', { class: 'row small muted' }, h('span', {}, 'In context now'), h('span', { class: 'num' }, `${tok(total)} · split estimated`)),
    h(
      'div',
      { class: 'stack' },
      parts.map(p =>
        h('div', { tip: hover(p), onclick: open(p), style: { flexGrow: String(p.tokens), background: `var(--mix-${p.part})` } }),
      ),
    ),
    h(
      'div',
      { class: 'legend' },
      parts.map(p =>
        h(
          'div',
          { class: 'item small', tip: hover(p), onclick: open(p) },
          h('span', { class: 'sw', style: { background: `var(--mix-${p.part})` } }),
          h('span', { class: 'name' }, MIX[p.part][0]),
          h('span', { class: 'num muted' }, pct(p)),
        ),
      ),
    ),
  )
}

// Section: Handoff
// The context now against a new session started from a handoff file, with and without re-reading
// every markdown file; bars share one scale (the context now). All but "Now" are estimates.
function handoff(now) {
  const ho = snap.handoff
  const c = snap.cache
  if (!ho || !c) return h('div')
  const nowCost = isDead(now) ? c.turnColdCost : c.turnWarmCost
  const max = Math.max(snap.contextTokens, ho.withMd.tokens, 1)
  const row = (name, tokens, cost, tip, isNow) =>
    h(
      'div',
      { class: 'hbar', tip },
      h('div', { class: 'row small' }, h('span', {}, name), h('span', { class: 'num muted' }, `${isNow ? '' : '~'}${tok(tokens)} · ${cost}`)),
      h('div', { class: 'track' }, h('div', { class: `fill${isNow ? ' now' : ''}`, style: { width: `${(tokens / max) * 100}%` } })),
    )
  const later = o => `first message ~${usd(o.firstCost)}, then ~${usd(o.nextCost)}`
  return section(
    'handoff',
    'If you hand off now',
    `~${tok(ho.base.tokens)}–${tok(ho.withMd.tokens)}`,
    row('Now', snap.contextTokens, `next message ${usd(nowCost)}`, 'Context now (exact) and the next-message estimate above.', true),
    row(
      'Handoff',
      ho.base.tokens,
      later(ho.base),
      `New-session overhead ~${tok(ho.overhead)} (this session's first request)\n` +
        `+ handoff file ~${tok(ho.fileTokens)}: your messages, Claude's last reply per turn, files list, 200-word summary`,
    ),
    row(
      `+ MD re-read (${ho.mdFiles})`,
      ho.withMd.tokens,
      later(ho.withMd),
      `Handoff plus every markdown file read or changed this session, at its size on disk now (~${tok(ho.mdTokens)})`,
    ),
    h('div', { class: 'small muted' }, 'Estimates: the first message caches the new context, later ones re-read it.'),
    breakEven(now),
  )
}

// Section: Break-even chart
// Cumulative cost of the next 1..10 messages, carrying on vs handing off (MD files re-read),
// with the first message count where handing off is cheaper marked. One hover column per message.
const SVG = 'http://www.w3.org/2000/svg'
function s(tag, attrs, ...kids) {
  const el = document.createElementNS(SVG, tag)
  for (const [k, v] of Object.entries(attrs || {})) if (v !== undefined && v !== null) el.setAttribute(k, v)
  for (const kid of kids.flat(Infinity)) if (kid) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)))
  return el
}

function breakEven(now) {
  const cv = snap.handoff.curve
  const dead = isDead(now)
  const carry = dead ? cv.continueCold : cv.continueWarm
  const hand = dead ? cv.handoffCold : cv.handoffWarm
  const n = carry.length
  const k = carry.findIndex((c, i) => hand[i] < c) + 1
  const saved = carry[n - 1] - hand[n - 1]
  const text =
    k === 1
      ? `Handing off is already cheaper for your next message; over ${n} messages it saves ~${usd(saved)}.`
      : k > 1
        ? `Handing off pays off after ${k} messages, so for ${k === 2 ? '1 more quick task' : `1–${k - 1} more quick tasks`} carry on; over ${n} messages it saves ~${usd(saved)}.`
        : `Within ${n} messages carrying on stays cheaper; hand off only if more work than that is left.`

  const W = Math.max(200, root.clientWidth)
  const H = 110
  const pad = { l: 36, r: 6, t: 6, b: 16 }
  const max = Math.max(...carry, ...hand) * 1.05 || 1
  const x = i => pad.l + (i / (n - 1)) * (W - pad.l - pad.r)
  const y = v => pad.t + (1 - v / max) * (H - pad.t - pad.b)
  const line = (vals, cls) => s('polyline', { class: cls, points: vals.map((v, i) => `${x(i)},${y(v)}`).join(' ') })
  const step = (W - pad.l - pad.r) / (n - 1)
  const svg = s(
    'svg',
    { class: 'bk', width: W, height: H, viewBox: `0 0 ${W} ${H}` },
    s('line', { class: 'axis', x1: pad.l, x2: W - pad.r, y1: y(0), y2: y(0) }),
    s('text', { class: 'tick', x: pad.l - 4, y: y(max / 1.05) + 4, 'text-anchor': 'end' }, usd(max / 1.05)),
    s('text', { class: 'tick', x: pad.l - 4, y: y(0), 'text-anchor': 'end' }, '$0'),
    [1, 5, n].map(m => s('text', { class: 'tick', x: x(m - 1), y: H - 3, 'text-anchor': m === 1 ? 'start' : m === n ? 'end' : 'middle' }, String(m))),
    k ? s('line', { class: 'even', x1: x(k - 1), x2: x(k - 1), y1: pad.t, y2: y(0) }) : null,
    line(carry, 'carry'),
    line(hand, 'hand'),
    k ? s('circle', { class: 'hand-dot', cx: x(k - 1), cy: y(hand[k - 1]), r: 4 }) : null,
    carry.map((c, i) =>
      s(
        'g',
        {
          class: 'col',
          'data-tip': `${i + 1} message${i ? 's' : ''} from now\nCarry on ~${usd(c)}\nHand off ~${usd(hand[i])}`,
        },
        s('rect', { x: x(i) - step / 2, y: 0, width: step, height: H, fill: 'transparent' }),
        s('line', { class: 'guide', x1: x(i), x2: x(i), y1: pad.t, y2: y(0) }),
      ),
    ),
  )
  return h(
    'div',
    { class: 'breakeven' },
    h(
      'div',
      { class: 'row small' },
      h('span', {}, 'Cost of the next messages'),
      h(
        'span',
        { class: 'keys muted' },
        h('span', { class: 'key carry' }),
        'carry on ',
        h('span', { class: 'key hand' }),
        'hand off',
      ),
    ),
    svg,
    h('div', { class: 'small muted', style: { textAlign: 'center' } }, 'messages from now'),
    h('div', { class: 'small' }, text),
  )
}

// Section: Cost breakdown
// Session cost by billing category, main thread and agents together.
function costBreakdown() {
  const u = snap.total.usage
  const c = snap.total.cost
  const rows = [
    ['Cache write', c.cacheWrite, u.write5m + u.write1h],
    ['Cache read', c.cacheRead, u.cacheRead],
    ['Output', c.output, u.output],
    ['Input (uncached)', c.input, u.input],
  ]
  const max = Math.max(...rows.map(r => r[1]), 1e-9)
  const limit = snap.thresholds.costLimit
  const share = limit > 0 ? c.total / limit : 0
  const limitRow =
    limit > 0
      ? h(
          'div',
          { class: 'hbar', tip: `Session cost limit ${usd(limit)} (saved in your settings)` },
          h(
            'div',
            { class: 'row small' },
            h('span', {}, `Session limit ${usd(limit)}`),
            h('a', { class: 'link', onclick: () => vscode.postMessage({ type: 'setLimit' }) }, 'change'),
          ),
          h(
            'div',
            { class: 'meter' },
            h('div', {
              style: {
                width: `${Math.min(100, share * 100)}%`,
                background: share >= 1 ? STATUS[3] : share >= 0.8 ? STATUS[1] : STATUS[0],
              },
            }),
          ),
        )
      : h('div', { class: 'small' }, h('a', { class: 'link', onclick: () => vscode.postMessage({ type: 'setLimit' }) }, 'Set a session cost limit'))
  return section(
    'cost',
    'Tokens & cost',
    usd(c.total),
    h(
      'div',
      { class: 'row' },
      h('span', {}, `${snap.total.requests} requests · ${snap.total.toolCalls} tool calls · ${snap.turns.length} turns`),
      h('strong', { class: 'num' }, usd(c.total)),
    ),
    limitRow,
    rows.map(([name, cost, tokens]) =>
      h(
        'div',
        { class: 'hbar', tip: `${name}\n${tokens.toLocaleString()} tokens\n${usd(cost)}` },
        h('div', { class: 'row small' }, h('span', {}, name), h('span', { class: 'num muted' }, `${tok(tokens)} · ${usd(cost)}`)),
        h('div', { class: 'track' }, h('div', { class: 'fill', style: { width: `${(cost / max) * 100}%` } })),
      ),
    ),
  )
}

// Section: Threads
// Main thread, then Agent 1, 2, 3… indented by spawn depth, each with its own tokens and cost.
function threads() {
  const all = [snap.main, ...snap.agents]
  const total = snap.total.cost.total || 1e-9
  return section(
    'threads',
    `Threads · ${snap.agents.length} subagent${snap.agents.length === 1 ? '' : 's'}`,
    usd(snap.total.cost.total),
    all.map(t => {
      const u = t.usage
      return h(
        'div',
        {
          class: `thread${t.depth ? ' child' : ''}`,
          style: { marginLeft: `${t.depth * 12}px` },
          tip: `${t.label}${t.detail ? `\n${t.detail}` : ''}\nPeak context ${tok(t.peakPrompt)}\n${t.requests} requests`,
        },
        h(
          'div',
          { class: 'row' },
          h('span', { class: 'title' }, t.label, t.isRunning ? h('span', { class: 'badge' }, 'running') : null),
          h('strong', { class: 'num' }, usd(t.cost.total)),
        ),
        t.detail ? h('div', { class: 'small muted title' }, t.detail) : null,
        h(
          'div',
          { class: 'small muted num' },
          `in ${tok(u.input)} · out ${tok(u.output)} · cache r ${tok(u.cacheRead)} · w ${tok(u.write5m + u.write1h)} · ${t.toolCalls} tools`,
        ),
        h('div', { class: 'hbar' }, h('div', { class: 'track' }, h('div', { class: 'fill', style: { width: `${(t.cost.total / total) * 100}%` } }))),
      )
    }),
  )
}

// Section: Live countdown
// Updates the TTL text in place so hover state survives.
function updateCountdowns() {
  const c = snap.cache
  if (!c) return
  const now = Date.now()
  for (const el of document.querySelectorAll('[data-countdown]')) {
    el.textContent = el.dataset.countdown === 'left' ? dur(c.expiresAt - now) : `Cache expired ${dur(now - c.expiresAt)} ago.`
  }
}
