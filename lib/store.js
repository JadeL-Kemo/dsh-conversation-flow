/**
 * File checkpoint store for conversation-flow.
 *
 * One directory per session:
 *   <root>/<sessionId>/
 *     meta.json          {version, sessionId, tracked:[absPath], checkpoints:[...]}
 *     blobs/<sha256>     content-addressed file bodies
 *     rewind/<n>/        {markerSeq,targetSeq,targetTurn,mode,time,shadowedSeqs,shadowedTurns}
 *     cp/<n>/             checkpoint rows
 *
 * A checkpoint is a dense manifest of every tracked path at a point in time
 * (before the model is allowed to touch the workspace). Rows captured at
 * `tools/execute` time record the pre-touch state ("v1 rows") for paths the
 * manifest did not know yet, so the FIRST mutation of a file is still undoable.
 *
 * Restore policy for a tracked path (target = checkpoint index):
 *   - target checkpoint row present  -> exact state at target time;
 *   - else the earliest v1 row after target -> state before that first touch;
 *   - else leave the path alone (no evidence).
 *
 * Everything is plain Node fs, atomic where it matters (tmp + rename), and a
 * store version mismatch fails closed: files are never guessed, only replayed
 * from recorded bytes.
 */
import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'

export const STORE_VERSION = 1
export const RETAINED_CHECKPOINTS = 100
export const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024
export const STORE_DIR_NAME = 'conversation-flow'

/** Resolve the store root: %DSH_HOME%/.dsh/conversation-flow or ~/.dsh/conversation-flow. */
export function defaultStoreRoot(env = process.env) {
  const home = env.DSH_HOME !== undefined && env.DSH_HOME !== '' ? env.DSH_HOME : homedir()
  return join(home, '.dsh', STORE_DIR_NAME)
}

function hashBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function sameStringArray(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
  return a.every((value, index) => value === b[index])
}

function safeName(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, '_')
}

/** Normalized absolute posix-ish path key used in rows/meta. */
export function pathKey(filePath) {
  const abs = resolve(filePath)
  return process.platform === 'win32' ? abs.toLowerCase() : abs
}

/** True when child stays inside parent after resolution. */
function isInside(parent, child) {
  const base = resolve(parent)
  const target = resolve(child)
  return target === base || target.startsWith(base.endsWith(sep) ? base : base + sep)
}

export class CheckpointStore {
  /** @param {string} root - store root directory. */
  constructor(root = defaultStoreRoot()) {
    this.root = root
    /** @type {Map<string, {current?:{dir:string,messageId:string,rows:object[]}, loading?:Promise<object>}>} */
    this.sessions = new Map()
    this.maxFileBytes = DEFAULT_MAX_FILE_BYTES
  }

  sessionDir(sessionId) {
    return join(this.root, safeName(sessionId))
  }

  async ensureSession(sessionId) {
    const existing = this.sessions.get(sessionId)
    if (existing !== undefined) {
      if (existing.promise !== undefined) return existing.promise
      return existing.state
    }
    const promise = (async () => {
      const dir = this.sessionDir(sessionId)
      await fs.mkdir(join(dir, 'blobs'), { recursive: true })
      const metaPath = join(dir, 'meta.json')
      let meta = { version: STORE_VERSION, sessionId, tracked: [], checkpoints: [] }
      try {
        const parsed = JSON.parse(await fs.readFile(metaPath, 'utf8'))
        if (parsed?.version === STORE_VERSION) {
          meta = {
            version: STORE_VERSION,
            sessionId,
            tracked: Array.isArray(parsed.tracked) ? parsed.tracked.filter(p => typeof p === 'string') : [],
            checkpoints: Array.isArray(parsed.checkpoints) ? parsed.checkpoints : [],
          }
        }
      } catch {
        // fresh session: defaults above
      }
      return { dir, meta, current: undefined }
    })()
    this.sessions.set(sessionId, { promise })
    const state = await promise
    this.sessions.set(sessionId, { state })
    return state
  }

