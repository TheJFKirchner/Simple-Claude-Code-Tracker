import * as vscode from 'vscode'

// Section: Webview shell
// Static HTML that loads the given scripts and stylesheets from media/; data arrives by postMessage.
export function webviewHtml(webview: vscode.Webview, media: vscode.Uri, scripts: string[], styles: string[]): string {
  const nonce = Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join('')
  const uri = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(media, f))
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
${styles.map(f => `<link rel="stylesheet" href="${uri(f)}">`).join('\n')}
</head>
<body>
<div id="root"><p class="muted">Looking for a Claude Code session…</p></div>
<div id="tip" class="tip" hidden></div>
${scripts.map(f => `<script nonce="${nonce}" src="${uri(f)}"></script>`).join('\n')}
</body>
</html>`
}
