import * as vscode from 'vscode'

import type { Thresholds } from './analysis/types'
import { allProjectDirs, claudeDir, projectDir } from './data/discovery'
import type { PriceCard, PriceOverrides } from './data/pricing'

// Section: Settings
// Reads the extension's configuration each tick so edits apply without a reload.
export type Settings = { root: string; window: number; thresholds: Thresholds; prices: PriceOverrides }

export function settings(): Settings {
  const c = vscode.workspace.getConfiguration('sessionMonitor')
  const t = c.get<Partial<Thresholds>>('thresholds') ?? {}
  return {
    root: claudeDir(c.get<string>('claudeConfigDir') ?? ''),
    window: c.get<number>('contextWindow') ?? 0,
    thresholds: {
      consider: t.consider ?? 50,
      wrapUp: t.wrapUp ?? 75,
      stop: t.stop ?? 90,
      freshTokens: c.get<number>('freshSessionTokens') ?? 200_000,
      longSessionRereads: c.get<number>('longSessionRereads') ?? 30,
      costLimit: c.get<number>('sessionCostLimit') ?? 0,
    },
    prices: priceSettings(c),
  }
}

// Hand-edited settings may hold anything: keeps numbers >= 0 and string targets, drops the rest.
function priceSettings(c: vscode.WorkspaceConfiguration): PriceOverrides {
  const custom = c.get<any>('customPrices') ?? {}
  const isPrice = (v: unknown): v is number => typeof v === 'number' && v >= 0
  const models: Record<string, Partial<PriceCard>> = {}
  for (const [id, m] of Object.entries<any>(custom.models ?? {})) {
    const card: Partial<PriceCard> = {}
    for (const f of ['input', 'output', 'cacheRead'] as const) if (isPrice(m?.[f])) card[f] = m[f]
    if (Object.keys(card).length) models[id.toLowerCase()] = card
  }
  const modelMap: Record<string, string> = {}
  for (const [name, id] of Object.entries<unknown>(c.get<Record<string, unknown>>('modelMap') ?? {})) if (typeof id === 'string' && name.trim()) modelMap[name] = id
  return { discountPercent: isPrice(custom.discountPercent) ? Math.min(100, custom.discountPercent) : 0, models, modelMap }
}

// Saved in the user's global settings, so the limit holds for every session and workspace.
export async function saveCostLimit(value: number): Promise<void> {
  await vscode.workspace.getConfiguration('sessionMonitor').update('sessionCostLimit', value, vscode.ConfigurationTarget.Global)
}

// Prices and the model map are saved where they are already set: a workspace that ships a shared
// setup keeps it, everyone else gets their user settings.
export async function savePriceSetting(key: 'customPrices' | 'modelMap', value: object): Promise<void> {
  const c = vscode.workspace.getConfiguration('sessionMonitor')
  const target = c.inspect(key)?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global
  await c.update(key, Object.keys(value).length ? value : undefined, target)
}

// Section: Transcript folders
// The open workspace's folders, and their Claude Code project folders (else every project).
export function workspacePaths(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath)
}

export function workspaceDirs(root: string): string[] {
  const dirs = workspacePaths()
    .map(w => projectDir(root, w))
    .filter((d): d is string => !!d)
  return dirs.length ? dirs : allProjectDirs(root)
}
