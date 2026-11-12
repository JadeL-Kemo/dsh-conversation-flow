/**
 * dsh-conversation-flow — host half: session deletion (soft delete).
 *
 * The DSH host only knows rename / fork / archive; archive merely hides a row
 * and keeps every byte on disk. This module implements the missing "delete"
 * capability as a reversible move into `.sessions-trash/` under the session
 * persistence root, adapted from the proven dsh-web-mobile / wzxmt-zhc
 * implementation:
 *
 *   <root>/<projectKey(cwd)>/<encodeSegment(id)>/   ← canonical layout
 *   <root>/.sessions-trash/<UTC>-<projectKey>-<encodedId>/
 *
 * The move renames each canonical payload (`session[.vN].jsonl[.zstd]`) with a
 * `.trash` suffix *first* — non-canonical names are invisible to the host's
 * list() scan — then renames the whole directory into the trash and writes a
 * best-effort `manifest.json`. Entries older than 24h are purged after every
 * successful move, so "delete" remains recoverable for a day.
 *
 * Live sessions are only deleted when the host exposes the disposal face
 * (`cancel({kind:'disposed'})` + `whenIdle()`); a live agent without that face
 * is refused with 409 so a running session is never deleted underneath itself.
 *
 * Attachments are content-addressed and shared; they are intentionally left
 * alone. The projection cache entry is removed best-effort.
 */
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'

/** How long to wait for a live agent to converge to idle before refusing. */
const IDLE_TIMEOUT_MS = 20_000

/** Trash entries older than this are purged (best effort) after each move. */
const TRASH_TTL_MS = 24 * 60 * 60 * 1000

/** Canonical payload names the host list() scan recognizes. */
const PAYLOAD_NAME = /^session(?:\.v[1-9][0-9]*)?\.jsonl(?:\.zstd)?$/

/** Failure stage of a trash move, carried on the thrown error. */
class TrashMoveError extends Error {
  constructor(stage, cause, detail = {}) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.stage = stage
    this.renamed = detail.renamed ?? []
    this.failedTarget = detail.failedTarget ?? null
    this.recovery = detail.recovery ?? 'not-needed'
    this.residual = detail.residual ?? []
  }
}

/**
 * Escape one raw session id into one filesystem-safe path segment
 * (mirror of the JSONL backend layout).
 */
export function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

