import * as vscode from 'vscode'

import { tok, usd } from '../analysis/format'
import { ADVICE, ADVICE_SHORT, adviceLevel, isTtlDead } from '../analysis/snapshot'
import type { Snapshot } from '../analysis/types'

// Section: Status bar
// One compact item (the bar's width is shared and fixed); the full picture is in its hover.
const ICONS = ['$(pass-filled)', '$(info)', '$(warning)', '$(error)']

export class StatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('sessionMonitor.status', vscode.StatusBarAlignment.Left, 1000)

  constructor() {
    this.item.command = 'sessionMonitor.panel.focus'
    this.item.name = 'Claude Session Monitor'
  }

  render(snap: Snapshot | undefined): void {
    if (!snap) {
      this.item.text = '$(pulse) Claude: no session'
      this.item.tooltip = undefined
      this.item.backgroundColor = undefined
      this.item.show()
      return
    }
    if (!snap.total.requests) {
      this.item.text = '$(pulse) Claude: new conversation'
      this.item.tooltip = 'No messages yet. Stats appear after the first reply.'
      this.item.backgroundColor = undefined
      this.item.show()
      return
    }
    const now = Date.now()
    const level = adviceLevel(snap, now)
    const dead = isTtlDead(snap, now)
    const reason = dead ? 'timer ran out' : snap.flags.find(f => f.level > 0)?.short
    const next = snap.cache ? (dead ? snap.cache.turnColdCost : snap.cache.turnWarmCost) : null

    // Same layout as the overview page: advice, context, spend so far, next message.
    this.item.text = [
      `${ICONS[level]} ${ADVICE_SHORT[level]}${reason ? `: ${reason}` : ''}`,
      `context ${tok(snap.contextTokens)} (${snap.contextPercent.toFixed(0)}%)`,
      `${usd(snap.total.cost.total)} so far`,
      next !== null ? `next message ≈ ${usd(next)}` : '',
    ]
      .filter(Boolean)
      .join(' · ')
    this.item.tooltip = tooltip(snap, level, dead, next)
    this.item.backgroundColor =
      level === 3
        ? new vscode.ThemeColor('statusBarItem.errorBackground')
        : level === 2
          ? new vscode.ThemeColor('statusBarItem.warningBackground')
          : undefined
    this.item.show()
  }

  dispose(): void {
    this.item.dispose()
  }
}

function tooltip(snap: Snapshot, level: number, dead: boolean, next: number | null): vscode.MarkdownString {
  const md = new vscode.MarkdownString()
  md.appendMarkdown(`**${ADVICE[level]}**${dead ? ' — cache TTL has expired' : ''}\n\n`)
  md.appendMarkdown(
    `Context ${tok(snap.contextTokens)} (${snap.contextPercent.toFixed(0)}%) · ${snap.total.toolCalls} tool calls · session ${usd(snap.total.cost.total)}`,
  )
  if (next !== null) md.appendMarkdown(` · next message ≈ ${usd(next)}`)
  md.appendMarkdown('\n\n')
  for (const f of snap.flags.filter(f => f.level > 0)) md.appendMarkdown(`- **${f.title}** — ${f.tip}\n`)
  md.appendMarkdown('\n_Click for the full panel._')
  return md
}