  async saveMeta(sessionId, meta) {
    const dir = this.sessionDir(sessionId)
    await writeJsonAtomic(join(dir, 'meta.json'), meta)
  }

  /** Tracked absolute paths across all session checkpoints (ordered, de-duped). */
  async trackedPaths(sessionId) {
    const state = await this.ensureSession(sessionId)
    return state.meta.tracked
  }

  async checkpointCount(sessionId) {
    const state = await this.ensureSession(sessionId)
    return state.meta.checkpoints.length
  }

  async captureDense(sessionId) {
    const state = await this.ensureSession(sessionId)
    const rows = []
    for (const path of state.meta.tracked) rows.push(await this.capturePath(state, path))
    return rows
  }

  /**
   * Capture the current state of one path (or a row saying it did not exist).
   * Reuses the previous row when size/mtime/blob match to avoid rehashing.
   */
  async capturePath(state, path) {
    const key = pathKey(path)
    const previous = state.current?.rows.find(row => row.key === key)
    try {
      const stat = await fs.stat(path)
      if (!stat.isFile() || stat.size > this.maxFileBytes) {
        return { key, path, existed: true, skipped: true, size: stat.size }
      }
      if (
        previous !== undefined &&
        previous.existed === true &&
        previous.skipped !== true &&
        previous.size === stat.size &&
        previous.mtimeMs === stat.mtimeMs &&
        typeof previous.blob === 'string'
      ) {
        return { ...previous }
      }
      const bytes = await fs.readFile(path)
      const blob = hashBytes(bytes)
      await this.writeBlob(state, blob, bytes)
      return { key, path, existed: true, size: stat.size, mtimeMs: stat.mtimeMs, blob }
    } catch (error) {
      if (error?.code === 'ENOENT') return { key, path, existed: false }
      return { key, path, existed: true, skipped: true, size: undefined }
    }
  }

  async writeBlob(state, blob, bytes) {
    const file = join(state.dir, 'blobs', blob)
    try {
      await fs.access(file)
      return
    } catch {
      // fall through to write
    }
    const tmp = `${file}.${randomUUID()}.tmp`
    await fs.writeFile(tmp, bytes)
    await fs.rename(tmp, file)
  }

  async readBlobBytes(state, blob) {
    return fs.readFile(join(state.dir, 'blobs', blob))
  }

  /**
   * Create the checkpoint for a human message (called after the step's user
   * messages are admitted, before the model runs).
   *
   * @param {string} sessionId
   * @param {readonly string[]} messageIds - admitted human message ids.
   * @returns {Promise<{dir:string,messageId:string,rows:object[]}|undefined>}
   */
  async beginStep(sessionId, messageIds) {
    if (!Array.isArray(messageIds) || messageIds.length === 0) return undefined
    const state = await this.ensureSession(sessionId)
    const messageId = messageIds[messageIds.length - 1]
    const rows = await this.captureDense(sessionId)
    const lastCheckpoint = state.meta.checkpoints[state.meta.checkpoints.length - 1]
    const index = lastCheckpoint === undefined ? 0 : lastCheckpoint.index + 1
    const dir = join(state.dir, 'cp', String(index).padStart(6, '0'))
    await fs.mkdir(dir, { recursive: true })
    await writeJsonAtomic(join(dir, 'rows.json'), { messageId, rows })
    state.meta.checkpoints.push({ index, messageId, time: Date.now() })
    await this.saveMeta(sessionId, state.meta)
    state.current = { dir, messageId, rows }
    return state.current
  }

