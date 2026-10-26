import * as path from 'path'
import * as vscode from 'vscode'

import type { MixItem, MixPart, Part } from '../data/contextMix'
import type { Session } from '../data/transcript'
import { webviewHtml } from './webviewShell'

// Section: Detail tab
// An editor tab listing every item in one part of "In context now" (each file, command, skill...),
// refreshed with the panel while it is open.
export type DetailData = { title: string; contextTokens: number; parts: MixPart[]; part: Part; items: MixItem[] }

export class DetailPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined
  private part: Part = 'overhead'

  constructor(private readonly extensionUri: vscode.Uri) {}

  get isOpen(): boolean {
    return !!this.panel
  }

  show(part: Part, session: Session | undefined, contextTokens: number): void {
    this.part = part
    if (!this.panel) {
      const media = vscode.Uri.joinPath(this.extensionUri, 'media')
      this.panel = vscode.window.createWebviewPanel('sessionMonitor.detail', 'Context detail', vscode.ViewColumn.Active, {
        enableScripts: true,
        localResourceRoots: [media],
      })
      this.panel.webview.html = webviewHtml(this.panel.webview, media, ['common.js', 'detail.js'], ['view.css', 'detail.css'])
      this.panel.onDidDispose(() => (this.panel = undefined))
      this.panel.webview.onDidReceiveMessage(m => {
        if (m?.type === 'part') this.part = m.part
        if (m?.type === 'part' || m?.type === 'ready') this.onRequest?.()
      })
    } else {
      this.panel.reveal()
    }
    this.update(session, contextTokens)
  }

  // Set by the monitor: re-sends data when the tab asks (loaded, or another part chosen).
  onRequest: (() => void) | undefined

  update(session: Session | undefined, contextTokens: number): void {
    if (!this.panel || !session) return
    const mix = session.main.mix
    const data: DetailData = {
      title: session.main.title || 'Untitled session',
      contextTokens,
      parts: mix.parts(contextTokens),
      part: this.part,
      items: mix.details(contextTokens, this.part).map(i => ({ ...i, label: shorten(i.label) })),
    }
    void this.panel.webview.postMessage({ type: 'detail', data })
  }

  dispose(): void {
    this.panel?.dispose()
  }
}

// File paths inside the open workspace are shown relative to it.
function shorten(label: string): string {
  for (const f of vscode.workspace.workspaceFolders ?? []) {
    const root = f.uri.fsPath
    if (label.toLowerCase().startsWith(root.toLowerCase() + path.sep)) return label.slice(root.length + 1)
  }
  return label
}
