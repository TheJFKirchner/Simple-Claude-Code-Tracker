// Section: Setup
// Receives prices, the model map and the model names found in transcripts; every edit goes straight
// back to the extension, which saves it to settings and sends fresh data.
const vscode = acquireVsCodeApi()
const root = document.getElementById('root')
let data = null
let showAll = false
// The new-rule row survives redraws while it is being typed.
let draft = { name: '', target: '' }

window.addEventListener('message', e => {
  if (e.data?.type !== 'config') return
  data = e.data.data
  render()
})
vscode.postMessage({ type: 'ready' })

// Section: Helpers
function money(n) {
  return `$${Number(n.toFixed(4))}`
}

function when(ms) {
  if (!ms) return '·'
  const days = Math.floor((Date.now() - ms) / 86_400_000)
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : days < 60 ? `${days} days ago` : new Date(ms).toLocaleDateString()
}

function modelSelect(id, selected, first, onchange) {
  return h(
    'select',
    { id, onchange: e => onchange(e.target.value) },
    first ? h('option', { value: '', selected: selected === '' ? 'selected' : null }, first) : null,
    data.ids.map(m => h('option', { value: m, selected: m === selected ? 'selected' : null }, m)),
  )
}

// Section: Render
// Redraws everything, keeping keyboard focus on the field that had it.
function render() {
  const focus = document.activeElement?.id
  root.replaceChildren()
  if (!data) return
  root.append(
    h('h1', {}, 'Prices and models'),
    h(
      'p',
      { class: 'intro' },
      "Every dollar figure in Session Monitor is priced from here. Set your own prices if your organization doesn't pay API list prices, " +
        'and say which model a recorded model name is when it is not recognised. Changes are saved to your settings at once and re-price ' +
        'every session, past ones included.',
    ),
    // Sections return arrays; append, unlike h(), does not flatten them.
    ...[models(), rules(), prices()].flat(Infinity),
  )
  if (focus) document.getElementById(focus)?.focus()
}

// Section: Models
// One row per model name found in the transcripts, with what it is priced as and why.
function status(m) {
  if (m.match === 'guessed') return h('span', { class: 'warn' }, `Not recognised: priced as ${m.pricedAs}`)
  if (m.match === 'name') return h('span', { class: 'muted' }, 'Recognised by name')
  return h('span', {}, m.rule === m.name.toLowerCase() ? 'Set by you' : `By rule "${m.rule}"`)
}

