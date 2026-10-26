import * as vscode from 'vscode'

import { Monitor } from './ui/monitor'

// Section: Activation
// Registers the panel and commands and starts the 1.5s poll.
export function activate(ctx: vscode.ExtensionContext): void {
  const monitor = new Monitor(ctx.extensionUri, ctx.globalState)
  ctx.subscriptions.push(
    monitor,
    vscode.window.registerWebviewViewProvider('sessionMonitor.panel', monitor, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('sessionMonitor.chooseSession', () => monitor.choose()),
    vscode.commands.registerCommand('sessionMonitor.followLatest', () => monitor.followLatest()),
    vscode.commands.registerCommand('sessionMonitor.setCostLimit', () => monitor.setCostLimit()),
  )
  monitor.tick()
  const timer = setInterval(() => monitor.tick(), 1500)
  ctx.subscriptions.push({ dispose: () => clearInterval(timer) })
}

export function deactivate(): void {}
