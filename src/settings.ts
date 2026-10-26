import * as vscode from 'vscode'

import type { Thresholds } from './analysis/types'
import { allProjectDirs, claudeDir, projectDir } from './data/discovery'

// Section: Settings
// Reads the extension's configuration each tick so edits apply without a reload.
export type Settings = { root: string; window: number; thresholds: Thresholds }

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
  }
}

// Saved in the user's global settings, so the limit holds for every session and workspace.
export async function saveCostLimit(value: number): Promise<void> {
  await vscode.workspace.getConfiguration('sessionMonitor').update('sessionCostLimit', value, vscode.ConfigurationTarget.Global)
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
