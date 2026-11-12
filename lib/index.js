/**
 * dsh-conversation-flow — host half.
 *
 * Three conversation actions, all expressed as one surface-replace marker plus
 * (optionally) a file restore from this plugin's own checkpoint store:
 *   - rewind   (倒带): cut to just before a user message and restore files
 *   - regen    (重新生成): cut, then re-send the same prompt on a fresh turn
 *   - drop     (删除本轮): cut only, keep files untouched
 *
 * The session log stays append-only: the marker shadows the target message and
 * everything after it in the model-visible surface, while the raw log keeps the
 * history for audit. The client half hides the shadowed transcript spans using
 * the rewind records this host writes.
 *
 * The host also creates a dense file checkpoint at every user message boundary
 * and a pre-touch capture for the first write/edit of each file, so a rewind can
 * restore the workspace state as it was before the cut turn.
 */
import { randomUUID } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { deleteSession } from './delete.js'
import { CheckpointStore } from './store.js'
import {
  FlowError,
  buildTurnSegments,
  formatCandidate,
  listCandidates,
  parseTarget,
  planRewind,
  surfaceUserTurns,
  turnsOfSeqs,
} from './plan.js'

export const name = 'dsh-conversation-flow'
export const inject = ['commands']

const MARKER_CONTENT = [{ type: 'text', text: '(empty message)' }]
const MARKER_SOURCE_KIND = 'conversation-flow'
const STATUS_PATH = '/api/dsh-conversation-flow/status'
const EXECUTE_PATH = '/api/dsh-conversation-flow/execute'
const DELETE_PATH = '/api/dsh-conversation-flow/delete-session'
const TRACKED_TOOLS = new Set(['write', 'edit'])
const MODES = new Set(['chat', 'both', 'regen'])

/** True for a subagent session (delegationDepth > 0): rewinding there is not supported. */
function isSubagent(session) {
  const depth = session?.header?.delegationDepth
  return typeof depth === 'number' && depth > 0
}

/** The surface-replacement marker: a user message citing every shadowed seq. */
function buildMarker() {
  return {
    id: randomUUID(),
    role: 'user',
    content: MARKER_CONTENT.map(block => ({ ...block })),
    source: { kind: MARKER_SOURCE_KIND },
  }
}

/** Wait until the agent reaches idle (the activity promise, maintenance included). */
async function waitForAgentIdle(agent, signal, timeoutMs = 15_000) {
  if (signal?.aborted === true) return false
  let timer
  let onAbort
  try {
    await Promise.race([
      agent.whenIdle(),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('conversation-flow idle wait timed out')), timeoutMs)
        if (signal !== undefined && signal !== null) {
          onAbort = () => reject(new Error('conversation-flow idle wait aborted'))
          signal.addEventListener('abort', onAbort, { once: true })
        }
      }),
    ])
    return true
  } catch {
    return false
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
  }
}

/** Drop pending steering messages: they belong to the future being cut. */
function dropPendingSteering(agent) {
  const nextStep = agent?.inbox?.nextStep
  if (nextStep === undefined || nextStep === null) return
  for (const message of [...nextStep]) {
    try {
      agent.inbox.remove(message.id)
    } catch {
      // already gone
    }
  }
}

/** A JSON response helper. */
function jsonResponse(value, status = 200) {
  return Response.json(value, { status })
}

/** Typed failure payload shared by the HTTP route and the command path. */
function failure(code, message) {
  return { ok: false, error: { code, message } }
}

/** Read a JSON request body, returning undefined when malformed. */
async function readJsonBody(request) {
  if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    return undefined
  }
  try {
    return await request.json()
  } catch {
    return undefined
  }
}

/**
 * Execute one conversation action.
 *
 * @param {object} ctx - plugin context (logger).
 * @param {CheckpointStore} store
 * @param {object} agent - live AgentHandle.
 * @param {number} targetSeq - human user/message seq to cut at.
 * @param {'chat'|'both'|'regen'} mode
 * @param {AbortSignal|undefined} signal
 * @param {Set<string>} inflight - per-session guard.
 */