/** Build the readable directory key for a project path (backend layout). */
export function projectKey(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

/** The directory owned by one session under the persistence root. */
export function sessionDir(root, cwd, id) {
  const project = cwd === undefined ? '_no-cwd' : projectKey(cwd)
  return join(root, project, encodeSegment(id))
}

/** Whether `target` resolves to a path inside `root` (escape defense). */
export function isInside(root, target) {
  const rel = relative(root, target)
  return rel !== '..' && !rel.startsWith('..' + sep) && rel !== ''
}

/** Normalize one `persistence.list()` entry across host generations. */
function entryHeader(entry) {
  const header = entry?.header ?? entry
  if (typeof header?.id !== 'string' || header.id === '') return undefined
  return { id: header.id, cwd: typeof header.cwd === 'string' ? header.cwd : undefined }
}

/** Bound a promise with a rejection deadline. */
function withTimeout(promise, ms, message) {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      value => {
        clearTimeout(timer)
        resolvePromise(value)
      },
      error => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/** Unregister a live agent via runtime-visible store internals, if present. */
function detachLiveAgent(agents, id) {
  const registry = agents
  const entry = registry?.store?.get?.(id)
  if (entry !== undefined) registry?.detachEntered?.(entry)
}

/** Unregister a live session via runtime-visible store internals, if present. */
function detachLiveSession(sessions, id) {
  sessions?.store?.get?.(id)?.detach?.()
}

/** Remove the session from every workspace account (idempotent, best effort). */
async function detachFromWorkspaces(workspaceRegistry, sessionId) {
  if (workspaceRegistry === undefined || typeof workspaceRegistry.list !== 'function') return
  for (const workspace of workspaceRegistry.list()) {
    try {
      await workspace?.detachSession?.(sessionId)
    } catch {
      // best effort: the host reconciles a stale id at next startup
    }
  }
}

/** Remove the projection-cache entry for a deleted session (best effort). */
export async function removeProjectionCache(root, sessionId) {
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) return
  const storages = join(dirname(resolve(root)), 'storages', 'session_projcache', 'sessions')
  try {
    await rm(join(storages, `${sessionId}.json`), { force: true })
  } catch {
    // cache is rebuildable; ignore
  }
}

/** Remove trash entries older than TRASH_TTL_MS; every failure is swallowed. */
async function purgeStaleTrash(trashRoot) {
  try {
    const cutoff = Date.now() - TRASH_TTL_MS
    for (const name of await readdir(trashRoot)) {
      try {
        const stats = await stat(join(trashRoot, name))
        if (stats.mtimeMs < cutoff) await rm(join(trashRoot, name), { recursive: true, force: true })
      } catch {
        // vanished / unreadable entry
      }
    }
  } catch {
    // trash root unreadable: purge is best effort
  }
}

/**
 * Move one session's stored directory into the trash instead of removing it.
 * Payloads are renamed first so a canonical directory never appears under the
 * trash root; the manifest records the deterministic restore mapping.
 */
export async function moveToTrash(root, dir, cwd, sessionId, renameFile = rename) {
  const project = cwd === undefined ? '_no-cwd' : projectKey(cwd)
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    throw new TrashMoveError('rename-payloads', error)
  }
  const renamed = []
  for (const entry of entries) {
    if (!entry.isFile() || !PAYLOAD_NAME.test(entry.name)) continue
    const to = `${entry.name}.trash`
    try {
      await renameFile(join(dir, entry.name), join(dir, to))
    } catch (error) {
      const residual = []
      for (const done of [...renamed].reverse()) {
        try {
          await renameFile(join(dir, done.to), join(dir, done.from))
        } catch {
          residual.unshift(done)
        }
      }
      throw new TrashMoveError('rename-payloads', error, {
        renamed: [...renamed],
        failedTarget: entry.name,
        recovery: residual.length === 0 ? 'rolled-back' : 'partial',
        residual,
      })
    }
    renamed.push({ from: entry.name, to })
  }

  const trashRoot = join(root, '.sessions-trash')
  const trashName = `${new Date().toISOString().replaceAll(':', '-')}-${project}-${encodeSegment(sessionId)}`
  const trashDir = join(trashRoot, trashName)
  try {
    await mkdir(trashRoot, { recursive: true })
    await rename(dir, trashDir)
  } catch (error) {
    throw new TrashMoveError('stash', error, {
      renamed: [...renamed],
      failedTarget: dir,
      recovery: renamed.length === 0 ? 'not-needed' : 'partial',
    })
  }

  try {
    const manifest = { id: sessionId, cwd, deletedAt: new Date().toISOString(), files: renamed }
    await writeFile(join(trashDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  } catch {
    // manifest is informational only; from→to is deterministic
  }
  await purgeStaleTrash(trashRoot)
  return { trashDir, renamed }
}

/** Public result union of one delete attempt. */
function fail(status, code, message) {
  return { status, ok: false, error: { code, message } }
}

/**
 * Delete one session: stop it if live, move its stored directory into the
 * trash, and detach it from every workspace account.
 *
 * @param {object} deps - services read at request time.
 * @param {string} sessionId
 * @returns {Promise<{status:number, ok:boolean, deleted?:string, error?:object}>}
 */
export async function deleteSession(deps, sessionId) {
  try {
    return await deleteSessionInner(deps, sessionId)
  } catch (error) {
    return fail(500, 'delete-failed', `unexpected failure while deleting session '${sessionId}': ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function deleteSessionInner(deps, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return fail(400, 'invalid-session-id', 'sessionId must be a non-empty string')
  const root = deps?.persistence?.config?.root
  if (typeof root !== 'string' || root === '') {
    return fail(503, 'persistence-unavailable', 'session persistence is not configured with a storage root')
  }

  let snapshot
  try {
    snapshot = (await deps.persistence.list()).map(entryHeader).find(header => header !== undefined && header.id === sessionId)
  } catch (error) {
    return fail(500, 'delete-lookup-failed', `failed to look up the session: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (snapshot === undefined) return fail(404, 'session-not-found', `no such session '${sessionId}'`)
  try {
    if (snapshot.cwd !== undefined) projectKey(snapshot.cwd)
  } catch (error) {
    return fail(500, 'delete-failed', `cannot resolve the session log directory: ${error instanceof Error ? error.message : String(error)}`)
  }

  // Live sessions: only delete through the disposal face.
  const live = deps.sessions?.get?.(sessionId)
  if (live !== undefined && deps.sessions !== undefined) {
    const agent = deps.agents?.get?.(sessionId)
    const handle = agent !== undefined && typeof agent.cancel === 'function' && typeof agent.whenIdle === 'function' ? agent : undefined
    if (agent !== undefined && handle === undefined) {
      return fail(409, 'session-busy', `session '${sessionId}' is live on a host generation that exposes no agent disposal face; stop it first, then retry`)
    }
    try {
      if (handle !== undefined) {
        handle.cancel({ kind: 'disposed' })
        await withTimeout(handle.whenIdle(), IDLE_TIMEOUT_MS, `agent for session '${sessionId}' did not converge to idle within ${IDLE_TIMEOUT_MS}ms`)
      }
      await deps.sessions.flush(live)
      detachLiveAgent(deps.agents, sessionId)
      detachLiveSession(deps.sessions, sessionId)
    } catch (error) {
      return fail(409, 'session-busy', `cannot delete session '${sessionId}': it is running and could not be stopped: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const resolvedRoot = resolve(root)
  const dir = sessionDir(resolvedRoot, snapshot.cwd, sessionId)
  if (!isInside(resolvedRoot, dir)) return fail(500, 'delete-failed', `refusing to remove '${dir}': it resolves outside the session storage root`)

  try {
    await moveToTrash(resolvedRoot, dir, snapshot.cwd, sessionId)
  } catch (error) {
    const trash = error instanceof TrashMoveError ? error : new TrashMoveError('stash', error)
    return {
      status: 500,
      ok: false,
      deletedLiveSession: live !== undefined ? true : undefined,
      error: {
        code: live !== undefined ? 'cleanup-failed' : 'delete-failed',
        stage: trash.stage,
        failedTarget: trash.failedTarget,
        renamed: trash.renamed,
        recovery: trash.recovery,
        residual: trash.residual,
        message: `failed to move the session log to the trash: ${trash.message} (stage=${trash.stage} target=${trash.failedTarget ?? 'unknown'})`,
      },
    }
  }

  await removeProjectionCache(resolvedRoot, sessionId)
  await detachFromWorkspaces(deps.workspaceRegistry, sessionId)
  return { status: 200, ok: true, deleted: sessionId }
}
