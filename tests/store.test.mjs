/**
 * Checkpoint-store tests: dense capture, first-touch capture, restore to an
 * earlier checkpoint, restore of a file first touched in a later turn, and the
 * fail-closed path for a newer store version. All state lives in an OS temp
 * directory; no DSH runtime involved.
 */
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CheckpointStore, STORE_VERSION } from '../lib/store.js'

async function makeWorkspace() {
  const root = await fs.mkdtemp(join(tmpdir(), 'conversation-flow-store-'))
  const workspace = join(root, 'workspace')
  await fs.mkdir(workspace, { recursive: true })
  const a = join(workspace, 'a.txt')
  const b = join(workspace, 'b.txt')
  const c = join(workspace, 'c.txt')
  await fs.writeFile(a, 'a-v1')
  await fs.writeFile(b, 'b-v1')
  return { root, workspace, a, b, c, store: new CheckpointStore(join(root, 'store')) }
}

test('restore returns files to the state captured for the target message', async () => {
  const { root, a, b, c, store } = await makeWorkspace()
  try {
    // Turn 1: message m1, no tracked files yet.
    await store.beginStep('s1', ['m1'])
    await store.captureFirstTouch('s1', a)
    await fs.writeFile(a, 'a-v2')
    await store.captureFirstTouch('s1', b)
    await fs.writeFile(b, 'b-v2')
    await store.captureFirstTouch('s1', c)
    await fs.writeFile(c, 'c-created')
    // Turn 2: message m2, dense checkpoint sees a-v2/b-v2/c-created.
    await store.beginStep('s1', ['m2'])
    await fs.writeFile(a, 'a-v3')
    await fs.writeFile(b, 'b-v3')
    await fs.unlink(b)
    await fs.writeFile(c, 'c-v2')

    const toM2 = await store.restore('s1', 'm2')
    assert.equal(await fs.readFile(a, 'utf8'), 'a-v2')
    assert.equal(await fs.readFile(b, 'utf8'), 'b-v2')
    assert.equal(await fs.readFile(c, 'utf8'), 'c-created')
    assert.deepEqual(toM2.restored.sort(), [a, b, c].sort())

    // Rewind further back to m1: a/b return to their pre-first-touch state and
    // c (created after m1) is removed again.
    const toM1 = await store.restore('s1', 'm1')
    assert.equal(await fs.readFile(a, 'utf8'), 'a-v1')
    assert.equal(await fs.readFile(b, 'utf8'), 'b-v1')
    await assert.rejects(fs.readFile(c), error => error.code === 'ENOENT')
    assert.equal(toM1.deleted.length, 1)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('restore is a no-op when the workspace already matches', async () => {
  const { root, a, store } = await makeWorkspace()
  try {
    await store.beginStep('s2', ['m1'])
    await store.captureFirstTouch('s2', a)
    const report = await store.restore('s2', 'm1')
    assert.deepEqual(report.restored, [])
    assert.deepEqual(report.deleted, [])
    assert.deepEqual(report.unchanged, [a])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('restore for an unknown message fails closed with restore-unavailable', async () => {
  const { root, store } = await makeWorkspace()
  try {
    await store.beginStep('s3', ['m1'])
    await assert.rejects(store.restore('s3', 'nope'), error => error.code === 'restore-unavailable')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('restore refuses a store written by a newer version', async () => {
  const { root, workspace, store } = await makeWorkspace()
  try {
    await store.beginStep('s4', ['m1'])
    const dir = join(root, 'store', 's4')
    const metaPath = join(dir, 'meta.json')
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'))
    meta.version = STORE_VERSION + 1
    await fs.writeFile(metaPath, JSON.stringify(meta))
    const fresh = new CheckpointStore(join(root, 'store'))
    await assert.rejects(fresh.restore('s4', 'm1'), error => error.code === 'restore-unavailable')
    assert.ok((await fs.readdir(workspace)).length >= 2)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('rewind records are append-only and readable back', async () => {
  const { root, store } = await makeWorkspace()
  try {
    await store.beginStep('s5', ['m1'])
    await store.appendRewind('s5', { markerSeq: 10, targetSeq: 2, shadowedTurns: [1] })
    await store.appendRewind('s5', { markerSeq: 20, targetSeq: 6, shadowedTurns: [2] })
    const records = await store.readRewinds('s5')
    assert.equal(records.length, 2)
    assert.deepEqual(records.map(record => record.markerSeq), [10, 20])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
