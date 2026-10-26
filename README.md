# Claude Session Monitor

A VS Code side panel and status-bar item for the Claude Code conversation open in the current workspace: what it costs, how full the context is, what fills it, when the prompt cache expires, and whether to keep going, hand off or start fresh.

It only reads Claude Code's local files. No model calls, no network requests, nothing added to Claude's context.

## Install

Needs Node 20+ and the `code` command on your PATH.

```
npm install
npm test                # compile and run the test suite
npm run install-ext     # compile, package session-monitor.vsix, install into VS Code
```

Then run "Developer: Reload Window". To install on another machine without building, copy `session-monitor.vsix` and run `code --install-extension session-monitor.vsix`.

## Prices

Dollar figures start from `prices.json` at the top of this folder: Anthropic's public API list prices in US dollars per million tokens, cache-write multipliers and context windows. It ships with the extension; to change the list itself, edit it and run `npm run install-ext` again.

If you pay different rates (an enterprise agreement, Bedrock, Vertex), click the gear at the top of the panel ("Session Monitor: Configure prices and models"). The tab that opens has three parts:

- **Your models**: every model name found in your transcripts, what it is priced as, and why (recognised by name, set by you, by a rule, or not recognised and priced as the fallback model). Pick a model to price a name as.
- **Rules**: names, or the start of names, mapped to a model, for names that change, such as Bedrock inference-profile ARNs or gateway aliases.
- **Prices**: a discount off every list price, and per-model input, output and cache-read prices that replace it. Cache writes follow input; Haiku's over-100K prices move by the same ratio.

Changes are saved to your settings (`sessionMonitor.customPrices`, `sessionMonitor.modelMap`) and re-price every session at once, past ones included, because costs are worked out from the token counts in the transcripts. When a workspace sets them in `.vscode/settings.json`, edits are saved there, so a team can share one setup by committing that file. Names are matched without regard to case: the model map first (exact name, then the longest rule the name starts with), then the price table after removing provider wrapping (`eu.anthropic.`, `global.anthropic.`, ARN and gateway paths), then the fallback model, shown as "price guessed".

## What the panel shows

- **Advice**: keep going → think about a new session → wrap up → don't send, from context size, cost limit and flags. A dead cache TTL turns the panel red.
- **Estimated cost of next message**, including re-caching a stale conversation.
- **Context**: size against the window, re-read multiplier, buildup per turn, and "In context now", one stacked line of what fills it (overhead, your messages, Claude's replies, thinking, MD files, scripts, SQL & data, other files, command output, skills & agents). The total is exact; the split is estimated. Click any part for a detail tab listing every file, command, skill or tool definition in it.
- **If you hand off now**: a new session started from a handoff file (your messages, Claude's last reply per turn, files touched, a short summary), with and without re-reading every markdown file, and a chart of the cumulative cost of the next 10 messages, carrying on vs handing off.
- **Tokens & cost** by billing type, **Threads** (each subagent's tokens and cost), and **Flags & tips** in plain language.

Section headings collapse; your choices are remembered.

## Settings

| Setting | Default | |
|---|---|---|
| `sessionMonitor.sessionCostLimit` | 0 (off) | USD at which the panel turns red. Also "Session Monitor: Set session cost limit". |
| `sessionMonitor.thresholds` | 50 / 75 / 90 | Context % for "new session?", "wrap up", "don't send". |
| `sessionMonitor.freshSessionTokens` | 200000 | Context size that suggests a new session. |
| `sessionMonitor.longSessionRereads` | 30 | Re-read multiplier that flags a long session. |
| `sessionMonitor.contextWindow` | 0 (from model) | Override the context window. |
| `sessionMonitor.customPrices` | none | Your prices: `discountPercent`, and `models` with per-model `input` / `output` / `cacheRead`. Set from the gear. |
| `sessionMonitor.modelMap` | none | Recorded model name (or the start of one) → price-table model. Set from the gear. |
| `sessionMonitor.claudeConfigDir` | `CLAUDE_CONFIG_DIR`, else `~/.claude` | Claude Code's config folder. |

Commands: "Choose session" pins a conversation; "Follow open conversation" goes back to following the live one; "Configure prices and models" opens the prices tab (also the gear on the panel).

## How it finds the conversation

It follows the running Claude Code conversation for this workspace from `~/.claude/sessions/<pid>.json` (busy first, else the most recently updated), so `/clear` switches it within a couple of seconds. Without those files it follows the newest transcript in `~/.claude/projects/<workspace>/`.

These files, and the logged request it uses to measure overhead, are Claude Code internals with no documentation. A different Claude Code version can change them; the panel falls back to the newest transcript, and overhead reads low without the logged request.

## Privacy

Transcripts contain whole conversations. The extension reads them locally and shows file paths and command text in the detail tab, so mind what is on screen when sharing it. The webviews block all network access.

## Layout

```
src/
  extension.ts          activation and commands
  settings.ts           extension settings, saved cost limit, transcript folders for the workspace
  data/                 reading Claude Code's files: transcript parser, context mix, session discovery, prices
  analysis/             a session → snapshot: next-message estimate, cache events, flags, advice, handoff
  ui/                   panel provider and session following, detail tab, prices tab, status bar, webview HTML shell
  test/                 node:test suite on synthetic transcripts
media/                  panel (view.js/.css), detail tab (detail.js/.css), prices tab (config.js/.css), shared helpers (common.js), icon
scripts/backtest.js     checks the next-message estimate against past sessions (npm run backtest)
prices.json             the list-price table
overview.html           one-page, non-technical overview for coworkers
```
