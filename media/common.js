// Section: Shared helpers
// Loaded before view.js and detail.js: DOM builder (styles set through the CSSOM, which the CSP
// allows), token format, and the context mix part names.
function h(tag, props, ...kids) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue
    if (k === 'style') Object.assign(el.style, v)
    else if (k === 'class') el.className = v
    else if (k === 'tip') el.dataset.tip = v
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    else el.setAttribute(k, v)
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)))
  }
  return el
}

function tok(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return String(Math.round(n))
}

// Per part: name, one-line description (hovers), and what the detail tab lists.
const MIX = {
  overhead: [
    'Overhead',
    'System prompt, tool definitions, CLAUDE.md and reminders',
    "Sent with every request ahead of the conversation: Claude Code's system prompt, the definition of every tool, CLAUDE.md and other instructions, the skill and agent listings, and reminders Claude Code adds along the way (environment and git status, token budget). You never type any of it, and a new session starts with most of it.",
  ],
  you: ['Your messages', 'What you typed', 'Your typed messages, one row per turn. Pasted images and documents count here too.'],
  replies: [
    "Claude's replies",
    "Claude's text plus the commands and tool calls it sent",
    'What Claude sent: its reply text, and the input of every tool call, such as the full text of each Bash or PowerShell command. What those commands returned is under Command output; content Claude wrote into files is under the file tabs.',
  ],
  thinking: [
    'Thinking',
    'Hidden reasoning, estimated',
    "Claude's hidden reasoning, one row per turn. It stays in context, but its text is not saved, so its size is estimated as output tokens minus the visible reply.",
  ],
  md: [
    'MD files',
    'Markdown files read or written',
    'Markdown files (.md) Claude read, wrote or edited, one row per file: what Read returned plus the content of edits and writes. Times counts reads and edits.',
  ],
  scripts: [
    'Scripts',
    'Code and web files read or written',
    'Code and web files (.ts, .js, .py, .ps1, .html, .css and similar) Claude read, wrote or edited, counted like MD files. A file read through a shell command (cat, Get-Content) is under Command output instead.',
  ],
  sql: [
    'SQL & data',
    'SQL, CSV, Excel and Parquet files',
    'SQL and tabular data files (.sql, .csv, .tsv, .xlsx, .parquet) Claude read, wrote or edited, counted like MD files.',
  ],
  otherFiles: [
    'Other files',
    'Config, JSON, images and other files',
    'Every other file Claude read, wrote or edited: config and JSON, lock files, images (by pixel size) and PDFs (about 2.25k tokens a page).',
  ],
  commands: [
    'Command output',
    'What commands and searches returned',
    'What tools returned, apart from file reads: shell output (Bash, PowerShell), search results (Grep, Glob), web pages and other tools, one row per distinct command. The command text itself is under Claude\'s replies.',
  ],
  skills: [
    'Skills & agents',
    'Loaded skills and subagent reports',
    "Skill instructions loaded with the Skill tool, and what subagents and background tasks reported back, one row per skill or agent. Claude loads a skill when you type its /command, and also on its own when a task matches the skill's description, so a skill can be here without you asking for it.",
  ],
}

// Section: Tooltip
// Shows data-tip text centred under the pointer for any hovered element, kept inside the window.
document.addEventListener('mousemove', e => {
  const tip = document.getElementById('tip')
  const target = e.target instanceof Element ? e.target.closest('[data-tip]') : null
  if (!target) {
    tip.hidden = true
    return
  }
  tip.textContent = target.dataset.tip
  tip.hidden = false
  const x = Math.min(e.clientX - tip.offsetWidth / 2, window.innerWidth - tip.offsetWidth - 8)
  const y = e.clientY + 14 + tip.offsetHeight > window.innerHeight ? e.clientY - tip.offsetHeight - 8 : e.clientY + 14
  tip.style.left = `${Math.max(8, x)}px`
  tip.style.top = `${y}px`
})
document.addEventListener('mouseleave', () => (document.getElementById('tip').hidden = true))