function models() {
  const head = h(
    'h2',
    {},
    'Your models',
    h('span', { class: 'muted' }, data.scanning ? ' · looking through your transcripts…' : ` · ${data.models.length} found in your transcripts `),
    data.scanning ? null : h('a', { class: 'link', onclick: () => vscode.postMessage({ type: 'rescan' }) }, 'scan again'),
  )
  const about = h(
    'p',
    { class: 'about' },
    'Model names exactly as Claude Code recorded them, newest first. Pick what a name should be priced as; "Automatic" uses the built-in name match.',
  )
  if (!data.models.length) return [head, about, h('p', { class: 'muted' }, data.scanning ? '' : 'No model names found yet.')]
  return [
    head,
    about,
    h(
      'table',
      {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Recorded name'), h('th', { class: 'num' }, 'Sessions'), h('th', {}, 'Last used'), h('th', {}, 'Priced as'), h('th', {}, 'Why'))),
      h(
        'tbody',
        {},
        data.models.map((m, i) => {
          const exact = m.match === 'mapped' && m.rule === m.name.toLowerCase()
          const auto = exact
            ? `Automatic: ${m.auto}${m.autoMatch === 'guessed' ? ' (guessed)' : ''}`
            : `Automatic: ${m.pricedAs}${m.match === 'guessed' ? ' (guessed)' : m.match === 'mapped' ? ` (rule "${m.rule}")` : ''}`
          return h(
            'tr',
            { class: m.match === 'guessed' ? 'guessed' : null },
            h('td', { class: 'label', title: m.name }, h('span', { class: 'file' }, m.name)),
            h('td', { class: 'num muted' }, m.sessions),
            h('td', { class: 'muted nowrap' }, when(m.lastSeen)),
            h('td', {}, modelSelect(`m-${i}`, exact ? m.pricedAs : '', auto, v => vscode.postMessage({ type: 'map', name: m.name, target: v || null }))),
            h('td', { class: 'why' }, status(m)),
          )
        }),
      ),
    ),
  ]
}

// Section: Rules
// The model map itself: exact names chosen above, and rules that cover every name starting with
// their text (for names that change, such as inference-profile IDs).
function rules() {
  const add = () => {
    if (!draft.name.trim() || !draft.target) return
    vscode.postMessage({ type: 'map', name: draft.name, target: draft.target })
    draft = { name: '', target: '' }
  }
  return [
    h('h2', {}, 'Rules'),
    h(
      'p',
      { class: 'about' },
      'A rule prices every model name that is, or starts with, its text. Use one for names that change, such as Bedrock ' +
        'inference-profile ARNs or gateway aliases. Names you picked above are listed here too.',
    ),
    h(
      'table',
      {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Name, or start of name'), h('th', {}, 'Priced as'), h('th', {}, ''))),
      h(
        'tbody',
        {},
        data.rules.map((r, i) =>
          h(
            'tr',
            {},
            h('td', { class: 'label', title: r.name }, h('span', { class: 'file' }, r.name)),
            h(
              'td',
              {},
              modelSelect(`r-${i}`, r.isValid ? r.target.toLowerCase() : '', r.isValid ? null : r.target, v => v && vscode.postMessage({ type: 'map', name: r.name, target: v })),
              r.isValid ? null : h('span', { class: 'warn' }, ` "${r.target}" is not in the price table; ignored`),
            ),
            h('td', { class: 'num' }, h('a', { class: 'link', onclick: () => vscode.postMessage({ type: 'map', name: r.name, target: null }) }, 'remove')),
          ),
        ),
        h(
          'tr',
          {},
          h(
            'td',
            {},
            h('input', {
              id: 'rule-name',
              type: 'text',
              class: 'wide',
              placeholder: 'e.g. arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/',
              value: draft.name,
              oninput: e => (draft.name = e.target.value),
              onkeydown: e => e.key === 'Enter' && add(),
            }),
          ),
          h('td', {}, modelSelect('rule-target', draft.target, 'Priced as…', v => (draft.target = v))),
          h('td', { class: 'num' }, h('button', { onclick: add }, 'Add')),
        ),
      ),
    ),
  ]
}

// Section: Prices
// Discount, then a row per model: an empty box means list price less the discount. Cache writes
// follow input. Only models in use are listed unless "show all" is on.
const FIELDS = [
  ['input', 'Input'],
  ['output', 'Output'],
  ['cacheRead', 'Cache read'],
]

function prices() {
  const keep = 1 - data.discountPercent / 100
  const rows = data.prices.filter(p => showAll || p.inUse)
  const { m5, h1 } = data.writeMultipliers
  return [
    h('h2', {}, 'Prices', h('span', { class: 'muted' }, data.isCustom ? ' · your prices are in use' : ' · API list prices')),
    h(
      'p',
      { class: 'about' },
      `US dollars per million tokens. Leave a box empty for the list price, less any discount. Cache writes follow input: ` +
        `${m5}× input for the 5-minute cache, ${h1}× for the 1-hour cache.`,
    ),
    h(
      'div',
      { class: 'discount' },
      h('label', { for: 'discount' }, 'Discount off every list price '),
      h('input', {
        id: 'discount',
        type: 'number',
        min: '0',
        max: '100',
        step: 'any',
        placeholder: '0',
        value: data.discountPercent || '',
        onchange: e => vscode.postMessage({ type: 'discount', value: Number(e.target.value) || 0 }),
      }),
      ' %',
      data.isCustom ? h('button', { class: 'secondary', onclick: () => vscode.postMessage({ type: 'resetPrices' }) }, 'Back to list prices') : null,
    ),
    h(
      'table',
      { class: 'prices' },
      h(
        'thead',
        {},
        h('tr', {}, h('th', {}, 'Model'), FIELDS.map(([, name]) => h('th', { class: 'num' }, name)), h('th', { class: 'num' }, '5m write'), h('th', { class: 'num' }, '1h write')),
      ),
      h('tbody', {}, rows.map(p => priceRows(p, keep))),
    ),
    h(
      'p',
      { class: 'muted' },
      h(
        'a',
        { class: 'link', onclick: () => ((showAll = !showAll), render()) },
        showAll ? 'Show only models in use' : `Show all ${data.prices.length} models`,
      ),
    ),
  ]
}

function priceRows(p, keep) {
  const box = f =>
    h('input', {
      id: `p-${p.id}-${f}`,
      type: 'number',
      min: '0',
      step: 'any',
      class: `price${p.set[f] !== undefined ? ' set' : ''}`,
      placeholder: Number((p.list[f] * keep).toFixed(4)),
      value: p.set[f] ?? '',
      onchange: e => {
        const v = e.target.value.trim()
        if (v !== '' && !(Number(v) >= 0)) return e.target.classList.add('bad')
        vscode.postMessage({ type: 'price', id: p.id, field: f, value: v === '' ? null : Number(v) })
      },
    })
  const row = h(
    'tr',
    {},
    h('td', { class: 'nowrap' }, p.id === data.fallback ? `${p.id} ` : p.id, p.id === data.fallback ? h('span', { class: 'muted' }, '(used for unrecognised names)') : null),
    FIELDS.map(([f]) => h('td', { class: 'num' }, box(f))),
    h('td', { class: 'num muted' }, money(p.card.write5m)),
    h('td', { class: 'num muted' }, money(p.card.write1h)),
  )
  if (!p.longCard) return row
  const c = p.longCard
  return [
    row,
    h(
      'tr',
      { class: 'long' },
      h(
        'td',
        { colspan: '6', class: 'muted' },
        `Prompts over ${tok(p.longAbove)} tokens: ${money(c.input)} input, ${money(c.output)} output, ${money(c.read)} cache read ` +
          '(these move with the prices above).',
      ),
    ),
  ]
}
