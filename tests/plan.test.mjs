/**
 * Unit tests for the pure planning module. Synthetic log/surface only: no
 * Session objects, no filesystem, no DSH runtime.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  FlowError,
  buildTurnSegments,
  formatCandidate,
  isHumanUserMessage,
  isSurfaceEvent,
  listCandidates,
  messagePreview,
  parseTarget,
  planRewind,
  surfaceUserTurns,
  turnsOfSeqs,
} from '../lib/plan.js'

const text = value => [{ type: 'text', text: value }]

/** @returns {object[]} */
function makeEvents() {
  return [
    { seq: 0, time: 1_700_000_000_000, type: 'request/header', data: {} },
    { seq: 1, time: 1_700_000_000_100, type: 'turn/start', data: { turn: 1 } },
    { seq: 2, time: 1_700_000_001_000, type: 'user/message', surfaceOp: 'append', data: { id: 'u1', role: 'user', content: text('第一轮问题'), source: { kind: 'user' } } },
    { seq: 3, time: 1_700_000_002_000, type: 'assistant/message', surfaceOp: 'append', data: { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: text('回答一') } } },
    { seq: 4, time: 1_700_000_003_000, type: 'turn/end', data: { turn: 1, reason: { kind: 'stop' } } },
    { seq: 5, time: 1_700_000_004_000, type: 'turn/start', data: { turn: 2 } },
    { seq: 6, time: 1_700_000_005_000, type: 'user/message', surfaceOp: 'append', data: { id: 'u2', role: 'user', content: text('第二轮问题'), source: { kind: 'user' } } },
    { seq: 7, time: 1_700_000_006_000, type: 'assistant/message', surfaceOp: 'append', data: { turn: 2, step: 1, message: { id: 'a2', role: 'assistant', content: text('回答二') } } },
    // Plugin-injected context also rides user/message: never a valid target.
    { seq: 8, time: 1_700_000_007_000, type: 'user/message', surfaceOp: 'append', data: { id: 'p1', role: 'user', content: text('context injection'), source: { kind: 'plugin' } } },
    { seq: 9, time: 1_700_000_008_000, type: 'turn/end', data: { turn: 2, reason: { kind: 'stop' } } },
  ]
}

const SURFACE = [2, 3, 6, 7, 8]

test('isHumanUserMessage only accepts user source kind', () => {
  const events = makeEvents()
  assert.equal(isHumanUserMessage(events.find(event => event.seq === 2)), true)
  assert.equal(isHumanUserMessage(events.find(event => event.seq === 8)), false)
  assert.equal(isHumanUserMessage(events.find(event => event.seq === 3)), false)
})

test('isSurfaceEvent requires a surface-eligible type with a surfaceOp', () => {
  const events = makeEvents()
  assert.equal(isSurfaceEvent(events.find(event => event.seq === 2)), true)
  assert.equal(isSurfaceEvent(events.find(event => event.seq === 1)), false)
  assert.equal(isSurfaceEvent({ seq: 9, type: 'user/message', data: {} }), false)
})

test('messagePreview joins text blocks and truncates', () => {
  assert.equal(messagePreview({ content: text('你好  世界') }), '你好 世界')
  assert.equal(messagePreview({ content: text('a'.repeat(100)) }, 10), 'aaaaaaaaa…')
  assert.equal(messagePreview({ content: [] }), '')
  assert.equal(messagePreview({}), '')
})

test('listCandidates is newest-first and skips injected user messages', () => {
  const candidates = listCandidates(makeEvents(), SURFACE)
  assert.deepEqual(candidates.map(candidate => candidate.seq), [6, 2])
  assert.deepEqual(candidates.map(candidate => candidate.index), [1, 2])
  assert.equal(candidates[0].preview, '第二轮问题')
})

test('listCandidates honors the limit', () => {
  const candidates = listCandidates(makeEvents(), SURFACE, 1)
  assert.deepEqual(candidates.map(candidate => candidate.seq), [6])
})

test('listCandidates excludes shadowed (off-surface) messages', () => {
  const candidates = listCandidates(makeEvents(), [6, 7])
  assert.deepEqual(candidates.map(candidate => candidate.seq), [6])
})

test('parseTarget accepts absolute seq and recency index', () => {
  assert.deepEqual(parseTarget('@6'), { kind: 'seq', seq: 6 })
  assert.deepEqual(parseTarget('2'), { kind: 'index', index: 2 })
  assert.equal(parseTarget('0'), undefined)
  assert.equal(parseTarget('@-1'), undefined)
  assert.equal(parseTarget('abc'), undefined)
  assert.equal(parseTarget(''), undefined)
  assert.deepEqual(parseTarget(' @12 '), { kind: 'seq', seq: 12 }, 'surrounding whitespace is trimmed')
})

test('planRewind cuts the target and every later surface node', () => {
  const plan = planRewind(makeEvents(), SURFACE, { kind: 'seq', seq: 6 })
  assert.deepEqual(plan.shadowedSeqs, [6, 7, 8])
  assert.equal(plan.surfaceStart, 6)
  assert.equal(plan.surfaceEnd, 8)
  assert.equal(plan.targetIndex, 2)
})

test('planRewind can resolve a recency index target', () => {
  const plan = planRewind(makeEvents(), SURFACE, { kind: 'index', index: 2 })
  assert.equal(plan.targetSeq, 2)
  assert.deepEqual(plan.shadowedSeqs, [2, 3, 6, 7, 8])
})

test('planRewind rejects bad ranges with typed errors', () => {
  const events = makeEvents()
  assert.throws(() => planRewind(events, [], { kind: 'seq', seq: 2 }), error => error instanceof FlowError && error.code === 'empty-surface')
  assert.throws(() => planRewind(events, SURFACE, { kind: 'seq', seq: 99 }), error => error instanceof FlowError && error.code === 'bad-target')
  assert.throws(() => planRewind(events, SURFACE, { kind: 'seq', seq: 3 }), error => error instanceof FlowError && error.code === 'not-human')
  assert.throws(() => planRewind(events, [6, 7], { kind: 'seq', seq: 2 }), error => error instanceof FlowError && error.code === 'not-on-surface')
  assert.throws(() => planRewind(events, SURFACE, { kind: 'index', index: 99 }), error => error instanceof FlowError && error.code === 'bad-target')
})

test('buildTurnSegments pairs turn/start and turn/end', () => {
  assert.deepEqual(buildTurnSegments(makeEvents()), [
    { turn: 1, startSeq: 1, endSeq: 4 },
    { turn: 2, startSeq: 5, endSeq: 9 },
  ])
})

test('turnsOfSeqs maps shadowed seqs to turn numbers', () => {
  const segments = buildTurnSegments(makeEvents())
  assert.deepEqual(turnsOfSeqs(segments, [6, 7, 8]), [2])
  assert.deepEqual(turnsOfSeqs(segments, [2, 6]), [1, 2])
})

test('surfaceUserTurns maps rendered turns to their opening user seq', () => {
  const turns = surfaceUserTurns(makeEvents(), SURFACE)
  assert.deepEqual(turns, [
    { turn: 2, userSeq: 6, turnStartSeq: 5, promptText: '第二轮问题' },
    { turn: 1, userSeq: 2, turnStartSeq: 1, promptText: '第一轮问题' },
  ])
})

test('formatCandidate renders index, time and preview', () => {
  const candidates = listCandidates(makeEvents(), SURFACE)
  const line = formatCandidate(candidates[0])
  assert.match(line, /^1\. \d{2}:\d{2} 第二轮问题$/)
})
