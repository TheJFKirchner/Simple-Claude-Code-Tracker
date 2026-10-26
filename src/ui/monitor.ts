import * as path from 'path'
import * as vscode from 'vscode'

import { buildSnapshot } from '../analysis/snapshot'
import type { Snapshot } from '../analysis/types'
import { listSessions, liveSessions, quickTitle, transcriptFile } from '../data/discovery'
import { priceVersion, setPriceOverrides } from '../data/pricing'
import { Session } from '../data/transcript'
import { saveCostLimit, settings, workspaceDirs, workspacePaths } from '../settings'
import { ConfigPanel } from './configPanel'
import { DetailPanel } from './detailPanel'
import { StatusBar } from './statusBar'
import { webviewHtml } from './webviewShell'

// Section: Monitor
// Follows the open conversation (else the newest transcript, or a pinned one), re-reads on change,
// feeds the panel and status bar.
export class Monitor implements vscode.WebviewViewProvider, vscode.Disposable {
  private session: Session | undefined
  private pinned: string | undefined
  private following: 'pinned' | 'open' | 'latest' = 'latest'
  private snapshot: Snapshot | undefined
  private view: vscode.WebviewView | undefined
  private readonly status = new StatusBar()
  private readonly detail: DetailPanel
  private readonly config: ConfigPanel
  private ticks = 0
  private pricedAt = -1

  // state: where the open/closed sections are remembered, across reloads and workspaces.
  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly state: vscode.Memento,
  ) {
    this.detail = new DetailPanel(extensionUri)
    this.detail.onRequest = () => this.detail.update(this.session, this.snapshot?.contextTokens ?? 0)
    this.config = new ConfigPanel(extensionUri)
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    const media = vscode.Uri.joinPath(this.extensionUri, 'media')
    view.webview.options = { enableScripts: true, localResourceRoots: [media] }
    view.webview.html = webviewHtml(view.webview, media, ['common.js', 'view.js'], ['view.css'])
    view.webview.onDidReceiveMessage(m => {
      if (m?.type === 'ready') this.post()
      if (m?.type === 'choose') void this.choose()
      if (m?.type === 'setLimit') void this.setCostLimit()
      if (m?.type === 'detail') this.detail.show(m.part, this.session, this.snapshot?.contextTokens ?? 0)
      if (m?.type === 'section') void this.saveSection(m.id, !!m.open)
      if (m?.type === 'configure') this.configure()
    })
    view.onDidChangeVisibility(() => view.visible && this.post())
  }

  tick(): void {
    const s = settings()
    // New prices or model map: every figure is re-priced from the transcript's token counts.
    setPriceOverrides(s.prices)
    if (priceVersion() !== this.pricedAt) {
      this.pricedAt = priceVersion()
      this.snapshot = undefined
      this.config.update()
    }
    this.follow(s.root, this.ticks++ % 4 === 0)
    if (!this.session) {
      this.snapshot = undefined
      this.status.render(undefined)
      return
    }
    const isChanged = this.session.refresh()
    if (isChanged || !this.snapshot || this.ticks % 10 === 0) {
      this.snapshot = buildSnapshot(this.session, s.thresholds, s.window)
      this.post()
      if (this.detail.isOpen) this.detail.update(this.session, this.snapshot.contextTokens)
    }
    this.status.render(this.snapshot)
  }

  // The open conversation is checked every tick so /clear switches within ~1.5s; the newest-file
  // fallback lists every transcript, so it runs on every 4th tick only.
  private follow(root: string, canScan: boolean): void {
    const live = this.pinned ? undefined : liveSessions(root, workspacePaths())[0]
    this.following = this.pinned ? 'pinned' : live ? 'open' : 'latest'
    const target =
      this.pinned ??
      (live ? transcriptFile(root, live) : canScan ? listSessions(workspaceDirs(root))[0]?.file : this.session?.file)
    if (target && target !== this.session?.file) {
      this.session = new Session(target)
      this.snapshot = undefined
    }
  }

  // Section: Commands
  // Choose a session, go back to following the open conversation, set the cost limit, configure
  // prices and models.
  async choose(): Promise<void> {
    const root = settings().root
    const open = new Set(liveSessions(root, workspacePaths()).map(l => transcriptFile(root, l).toLowerCase()))
    const items = listSessions(workspaceDirs(root))
      .slice(0, 30)
      .map(f => ({
        label: quickTitle(f.file) || path.basename(f.file, '.jsonl'),
        description: `${open.has(f.file.toLowerCase()) ? 'open · ' : ''}${new Date(f.mtimeMs).toLocaleString()}`,
        file: f.file,
      }))
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Session to monitor' })
    if (!pick) return
    this.pinned = pick.file
    this.restart()
  }

  followLatest(): void {
    this.pinned = undefined
    this.restart()
  }

  async setCostLimit(): Promise<void> {
    const current = settings().thresholds.costLimit
    const value = await vscode.window.showInputBox({
      title: 'Session cost limit (USD)',
      prompt: 'The panel and status bar turn red once a session costs this much. 0 turns it off.',
      value: current > 0 ? String(current) : '',
      validateInput: v => (v.trim() === '' || (Number.isFinite(Number(v)) && Number(v) >= 0) ? null : 'Enter a dollar amount, e.g. 5'),
    })
    if (value === undefined) return
    await saveCostLimit(Number(value) || 0)
    this.snapshot = undefined
    this.tick()
  }

  configure(): void {
    this.config.show()
  }

  private async saveSection(id: string, open: boolean): Promise<void> {
    await this.state.update('sections', { ...this.state.get<Record<string, boolean>>('sections', {}), [id]: open })
  }

  private restart(): void {
    this.ticks = 0
    this.tick()
  }

  private post(): void {
    if (!this.view?.visible) return
    void this.view.webview.postMessage({ type: 'snapshot', snapshot: this.snapshot ?? null, following: this.following, sections: this.state.get('sections', {}) })
  }

  dispose(): void {
    this.status.dispose()
    this.detail.dispose()
    this.config.dispose()
  }
}
