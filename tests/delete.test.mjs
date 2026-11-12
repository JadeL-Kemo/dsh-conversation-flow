/**
 * Session deletion tests: layout helpers, the trash move, and the structured
 * delete results against a fake host (no live DSH involved).
 */
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  deleteSession,
  encodeSegment,
  isInside,
  moveToTrash,
  projectKey,
  removeProjectionCache,
  sessionDir,
} from '../lib/delete.js'

const CWD = 'H:\\AgentWorkspace\\Other'

async function makeFixture() {
  const base = await fs.mkdtemp(join(tmpdir(), 'cf-delete-'))
  const root = join(base, '.dsh', 'sessions')
  const dir = join(root, projectKey(CWD), 'session-1')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(join(dir, 'session.v4.jsonl.zstd'), 'payload')
  return { base, root, dir }
}

test('layout helpers mirror the persistence backend', () => {
  assert.equal(projectKey(CWD), '--H-AgentWorkspace-Other--')
  assert.equal(encodeSegment('session-abc.def'), 'session-abc.def')
  assert.equal(encodeSegment('a/b'), 'a~002Fb')
  assert.equal(encodeSegment('.'), '~002E')
  assert.equal(sessionDir('R', CWD, 'session-1'), join('R', '--H-AgentWorkspace-Other--', 'session-1'))
  assert.equal(sessionDir('R', undefined, 'session-1'), join('R', '_no-cwd', 'session-1'))
  assert.equal(isInside('R', join('R', 'x')), true)
  assert.equal(isInside('R', join('R', '..', 'x')), false)
})

test('moveToTrash renames payloads, stashes the directory and writes a manifest', async () => {
  const { base, root, dir } = await makeFixture()
  try {
    const { trashDir, renamed } = await moveToTrash(root, dir, CWD, 'session-1')
    assert.equal(renamed.length, 1)
    assert.equal(renamed[0].to, 'session.v4.jsonl.zstd.trash')
    await assert.rejects(fs.stat(dir))
    const payload = join(trashDir, 'session.v4.jsonl.zstd.trash')
    assert.equal(await fs.readFile(payload, 'utf8'), 'payload')
    const manifest = JSON.parse(await fs.readFile(join(trashDir, 'manifest.json'), 'utf8'))
    assert.equal(manifest.id, 'session-1')
    assert.equal(manifest.cwd, CWD)
    assert.deepEqual(manifest.files, [{ from: 'session.v4.jsonl.zstd', to: 'session.v4.jsonl.zstd.trash' }])
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})

test('deleteSession reports a structured 404 for an unknown id', async () => {
  const { base, root } = await makeFixture()
  try {
    const result = await deleteSession(
      {
        persistence: { config: { root }, list: async () => [] },
      },
      'session-missing',
    )
    assert.equal(result.status, 404)
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'session-not-found')
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})

test('deleteSession moves a cold session into the trash and detaches the workspace', async () => {
  const { base, root, dir } = await makeFixture()
  try {
    const detached = []
    const result = await deleteSession(
      {
        persistence: {
          config: { root },
          list: async () => [{ id: 'session-1', cwd: CWD }],
        },
        workspaceRegistry: {
          list: () => [{ detachSession: async id => void detached.push(id) }],
        },
      },
      'session-1',
    )
    assert.equal(result.status, 200)
    assert.equal(result.ok, true)
    assert.equal(result.deleted, 'session-1')
    assert.deepEqual(detached, ['session-1'])
    await assert.rejects(fs.stat(dir))
    const trash = await fs.readdir(join(root, '.sessions-trash'))
    assert.equal(trash.length, 1)
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})

test('deleteSession refuses a live session whose agent has no disposal face', async () => {
  const { base, root } = await makeFixture()
  try {
    const result = await deleteSession(
      {
        persistence: { config: { root }, list: async () => [{ id: 'session-1', cwd: CWD }] },
        sessions: { get: () => ({}), flush: async () => {} },
        agents: { get: () => ({ status: 'running' }) },
      },
      'session-1',
    )
    assert.equal(result.status, 409)
    assert.equal(result.error.code, 'session-busy')
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})

test('deleteSession stops and deletes a live session through the disposal face', async () => {
  const { base, root } = await makeFixture()
  try {
    const calls = []
    const result = await deleteSession(
      {
        persistence: { config: { root }, list: async () => [{ id: 'session-1', cwd: CWD }] },
        sessions: { get: () => ({ live: true }), flush: async () => void calls.push('flush') },
        agents: {
          get: () => ({
            cancel: cause => void calls.push(`cancel:${cause.kind}`),
            whenIdle: async () => void calls.push('idle'),
          }),
        },
      },
      'session-1',
    )
    assert.equal(result.status, 200)
    assert.deepEqual(calls, ['cancel:disposed', 'idle', 'flush'])
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})

test('removeProjectionCache removes the matching cache file only', async () => {
  const base = await fs.mkdtemp(join(tmpdir(), 'cf-projcache-'))
  try {
    const root = join(base, '.dsh', 'sessions')
    const cacheDir = join(base, '.dsh', 'storages', 'session_projcache', 'sessions')
    await fs.mkdir(cacheDir, { recursive: true })
    await fs.writeFile(join(cacheDir, 'session-1.json'), '{}')
    await fs.writeFile(join(cacheDir, 'session-2.json'), '{}')
    await removeProjectionCache(root, 'session-1')
    await assert.rejects(fs.stat(join(cacheDir, 'session-1.json')))
    assert.equal(await fs.readFile(join(cacheDir, 'session-2.json'), 'utf8'), '{}')
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})
