// Section: Formatting
// Short numbers for the status bar and flag text (the webview has its own copy in view.js).
export function tok(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`
  return String(Math.round(n))
}

export function usd(n: number): string {
  return n > 0 && n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`
}

export function minutes(n: number): string {
  return n >= 120 ? `${Math.round(n / 60)}h` : `${Math.max(1, Math.round(n))} min`
}