async function executeAction(ctx, store, agent, targetSeq, mode, signal, inflight) {
  const session = agent.session
  const sessionId = session.id
  if (isSubagent(session)) return failure('subagent', '子代理会话不支持倒带')
  if (!MODES.has(mode)) return failure('bad-request', `unknown mode ${mode}`)
  if (inflight.has(sessionId)) return failure('inflight', '这个会话已有一个倒带操作正在进行')
  inflight.add(sessionId)
  try {
    if (agent.status !== 'idle') {
      agent.cancel({ kind: 'user' }, { keepInbox: true })
      const stopped = await waitForAgentIdle(agent, signal)
      if (!stopped) return failure('busy', '当前回合停不下来，请稍后再试')
    }
    dropPendingSteering(agent)
    if (signal?.aborted === true) return failure('aborted', '操作已取消')

    const events = session.snapshotEvents()
    const surface = session.surface.nodes
    let plan
    try {
      plan = planRewind(events, surface, { kind: 'seq', seq: targetSeq })
    } catch (error) {
      if (error instanceof FlowError) return failure(error.code, error.message)
      throw error
    }
    const segments = buildTurnSegments(events)
    const shadowedTurns = turnsOfSeqs(segments, plan.shadowedSeqs)
    const targetEvent = events.find(event => event.seq === plan.targetSeq)
    const targetMessageId = targetEvent?.type === 'user/message' ? targetEvent.data?.id : undefined

    let restore = null
    if (mode === 'both') {
      if (typeof targetMessageId !== 'string') {
        restore = { error: 'no-checkpoint', message: '这条消息没有文件检查点' }
      } else {
        try {
          const report = await store.restore(sessionId, targetMessageId)
          restore = { restored: report.restored.length, deleted: report.deleted.length, unchanged: report.unchanged.length, skipped: report.skipped }
        } catch (error) {
          restore = { error: error?.code === 'restore-unavailable' ? 'no-checkpoint' : 'restore-failed', message: String(error?.message ?? error) }
        }
      }
    }

    let markerEvent
    try {
      markerEvent = session.append('user/message', buildMarker(), {
        surfaceOp: { op: 'replace', startSeq: plan.surfaceStart, endSeq: plan.surfaceEnd },
        sourceEventSeqs: [...plan.shadowedSeqs],
      })
    } catch (error) {
      return failure('cut-failed', `对话截断失败：${String(error?.message ?? error)}`, { restore })
    }

    try {
      await store.appendRewind(sessionId, {
        markerSeq: markerEvent.seq,
        targetSeq: plan.targetSeq,
        targetTurn: shadowedTurns[0] ?? null,
        mode,
        time: Date.now(),
        shadowedSeqs: plan.shadowedSeqs,
        shadowedTurns,
      })
    } catch (error) {
      ctx.logger.warn(`[conversation-flow] rewind record failed: ${String(error?.message ?? error)}`)
    }

    let regen = null
    if (mode === 'regen' && targetEvent?.type === 'user/message') {
      const content = (targetEvent.data.content ?? [])
        .filter(block => block !== null && typeof block === 'object' && block.type === 'text')
        .map(block => ({ ...block }))
      if (content.length === 0) {
        regen = { sent: false, error: '原消息没有文本，无法自动重发' }
      } else {
        try {
          agent.followup({ id: randomUUID(), role: 'user', content, source: { kind: 'user' } })
          regen = { sent: true }
        } catch (error) {
          regen = { sent: false, error: String(error?.message ?? error) }
        }
      }
    }

    return { ok: true, mode, targetSeq: plan.targetSeq, markerSeq: markerEvent.seq, shadowedTurns, restore, regen }
  } finally {
    inflight.delete(sessionId)
  }
}

/** Command handler factory: resolves a raw target and runs one mode. */
function makeCommandHandler(ctx, store, inflight, mode) {
  return async invocation => {
    const session = invocation.agent.session
    const raw = String(invocation.rawInput ?? '').trim()
    const actionLabel = mode === 'both' ? '倒带' : mode === 'regen' ? '重新生成' : '删除本轮'
    if (raw === '') {
      const candidates = listCandidates(session.snapshotEvents(), session.surface.nodes, 10)
      if (candidates.length === 0) return { kind: 'error', text: '当前会话没有可回退的用户消息' }
      return {
        kind: 'success',
        text: [`${actionLabel}：选择目标（@seq 或序号）`, ...candidates.map(formatCandidate), '示例：/flow-' + (mode === 'both' ? 'rewind' : mode === 'regen' ? 'regen' : 'drop') + ' 2'].join('\n'),
      }
    }
    const target = parseTarget(raw)
    if (target === undefined) return { kind: 'error', text: `无法识别的目标「${raw}」，用 @seq 或序号（见不带参数的 /flow-* 列表）` }
    let seq
    if (target.kind === 'seq') {
      seq = target.seq
    } else {
      const candidates = listCandidates(session.snapshotEvents(), session.surface.nodes, target.index)
      const candidate = candidates[target.index - 1]
      if (candidate === undefined) return { kind: 'error', text: `没有第 ${target.index} 条可回退消息` }
      seq = candidate.seq
    }
    const result = await executeAction(ctx, store, invocation.agent, seq, mode, invocation.signal, inflight)
    if (result.ok !== true) {
      return { kind: 'error', text: `${actionLabel}失败：${result.error?.message ?? result.error?.code ?? '未知错误'}` }
    }
    const parts = [`已${actionLabel}到 seq ${result.targetSeq}（隐藏 ${result.shadowedTurns.length} 个回合）`]
    if (result.restore?.error !== undefined) parts.push(`文件恢复不可用：${result.restore.message ?? result.restore.error}`)
    else if (result.restore !== null && result.restore !== undefined) parts.push(`文件：恢复 ${result.restore.restored}，删除 ${result.restore.deleted}，未改动 ${result.restore.unchanged}`)
    if (result.regen !== null && result.regen !== undefined) parts.push(result.regen.sent === true ? '已用同样的内容重新发送' : `重新发送失败：${result.regen.error}`)
    return { kind: 'success', text: parts.join('；'), sourceEventSeq: result.markerSeq }
  }
}

