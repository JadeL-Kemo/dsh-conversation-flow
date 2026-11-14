/**
 * Host smoke test: mount the real plugin `apply()` against a minimal Cordis
 * fake. Proves the plugin registers its commands, routes and event listeners
 * without touching a live DSH, and that a bare command invocation renders the
 * candidate list. Runs against the real checkpoint store; the created session
 * store directory is removed afterwards.
 */
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply, inject, name } from '../lib/index.js'
import { CheckpointStore } from '../lib/store.js'

function text(value) {
  return [{ type: 'text', text: value }]
}

function fakeSession(id) {
  const events = [
    { seq: 0, type: 'request/header', data: {} },
    { seq: 1, type: 'turn/start', data: { turn: 1 } },
    { seq: 2, type: 'user/message', surfaceOp: 'append', data: { id: 'u1', role: 'user', content: text('第一轮问题'), source: { kind: 'user' } } },
    { seq: 3, type: 'assistant/message', surfaceOp: 'append', data: { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: text('回答') } } },
    { seq: 4, type: 'turn/end', data: { turn: 1, reason: { kind: 'stop' } } },
  ]
  return {
    id,
    header: { version: 4, cwd: process.cwd(), delegationDepth: 0 },
    snapshotEvents: () => events,
    surface: { nodes: [2, 3] },
    append() {
      throw new Error('append not exercised in this smoke test')
    },
  }
}

function fakeCtx(record) {
  return {
    logger: { warn() {}, error() {}, info() {} },
    commands: {
      register(command) {
        record.commands.push(command)
        return () => {}
      },
    },
    effect(effect) {
      record.effects.push(effect)
      if (typeof effect === 'function') {
        const run = effect()
        if (run !== undefined && typeof run[Symbol.iterator] === 'function') {
          for (const _value of run) {
            // registration effects yield disposers; not needed here
          }
        }
      }
    },
    on(event, handler, options) {
      record.listeners.push({ event, handler, options })
      return () => {}
    },
    get() {
      return undefined
    },
    inject(_deps, callback) {
      const scope = {
        connection: {
          fetch: {
            register(route) {
              record.routes.push(route)
              return async () => {}
            },
          },
        },
        get() {
          return undefined
        },
        effect(effect) {
          record.effects.push(effect)
          if (typeof effect === 'function') effect()
        },
      }
      callback(scope)
    },
  }
}

test('host plugin exports its identity', () => {
  assert.equal(name, 'dsh-conversation-flow')
  assert.deepEqual(inject, ['commands'])
})

test('apply registers three commands, three routes and the two lifecycle listeners', async () => {
  const record = { commands: [], routes: [], listeners: [], effects: [] }
  apply(fakeCtx(record))
  assert.deepEqual(record.commands.map(command => command.name).sort(), ['flow-drop', 'flow-regen', 'flow-rewind'])
  assert.deepEqual(record.routes.map(route => route.path).sort(), [
    '/api/dsh-conversation-flow/delete-session',
    '/api/dsh-conversation-flow/execute',
    '/api/dsh-conversation-flow/status',
  ])
  assert.deepEqual(record.listeners.map(listener => listener.event).sort(), ['agent/pre-step', 'tools/execute'])
  assert.equal(record.listeners.find(listener => listener.event === 'agent/pre-step').options.prepend, true)
})

test('bare /flow-rewind lists candidates from the fake session', async () => {
  const record = { commands: [], routes: [], listeners: [], effects: [] }
  apply(fakeCtx(record))
  const session = fakeSession('smoke-session')
  const command = record.commands.find(entry => entry.name === 'flow-rewind')
  const result = await command.handler({ agent: { session }, rawInput: '', signal: new AbortController().signal })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /第一轮问题/)
  assert.match(result.text, /序号/)
})

test('status route answers 404 when the session is not attached', async () => {
  const record = { commands: [], routes: [], listeners: [], effects: [] }
  apply(fakeCtx(record))
  const route = record.routes.find(entry => entry.path === '/api/dsh-conversation-flow/status')
  const request = new Request('http://localhost/api/dsh-conversation-flow/status', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'session-missing' }),
  })
  const response = await route.fetch(request)
  assert.equal(response.status, 404)
  const payload = await response.json()
  assert.equal(payload.ok, false)
  assert.equal(payload.error.code, 'session-not-open')
})

test('delete route answers 503 when session persistence is unavailable', async () => {
  const record = { commands: [], routes: [], listeners: [], effects: [] }
  apply(fakeCtx(record))
  const route = record.routes.find(entry => entry.path === '/api/dsh-conversation-flow/delete-session')
  const request = new Request('http://localhost/api/dsh-conversation-flow/delete-session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'session-1' }),
  })
  const response = await route.fetch(request)
  assert.equal(response.status, 503)
  const payload = await response.json()
  assert.equal(payload.error.code, 'persistence-unavailable')
})

test('execute route rejects an edit without content', async () => {
  const record = { commands: [], routes: [], listeners: [], effects: [] }
  apply(fakeCtx(record))
  const route = record.routes.find(entry => entry.path === '/api/dsh-conversation-flow/execute')
  const request = new Request('http://localhost/api/dsh-conversation-flow/execute', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'session-1', targetSeq: 2, mode: 'edit', content: '   ' }),
  })
  const response = await route.fetch(request)
  assert.equal(response.status, 400)
  const payload = await response.json()
  assert.equal(payload.error.code, 'bad-request')
})

test('tools/execute listener forwards non-tracked tools untouched', async () => {
  const record = { commands: [], routes: [], listeners: [], effects: [] }
  apply(fakeCtx(record))
  const listener = record.listeners.find(entry => entry.event === 'tools/execute')
  let nextCalled = false
  const result = await listener.handler(
    { name: 'bash', arguments: {}, agent: { session: fakeSession('smoke-session-2') } },
    async () => {
      nextCalled = true
      return 'result'
    },
  )
  assert.equal(nextCalled, true)
  assert.equal(result, 'result')
})

test('pre-step listener creates a checkpoint for admitted human messages', async () => {
  const record = { commands: [], routes: [], listeners: [], effects: [] }
  const sessionId = 'smoke-pre-step-session'
  apply(fakeCtx(record))
  const listener = record.listeners.find(entry => entry.event === 'agent/pre-step')
  const storeDir = join(homedir(), '.dsh', 'conversation-flow', sessionId)
  try {
    const decision = await listener.handler({ agent: { session: fakeSession(sessionId) } }, async () => ({
      kind: 'enter',
      messages: [{ id: 'u1', source: { kind: 'user' } }],
    }))
    assert.equal(decision.kind, 'enter')
    const store = new CheckpointStore()
    assert.ok((await store.checkpointCount(sessionId)) >= 1)
  } finally {
    await fs.rm(storeDir, { recursive: true, force: true })
  }
})
