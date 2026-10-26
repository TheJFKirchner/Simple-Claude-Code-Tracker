// Section: Setup
// Receives one part's items from the extension; chips switch part, column headers sort.
const vscode = acquireVsCodeApi()
const root = document.getElementById('root')
let data = null
let sort = { key: 'tokens', dir: -1 }

window.addEventListener('message', e => {
  if (e.data?.type !== 'detail') return
  data = e.data.data
  render()
})
vscode.postMessage({ type: 'ready' })

// Section: Render
// Header, a chip per part, then the item table for the chosen part.
function render() {
  root.replaceChildren()
  if (!data) return
  const ctx = data.contextTokens || 1
  const parts = data.parts.filter(p => p.tokens >= 1)
  const current = data.parts.find(p => p.part === data.part)
  const pct = n => `${((n / ctx) * 100).toFixed(n / ctx < 0.1 ? 1 : 0)}%`
  root.append(
    h('h1', {}, 'What is in context'),
    h('div', { class: 'muted' }, `${data.title} · ${tok(data.contextTokens)} tokens in context.`),
    h(
      'p',
      { class: 'intro' },
      'Everything below is re-sent to Claude with every request. Each tab is one part of the "In context now" line: ' +
        'pick a tab to list what is in it, largest first. The total is exact (from the API); how it splits across tabs ' +
        'and items is estimated from each item\'s size. A command counts twice, once for the command Claude sent ' +
        '(Claude\'s replies) and once for what it returned (Command output), because both are in context.',
    ),
    h(
      'div',
      { class: 'chips' },
      parts.map(p =>
        h(
          'button',
          { class: `chip${p.part === data.part ? ' on' : ''}`, onclick: () => vscode.postMessage({ type: 'part', part: p.part }) },
          h('span', { class: 'sw', style: { background: `var(--mix-${p.part})` } }),
          `${MIX[p.part][0]} ${pct(p.tokens)}`,
        ),
      ),
    ),
    h('h2', {}, MIX[data.part][0], h('span', { class: 'muted' }, ` · ~${tok(current?.tokens ?? 0)} tokens · ${pct(current?.tokens ?? 0)} of context`)),
    h('p', { class: 'about' }, MIX[data.part][2]),
    table(ctx),
  )
}

// File paths: the folder shrinks with an ellipsis so the file name always shows.
const FILE_PARTS = new Set(['md', 'scripts', 'sql', 'otherFiles'])
function label(r) {
  const cut = Math.max(r.label.lastIndexOf('/'), r.label.lastIndexOf('\\'))
  if (!FILE_PARTS.has(r.part) || cut < 0) return h('span', { class: 'file' }, r.label)
  return h('span', { class: 'path' }, h('span', { class: 'dir muted' }, r.label.slice(0, cut + 1)), h('span', { class: 'file' }, r.label.slice(cut + 1)))
}

function table(ctx) {
  if (!data.items.length) return h('p', { class: 'muted' }, 'Nothing in this part yet.')
  const rows = [...data.items].sort((a, b) => {
    const x = a[sort.key]
    const y = b[sort.key]
    return (typeof x === 'string' ? x.localeCompare(y) : x - y) * sort.dir
  })
  const col = (key, name, cls) =>
    h(
      'th',
      {
        class: cls,
        onclick: () => {
          sort = { key, dir: sort.key === key ? -sort.dir : key === 'label' ? 1 : -1 }
          render()
        },
      },
      name,
      sort.key === key ? (sort.dir < 0 ? ' ▾' : ' ▴') : '',
    )
  return h(
    'table',
    {},
    h('thead', {}, h('tr', {}, col('label', 'Item'), col('count', 'Times', 'num'), col('tokens', '~Tokens', 'num'), h('th', { class: 'num' }, '% of context'))),
    h(
      'tbody',
      {},
      rows.map(r =>
        h(
          'tr',
          {},
          h('td', { class: 'label', title: r.label }, label(r)),
          h('td', { class: 'num muted' }, r.count || '·'),
          h('td', { class: 'num' }, tok(r.tokens)),
          h('td', { class: 'num muted' }, `${((r.tokens / ctx) * 100).toFixed(1)}%`),
        ),
      ),
    ),
  )
}
