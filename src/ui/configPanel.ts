import * as vscode from 'vscode'

import { modelsInUse } from '../data/models'
import type { ModelUse } from '../data/models'
import { hasCustomPrices, modelInfo, nameMatch, PRICE_TABLE, priceOverrides, pricesFor } from '../data/pricing'
import type { Card, Match, PriceCard } from '../data/pricing'
import { savePriceSetting, settings } from '../settings'
import { webviewHtml } from './webviewShell'

// Section: Configure tab
// An editor tab for the user's own prices and model map: every model name found in the transcripts
// with what it is priced as, the map's rules, and a price row per model. Edits are saved to settings
// straight away; the monitor re-prices the session on its next tick.
export type ConfigModel = ModelUse & { pricedAs: string; match: Match; rule?: string; auto: string; autoMatch: Match }
export type ConfigPrice = { id: string; list: PriceCard; set: Partial<PriceCard>; card: Card; longAbove?: number; longCard?: Card; inUse: boolean }
export type ConfigData = {
  scanning: boolean
  models: ConfigModel[]
  rules: { name: string; target: string; isValid: boolean }[]
  prices: ConfigPrice[]
  discountPercent: number
  isCustom: boolean
  fallback: string
  ids: string[]
  writeMultipliers: { m5: number; h1: number }
}

export class ConfigPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined
  private models: ModelUse[] = []
  private scanning = false

  constructor(private readonly extensionUri: vscode.Uri) {}

  show(): void {
    if (this.panel) {
      this.panel.reveal()
      return
    }
    const media = vscode.Uri.joinPath(this.extensionUri, 'media')
    this.panel = vscode.window.createWebviewPanel('sessionMonitor.configure', 'Prices and models', vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [media],
    })
    this.panel.webview.html = webviewHtml(this.panel.webview, media, ['common.js', 'config.js'], ['view.css', 'detail.css', 'config.css'])
    this.panel.onDidDispose(() => (this.panel = undefined))
    this.panel.webview.onDidReceiveMessage(m => void this.receive(m))
  }

  private async receive(m: any): Promise<void> {
    if (m?.type === 'ready') {
      this.update()
      return this.scan()
    }
    if (m?.type === 'rescan') return this.scan()
    if (m?.type === 'map' && typeof m.name === 'string') return this.saveMap(m.name, typeof m.target === 'string' ? m.target : null)
    if (m?.type === 'price' && typeof m.id === 'string') return this.savePrice(m.id, m.field, m.value)
    if (m?.type === 'discount') return this.saveCustom({ ...this.custom(), discountPercent: Number(m.value) > 0 ? Math.min(100, Number(m.value)) : undefined })
    if (m?.type === 'resetPrices') return this.saveCustom({})
  }

  private async scan(): Promise<void> {
    this.scanning = true
    this.update()
    try {
      this.models = await modelsInUse(settings().root)
    } finally {
      this.scanning = false
      this.update()
    }
  }

  // Section: Saving
  // Map entries match names case-insensitively, so a new entry replaces any spelling of the same name.
  private async saveMap(name: string, target: string | null): Promise<void> {
    const key = name.trim()
    if (!key) return
    const map = Object.fromEntries(Object.entries(priceOverrides().modelMap).filter(([k]) => k.trim().toLowerCase() !== key.toLowerCase()))
    if (target) map[key] = target
    await savePriceSetting('modelMap', map)
  }

  private async savePrice(id: string, field: unknown, value: unknown): Promise<void> {
    if (field !== 'input' && field !== 'output' && field !== 'cacheRead') return
    const custom = this.custom()
    const models: Record<string, Partial<PriceCard>> = { ...(custom.models ?? {}) }
    const card: Partial<PriceCard> = { ...(models[id] ?? {}) }
    const n = typeof value === 'number' ? value : NaN
    if (n >= 0) card[field] = n
    else delete card[field]
    if (Object.keys(card).length) models[id] = card
    else delete models[id]
    await this.saveCustom({ ...custom, models: Object.keys(models).length ? models : undefined })
  }

  private custom(): { discountPercent?: number; models?: Record<string, Partial<PriceCard>> } {
    const o = priceOverrides()
    return { discountPercent: o.discountPercent || undefined, models: Object.keys(o.models).length ? o.models : undefined }
  }

  private async saveCustom(value: object): Promise<void> {
    const clean = Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined))
    await savePriceSetting('customPrices', clean)
  }

  // Section: Data
  // Called by the monitor whenever prices or the map change, and after each scan.
  update(): void {
    if (!this.panel) return
    const o = priceOverrides()
    const models = this.models.map((m): ConfigModel => {
      const info = modelInfo(m.name)
      const auto = nameMatch(m.name)
      return { ...m, pricedAs: info.id, match: info.match, rule: info.rule, auto: auto.id, autoMatch: auto.match }
    })
    const inUse = new Set([...models.map(m => m.pricedAs), ...Object.keys(o.models)])
    const prices = PRICE_TABLE.entries.map((e): ConfigPrice => {
      const r = pricesFor(e.id)!
      return { id: e.id, list: e.card, set: o.models[e.id] ?? {}, card: r.card, longAbove: r.longAbove, longCard: r.longCard, inUse: inUse.has(e.id) }
    })
    const ids = new Set(PRICE_TABLE.entries.map(e => e.id))
    const data: ConfigData = {
      scanning: this.scanning,
      models,
      rules: Object.entries(o.modelMap).map(([name, target]) => ({ name, target, isValid: ids.has(target.toLowerCase()) })),
      prices,
      discountPercent: o.discountPercent,
      isCustom: hasCustomPrices(),
      fallback: PRICE_TABLE.fallback,
      ids: [...ids],
      writeMultipliers: { m5: PRICE_TABLE.write5m, h1: PRICE_TABLE.write1h },
    }
    void this.panel.webview.postMessage({ type: 'config', data })
  }

  dispose(): void {
    this.panel?.dispose()
  }
}