/** Resolve an agents registry lazily through a dynamic scope. */
function agentsOf(scope) {
  try {
    return scope.get('agents')
  } catch {
    return undefined
  }
}

/** Build the HTTP handlers (status + execute) for the client half. */
function createStatusHandler(ctx, store, lookup) {
  return async request => {
    try {
      if (request.method !== 'POST') return new Response('method not allowed', { status: 405 })
      const payload = await readJsonBody(request)
      if (payload === null || typeof payload !== 'object') return jsonResponse(failure('bad-request', 'body must be JSON'), 400)
      const sessionId = payload.sessionId
      if (typeof sessionId !== 'string' || sessionId === '') return jsonResponse(failure('bad-request', 'sessionId required'), 400)
      const agents = lookup()
      const agent = agents?.get(sessionId)
      if (agent === undefined) return jsonResponse(failure('session-not-open', '会话未打开'), 404)
      const session = agent.session
      const events = session.snapshotEvents()
      const surface = session.surface.nodes
      const turns = surfaceUserTurns(events, surface)
      const markers = await store.readRewinds(sessionId)
      return jsonResponse({ ok: true, sessionId, turns, markers })
    } catch (error) {
      ctx.logger.warn(`[conversation-flow] status failed: ${String(error?.message ?? error)}`)
      return jsonResponse(failure('status-failed', String(error?.message ?? error)), 500)
    }
  }
}

function createExecuteHandler(ctx, store, lookup, inflight) {
  return async request => {
    try {
      if (request.method !== 'POST') return new Response('method not allowed', { status: 405 })
      const payload = await readJsonBody(request)
      if (payload === null || typeof payload !== 'object') return jsonResponse(failure('bad-request', 'body must be JSON'), 400)
      const { sessionId, targetSeq, mode } = payload
      if (typeof sessionId !== 'string' || sessionId === '') return jsonResponse(failure('bad-request', 'sessionId required'), 400)
      if (!Number.isSafeInteger(targetSeq)) return jsonResponse(failure('bad-request', 'targetSeq required'), 400)
      if (typeof mode !== 'string' || !MODES.has(mode)) return jsonResponse(failure('bad-request', 'unknown mode'), 400)
      const agents = lookup()
      const agent = agents?.get(sessionId)
      if (agent === undefined) return jsonResponse(failure('session-not-open', '会话未打开'), 404)
      const result = await executeAction(ctx, store, agent, targetSeq, mode, request.signal, inflight)
      return jsonResponse(result, result.ok === true ? 200 : 200)
    } catch (error) {
      ctx.logger.warn(`[conversation-flow] execute failed: ${String(error?.message ?? error)}`)
      return jsonResponse(failure('execute-failed', String(error?.message ?? error)), 500)
    }
  }
}

/** Read one host service lazily; the host may omit it in some shapes. */
function serviceOf(ctx, name) {
  try {
    return ctx.get(name)
  } catch {
    return undefined
  }
}

/**
 * POST /delete-session — the manual session-delete capability (soft delete:
 * move into `.sessions-trash`, recoverable for 24h).
 *
 * The host services are read per request so a host shape without session
 * persistence degrades to a structured 503 instead of a crash.
 */
function createDeleteHandler(ctx) {
  return async request => {
    if (request.method !== 'POST') return new Response('method not allowed', { status: 405 })
    const payload = await readJsonBody(request)
    if (payload === null || typeof payload !== 'object') return jsonResponse(failure('bad-request', 'body must be JSON'), 400)
    const sessionId = payload.sessionId
    if (typeof sessionId !== 'string' || sessionId === '') return jsonResponse(failure('invalid-session-id', 'sessionId required'), 400)
    const persistence = serviceOf(ctx, 'sessionPersistence')
    if (persistence === undefined) {
      return jsonResponse(failure('persistence-unavailable', 'session persistence is not configured'), 503)
    }
    const result = await deleteSession(
      {
        persistence,
        sessions: serviceOf(ctx, 'sessions'),
        agents: serviceOf(ctx, 'agents'),
        workspaceRegistry: serviceOf(ctx, 'workspaceRegistry'),
      },
      sessionId,
    )
    if (result.ok !== true) {
      ctx.logger.warn(`[conversation-flow] session-delete failed for '${sessionId}' (${result.error?.code ?? 'unknown'}): ${result.error?.message ?? ''}`)
    }
    return jsonResponse(result, result.status ?? 500)
  }
}

