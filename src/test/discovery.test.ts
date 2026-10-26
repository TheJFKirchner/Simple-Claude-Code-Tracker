import * as assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test } from 'node:test'

import { liveSessions, transcriptFile } from '../data/discovery'

// Section: Fixtures
// A temp Claude config folder with sessions/<pid>.json files shaped like Claude Code's.
const WS = path.join(os.tmpdir(), 'My Project')

function configDir(sessions: Record<number, object>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-'))
  fs.mkdirSync(path.join(root, 'sessions'))
  for (const [pid, s] of Object.entries(sessions)) {
    fs.writeFileSync(path.join(root, 'sessions', `${pid}.json`), JSON.stringify({ pid: Number(pid), ...s }))
  }
  fs.writeFileSync(path.join(root, 'sessions', `1.abc.key`), '{}')
  return root
}

const alive = (pid: number) => pid !== 4

// Section: Open conversations
test('follows the busy conversation in this workspace, then the most recently updated', () => {
  const root = configDir({
    1: { sessionId: 'idle-new', cwd: WS, status: 'idle', updatedAt: 300 },
    2: { sessionId: 'busy-old', cwd: WS.toLowerCase(), status: 'busy', updatedAt: 100 },
    3: { sessionId: 'other-ws', cwd: path.join(os.tmpdir(), 'Other'), status: 'busy', updatedAt: 900 },
    4: { sessionId: 'dead', cwd: WS, status: 'busy', updatedAt: 999 },
  })
  assert.deepEqual(
    liveSessions(root, [WS], alive).map(s => s.sessionId),
    ['busy-old', 'idle-new'],
  )
})

test('no sessions folder means no open conversations', () => {
  assert.deepEqual(liveSessions(path.join(os.tmpdir(), 'sm-missing'), [WS], alive), [])
})

test('a conversation with no messages yet points at its future transcript', () => {
  const root = configDir({})
  const file = transcriptFile(root, { pid: 1, sessionId: 'abc', cwd: WS, isBusy: false, updatedAt: 0 })
  assert.equal(path.basename(file), 'abc.jsonl')
  assert.equal(path.basename(path.dirname(file)), WS.replace(/[^a-zA-Z0-9]/g, '-'))
})