  /**
   * Record the pre-touch state of a path that the model is about to mutate.
   * Only writes a v1 row when it is still ahead of the current checkpoint, so
   * repeated touches stay cheap. Returns false when nothing was captured.
   */
  async captureFirstTouch(sessionId, filePath) {
    const state = await this.ensureSession(sessionId)
    const key = pathKey(filePath)
    if (!state.meta.tracked.some(tracked => pathKey(tracked) === key)) {
      state.meta.tracked.push(filePath)
    }
    const rows = state.current?.rows
    if (rows === undefined) {
      // No checkpoint context yet (e.g. a resumed session with no pre-step):
      // fall back to the live file path itself for a future dense capture.
      await this.saveMeta(sessionId, state.meta)
      return false
    }
    if (rows.some(row => row.key === key && row.v1 === true && row.capturedAt !== undefined)) {
      return false
    }
    const row = { ...(await this.capturePath(state, filePath)), v1: true, capturedAt: Date.now() }
    rows.push(row)
    if (state.current !== undefined) {
      await writeJsonAtomic(join(state.current.dir, 'rows.json'), {
        messageId: state.current.messageId,
        rows: state.current.rows,
      })
    }
    await this.saveMeta(sessionId, state.meta)
    return true
  }

  /**
   * Append a rewind record. `rewinds.json` drives client-side hiding of the
   * shadowed transcript spans; the conversation itself is already cut by the
   * surface replacement marker.
   */
  async appendRewind(sessionId, record) {
    const state = await this.ensureSession(sessionId)
    const file = join(state.dir, 'rewinds.json')
    let list = []
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8'))
      if (Array.isArray(parsed)) list = parsed
    } catch {
      // first record
    }
    list.push(record)
    if (list.length > 1000) list = list.slice(-1000)
    await writeJsonAtomic(file, list)
    return record
  }

  async readRewinds(sessionId) {
    const state = await this.ensureSession(sessionId)
    try {
      const parsed = JSON.parse(await fs.readFile(join(state.dir, 'rewinds.json'), 'utf8'))
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  /** Retention: keep the newest RETAINED_CHECKPOINTS checkpoint dirs. */
  async prune(sessionId) {
    const state = await this.ensureSession(sessionId)
    const kept = state.meta.checkpoints.slice(-RETAINED_CHECKPOINTS)
    if (kept.length === state.meta.checkpoints.length) return
    const dropped = state.meta.checkpoints.slice(0, state.meta.checkpoints.length - kept.length)
    state.meta.checkpoints = kept
    await this.saveMeta(sessionId, state.meta)
    for (const checkpoint of dropped) {
      void fs.rm(join(state.dir, 'cp', String(checkpoint.index).padStart(6, '0')), {
        recursive: true,
        force: true,
      }).catch(() => {})
    }
    if (state.current !== undefined && !kept.some(cp => cp.index === Number(state.current.dir.slice(-6)))) {
      state.current = undefined
    }
  }

  /** Locate the checkpoint rows recorded for one human user message id. */
  async rowsForMessage(sessionId, messageId) {
    const state = await this.ensureSession(sessionId)
    const checkpoint = state.meta.checkpoints.find(cp => cp.messageId === messageId)
    if (checkpoint === undefined) return undefined
    const dir = join(state.dir, 'cp', String(checkpoint.index).padStart(6, '0'))
    try {
      const parsed = JSON.parse(await fs.readFile(join(dir, 'rows.json'), 'utf8'))
      return Array.isArray(parsed.rows) ? parsed.rows : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Plan a restore to the state captured for `messageId`.
   *
   * @returns {Promise<{restore:{path:string,existed:boolean,skipped?:boolean,blob?:string}[],unknown:number}>}
   * @throws {Error} code restore-unavailable when the checkpoint is missing.
   */
  async planRestore(sessionId, messageId) {
    const state = await this.ensureSession(sessionId)
    if (state.meta.version !== undefined && state.meta.version !== STORE_VERSION) {
      throw Object.assign(new Error('checkpoint store version mismatch'), { code: 'restore-unavailable' })
    }
    const checkpoint = state.meta.checkpoints.find(cp => cp.messageId === messageId)
    if (checkpoint === undefined) {
      throw Object.assign(new Error(`no checkpoint for message ${messageId}`), { code: 'restore-unavailable' })
    }
    const targetIndex = checkpoint.index
    const tracked = state.meta.tracked
    const byKey = new Map()
    for (const path of tracked) byKey.set(pathKey(path), { key: pathKey(path), path })

    // Load checkpoints at/after target (target rows + v1 rows recorded later).
    const candidates = state.meta.checkpoints.filter(cp => cp.index >= targetIndex)
    const firstAtOrAfter = new Map()
    let targetRows
    for (const cp of candidates) {
      const dir = join(state.dir, 'cp', String(cp.index).padStart(6, '0'))
      let rows
      try {
        rows = JSON.parse(await fs.readFile(join(dir, 'rows.json'), 'utf8')).rows
      } catch {
        continue
      }
      if (!Array.isArray(rows)) continue
      if (cp.index === targetIndex) targetRows = rows
      if (cp.index > targetIndex) {
        for (const row of rows) {
          const key = row.key ?? pathKey(row.path)
          if (row.v1 === true && !firstAtOrAfter.has(key)) firstAtOrAfter.set(key, row)
        }
      }
    }
    if (targetRows === undefined) {
      throw Object.assign(new Error('checkpoint rows missing'), { code: 'restore-unavailable' })
    }
    const restore = []
    let unknown = 0
    for (const trackedPath of tracked) {
      const key = pathKey(trackedPath)
      const row = targetRows.find(entry => (entry.key ?? pathKey(entry.path)) === key)
      if (row !== undefined) {
        if (row.skipped === true) continue
        restore.push({ path: row.path ?? trackedPath, existed: row.existed !== false, blob: row.blob })
        continue
      }
      const first = firstAtOrAfter.get(key)
      if (first !== undefined) {
        restore.push({ path: first.path ?? trackedPath, existed: first.existed !== false, blob: first.blob })
        continue
      }
      unknown += 1
    }
    void byKey
    return { restore, unknown }
  }

  /**
   * Apply a restore plan to the live workspace. Paths are only written when
   * their bytes differ from the recorded blob, so a no-op restore is cheap.
   *
   * @param {string} sessionId
   * @param {string} messageId
   * @returns {Promise<{restored:string[], deleted:string[], unchanged:string[], skipped:number}>}
   */
  async restore(sessionId, messageId) {
    const state = await this.ensureSession(sessionId)
    const { restore, unknown } = await this.planRestore(sessionId, messageId)
    const report = { restored: [], deleted: [], unchanged: [], skipped: unknown }
    for (const entry of restore) {
      try {
        if (entry.existed === false) {
          try {
            await fs.unlink(entry.path)
            report.deleted.push(entry.path)
          } catch (error) {
            if (error?.code !== 'ENOENT') throw error
          }
          continue
        }
        if (typeof entry.blob !== 'string') continue
        const desired = await this.readBlobBytes(state, entry.blob)
        let current
        try {
          current = await fs.readFile(entry.path)
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error
        }
        if (current !== undefined && hashBytes(current) === entry.blob) {
          report.unchanged.push(entry.path)
          continue
        }
        await fs.mkdir(dirname(entry.path), { recursive: true })
        await writeBytesAtomic(entry.path, desired)
        report.restored.push(entry.path)
      } catch {
        report.skipped += 1
      }
    }
    return report
  }
}

/** Write JSON with a temp file + rename so a crash never leaves a torn file. */
export async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(dirname(filePath), { recursive: true })
  const tmp = `${filePath}.${randomUUID()}.tmp`
  await fs.writeFile(tmp, JSON.stringify(value))
  await fs.rename(tmp, filePath)
}

/** Write bytes with a temp file + rename (best effort atomic replace). */
export async function writeBytesAtomic(filePath, bytes) {
  await fs.mkdir(dirname(filePath), { recursive: true })
  const tmp = `${filePath}.${randomUUID()}.tmp`
  await fs.writeFile(tmp, bytes)
  await fs.rename(tmp, filePath)
}

export { isInside, sameStringArray }