/** Register one exact POST route with the connection Fetch registry. */
function registerRoute(ctx, scope, path, handler, label) {
  try {
    const connection = scope.connection
    if (connection === undefined) return
    scope.effect(
      () => connection.fetch.register({ path, methods: ['POST'], requestBody: 'buffered', fetch: handler }),
      `dsh-conversation-flow ${label} route`,
    )
  } catch (error) {
    ctx.logger.error(`[conversation-flow] route registration failed for ${path}: ${String(error?.message ?? error)}`)
  }
}

/**
 * Plugin entry point.
 *
 * @param {object} ctx - Cordis context.
 */
export function apply(ctx) {
  const store = new CheckpointStore()
  const inflight = new Set()

  // /flow-rewind, /flow-regen, /flow-drop — each isolated so a name collision
  // costs only that command.
  ctx.effect(function* () {
    const commands = [
      ['flow-rewind', '倒带：回到某条用户消息之前，并恢复工作区文件', 'both'],
      ['flow-regen', '重新生成：回到某条用户消息之前并重发它，旧结果留在日志里', 'regen'],
      ['flow-drop', '删除本轮：只从对话记录中移除（文件不动）', 'chat'],
    ]
    for (const [commandName, description, mode] of commands) {
      try {
        yield ctx.commands.register({ name: commandName, description, handler: makeCommandHandler(ctx, store, inflight, mode) })
      } catch (error) {
        ctx.logger.warn(`[conversation-flow] command ${commandName} unavailable: ${String(error?.message ?? error)}`)
      }
    }
  }, 'dsh-conversation-flow commands')

  // Message boundary: dense file checkpoint, after the step is admitted and
  // before the model or any tool can touch the workspace.
  ctx.on(
    'agent/pre-step',
    async ({ agent }, next) => {
      const decision = await next()
      if (decision?.kind !== 'enter') return decision
      const session = agent?.session
      if (session === undefined || isSubagent(session)) return decision
      if (inflight.has(session.id)) return decision
      try {
        const ids = []
        const seen = new Set()
        for (const message of decision.messages ?? []) {
          if (message?.source?.kind !== 'user') continue
          if (typeof message.id !== 'string' || seen.has(message.id)) continue
          seen.add(message.id)
          ids.push(message.id)
        }
        if (ids.length > 0) {
          await store.beginStep(session.id, ids)
          await store.prune(session.id).catch(() => {})
        }
      } catch (error) {
        ctx.logger.warn(`[conversation-flow] checkpoint creation failed: ${String(error?.message ?? error)}`)
      }
      return decision
    },
    { prepend: true, global: true },
  )

  // Pre-touch capture: record a file's state before the first write/edit of a
  // step touches it, so files unknown to the checkpoint manifest are restorable.
  ctx.on('tools/execute', async (exec, next) => {
    try {
      const session = exec?.agent?.session
      if (session !== undefined && !isSubagent(session) && TRACKED_TOOLS.has(exec.name)) {
        const args = exec.arguments ?? {}
        const rawPath = typeof args.file_path === 'string' ? args.file_path : typeof args.path === 'string' ? args.path : undefined
        if (typeof rawPath === 'string' && rawPath !== '') {
          const cwd = typeof session.header?.cwd === 'string' && session.header.cwd !== '' ? session.header.cwd : process.cwd()
          const absolute = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath)
          await store.captureFirstTouch(session.id, absolute)
        }
      }
    } catch (error) {
      ctx.logger.warn(`[conversation-flow] first-touch capture failed: ${String(error?.message ?? error)}`)
    }
    return next()
  })

  // Client queries and actions travel over exact /api POST routes.
  ctx.inject(['connection'], scope => {
    const lookup = () => agentsOf(scope)
    registerRoute(ctx, scope, STATUS_PATH, createStatusHandler(ctx, store, lookup), 'status')
    registerRoute(ctx, scope, EXECUTE_PATH, createExecuteHandler(ctx, store, lookup, inflight), 'execute')
    registerRoute(ctx, scope, DELETE_PATH, createDeleteHandler(ctx), 'delete-session')
  })
}
