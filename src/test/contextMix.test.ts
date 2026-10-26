import * as assert from 'node:assert/strict'
import { test } from 'node:test'

import { ContextMix, fileKind, imageSize, pdfPages, type Part } from '../data/contextMix'

// Section: Fixtures
// Synthetic records shaped like Claude Code's JSONL: a tool call and its result, a prompt, a skill body.
let n = 0
const uuid = () => `u${++n}`

function call(msgId: string, toolId: string, name: string, input: object, output = 0): any {
  return { type: 'assistant', uuid: uuid(), message: { id: msgId, model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: toolId, name, input }], usage: { output_tokens: output } } }
}

function result(toolId: string, chars: number): any {
  return { type: 'user', uuid: uuid(), message: { content: [{ type: 'tool_result', tool_use_id: toolId, content: 'x'.repeat(chars) }] } }
}

function mix(records: any[]): ContextMix {
  const m = new ContextMix()
  for (const r of records) m.ingest(r)
  return m
}

function share(m: ContextMix, part: Part, context = 10_000): number {
  const parts = m.parts(context)
  return parts.find(p => p.part === part)!.tokens / context
}

// Section: Sorting
test('file extensions group into md, scripts, sql & data and other', () => {
  assert.deepEqual(
    ['wiki/home.md', 'a.ts', 'run.PY', 'view.css', 'q.sql', 'claims.csv', 'book.xlsx', 'package.json', 'Makefile'].map(fileKind),
    ['md', 'scripts', 'scripts', 'scripts', 'sql', 'sql', 'sql', 'otherFiles', 'otherFiles'],
  )
})

test('tool results land in the part of the tool that produced them', () => {
  const m = mix([
    call('m1', 't1', 'Read', { file_path: 'notes.md' }),
    result('t1', 4000),
    call('m2', 't2', 'Bash', { command: 'ls' }),
    result('t2', 4000),
    call('m3', 't3', 'Skill', { skill: 'dataviz' }),
    result('t3', 100),
    { type: 'user', uuid: uuid(), isMeta: true, sourceToolUseID: 't3', message: { content: [{ type: 'text', text: 'y'.repeat(3900) }] } },
  ])
  assert.ok(Math.abs(share(m, 'md') - share(m, 'commands')) < 1e-9)
  assert.ok(Math.abs(share(m, 'skills') - share(m, 'md')) < 1e-9)
})

test('system reminders are overhead, typed text is the user', () => {
  const m = mix([
    { type: 'user', uuid: uuid(), message: { content: [{ type: 'text', text: '<system-reminder>' + 'r'.repeat(983) }, { type: 'text', text: 'p'.repeat(1000) }] } },
  ])
  assert.ok(Math.abs(share(m, 'overhead') - 0.5) < 1e-9)
  assert.ok(Math.abs(share(m, 'you') - 0.5) < 1e-9)
})

// Section: Scaling
test('parts add up to the context, with thinking as output beyond the visible reply', () => {
  const m = mix([call('m1', 't1', 'Bash', { command: 'x'.repeat(334) }, 1100), result('t1', 6000)])
  const parts = m.parts(10_000)
  const sum = parts.reduce((s, p) => s + p.tokens, 0)
  assert.ok(Math.abs(sum - 10_000) < 1e-6)
  assert.ok(Math.abs(parts.find(p => p.part === 'thinking')!.tokens - 1000) < 1)
})

test('a re-read record is counted once', () => {
  const r = result('t1', 1000)
  const m = mix([call('m1', 't1', 'Read', { file_path: 'a.sql' }), r, r])
  const once = mix([call('m1', 't1', 'Read', { file_path: 'a.sql' }), result('t1', 1000)])
  assert.equal(share(m, 'sql'), share(once, 'sql'))
})

test('compaction drops the conversation', () => {
  const m = mix([call('m1', 't1', 'Read', { file_path: 'a.md' }), result('t1', 5000), { type: 'system', subtype: 'compact_boundary' }, { type: 'user', uuid: uuid(), message: { content: 'next' } }])
  assert.equal(share(m, 'md'), 0)
  assert.equal(share(m, 'you'), 1)
})

// Section: Images
function png(w: number, h: number): string {
  const b = Buffer.alloc(33)
  b.writeUInt32BE(0x89504e47, 0)
  b.writeUInt32BE(w, 16)
  b.writeUInt32BE(h, 20)
  return b.toString('base64')
}

test('image size is read from PNG and JPEG headers', () => {
  assert.deepEqual(imageSize(Buffer.from(png(360, 1500), 'base64')), [360, 1500])
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0xbc, 0x01, 0x04, 0x03])
  assert.deepEqual(imageSize(jpeg), [260, 700])
})

test('a read image costs width × height / 750 tokens, outside the text scaling', () => {
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png(300, 750) } }
  const m = mix([
    call('m1', 't1', 'Read', { file_path: 'shot.png' }),
    { type: 'user', uuid: uuid(), message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [image] }] } },
    { type: 'user', uuid: uuid(), message: { content: 'p'.repeat(1000) } },
  ])
  assert.ok(Math.abs(share(m, 'otherFiles') * 10_000 - 300) < 1e-6)
})

test('a PDF costs its page count times the per-page estimate', () => {
  const pdf = Buffer.from('%PDF-1.7\n1 0 obj << /Type /Pages /Count 3 >>\n<< /Type /Page >> << /Type/Page >> << /Type /Page /Parent 1 0 R >>').toString('base64')
  assert.equal(pdfPages(Buffer.from(pdf, 'base64')), 3)
  const doc = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf } }
  const m = mix([
    call('m1', 't1', 'Read', { file_path: 'report.pdf' }),
    { type: 'user', uuid: uuid(), message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [doc] }] } },
    { type: 'user', uuid: uuid(), message: { content: 'p'.repeat(1000) } },
  ])
  assert.ok(Math.abs(share(m, 'otherFiles', 20_000) * 20_000 - 6_750) < 1e-6)
})

// Section: Detail
test('items add up to their part, and repeat reads of a file are one item', () => {
  const m = mix([
    call('m1', 't1', 'Read', { file_path: 'wiki/a.md' }),
    result('t1', 2000),
    call('m2', 't2', 'Read', { file_path: 'wiki/a.md' }),
    result('t2', 2000),
    call('m3', 't3', 'Read', { file_path: 'wiki/b.md' }),
    result('t3', 1000),
  ])
  const items = m.details(10_000, 'md')
  assert.deepEqual(items.map(i => [i.label, i.count]), [['wiki/a.md', 2], ['wiki/b.md', 1]])
  const total = items.reduce((s, i) => s + i.tokens, 0)
  assert.ok(Math.abs(total - share(m, 'md') * 10_000) < 1e-6)
})
