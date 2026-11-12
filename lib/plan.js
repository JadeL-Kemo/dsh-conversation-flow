/**
 * Pure planning for conversation-flow actions. No I/O, no Session dependency:
 * everything derives from the event log plus the ordered surface node list, so
 * this module stays unit-testable with plain objects.
 *
 * Surface semantics (DSH core): message-producing events carry a `surfaceOp`.
 * "append" adds the node to the model-visible history; {op:'replace',
 * startSeq, endSeq} folds a range of surface nodes into one replacement node.
 * The main log is append-only, so a cut is expressed as a replacement marker
 * that cites every shadowed seq via `sourceEventSeqs`; the model then derives
 * its context from the shrunken surface while the transcript/log keep what the
 * user already saw (the client hides the shadowed spans for clarity).
 */

/** Message-producing (surface-eligible) event types. */
export const SURFACE_EVENT_TYPES = new Set([
  'system/message',
  'developer/message',
  'user/message',
  'assistant/message',
  'tool/result',
])

/** A typed planning failure; `code` lets the host pick a localized message. */
export class FlowError extends Error {
  /**
   * @param {string} code - machine-readable failure code.
   * @param {string} message - English diagnostic (host logs).
   */
  constructor(code, message) {
    super(message)
    this.name = 'FlowError'
    this.code = code
  }
}

/** True for a surface-eligible event carrying its surface marker. */
export function isSurfaceEvent(event) {
  return SURFACE_EVENT_TYPES.has(event.type) && event.surfaceOp !== undefined
}

/**
 * True for a genuine HUMAN user message: a user/message whose source is
 * `{kind:'user'}`. Plugin/system context injection and compaction checkpoints
 * also ride user/message with a non-user source and must never be a boundary.
 */
export function isHumanUserMessage(event) {
  return (
    event.type === 'user/message' &&
    event.data !== null &&
    typeof event.data === 'object' &&
    event.data.source !== undefined &&
    event.data.source !== null &&
    event.data.source.kind === 'user'
  )
}

/** Join the text blocks of a message into one whitespace-collapsed preview. */
export function messagePreview(message, maxChars = 80) {
  const content = Array.isArray(message?.content) ? message.content : []
  const text = content
    .map(block => (block && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`
}

/** Absolute-seq token: `@` followed by decimal digits only. */
const SEQ_TOKEN = /^@(\d+)$/
/** Recency-index token: decimal digits only (1 = most recent user message). */
const INDEX_TOKEN = /^(\d+)$/

/**
 * Parse a raw target token: `@123` (absolute seq) or `3` (1-based recency
 * index into the candidate list). Malformed tokens return undefined.
 */
export function parseTarget(raw) {
  const token = String(raw ?? '').trim()
  const seq = SEQ_TOKEN.exec(token)
  if (seq !== null) {
    const value = Number(seq[1])
    return Number.isSafeInteger(value) ? { kind: 'seq', seq: value } : undefined
  }
  const index = INDEX_TOKEN.exec(token)
  if (index !== null) {
    const value = Number(index[1])
    return Number.isSafeInteger(value) && value >= 1 ? { kind: 'index', index: value } : undefined
  }
  return undefined
}

/**
 * List selectable targets: human user messages currently on the surface, most
 * recent first. Shadowed (already rewound / compacted-away) messages are
 * excluded: a cut boundary cannot sit outside the model-visible history.
 *
 * @param {readonly object[]} events - full session event log in seq order.
 * @param {readonly number[]} surface - ordered surface node seq numbers.
 * @param {number} limit - maximum candidates to return.
 * @returns {{seq:number,time:number,preview:string,index:number}[]}
 */
export function listCandidates(events, surface, limit = 100) {
  if (!Array.isArray(events) || !Array.isArray(surface)) return []
  const onSurface = new Set(surface)
  const out = []
  for (let i = events.length - 1; i >= 0 && out.length < limit; i--) {
    const event = events[i]
    if (!isHumanUserMessage(event)) continue
    if (!onSurface.has(event.seq)) continue
    out.push({
      seq: event.seq,
      time: event.time,
      preview: messagePreview(event.data),
      index: out.length + 1,
    })
  }
  return out
}

/**
 * Resolve a target into a validated cut plan (the target and every surface
 * node after it are shadowed by one replacement marker).
 *
 * @param {readonly object[]} events - full session event log.
 * @param {readonly number[]} surface - ordered surface node seq numbers.
 * @param {{kind:'seq',seq:number}|{kind:'index',index:number}} target
 * @returns {{targetSeq:number,targetIndex:number,shadowedSeqs:number[],surfaceStart:number,surfaceEnd:number}}
 * @throws {FlowError} with code no-target / bad-target / not-human / not-on-surface / empty-surface.
 */
export function planRewind(events, surface, target) {
  if (!Array.isArray(events) || !Array.isArray(surface) || surface.length === 0) {
    throw new FlowError('empty-surface', 'session has no model-visible messages')
  }
  let targetSeq
  if (target.kind === 'seq') {
    targetSeq = target.seq
  } else {
    const candidate = listCandidates(events, surface, target.index)[target.index - 1]
    if (candidate === undefined) {
      throw new FlowError('bad-target', `no candidate at index ${target.index}`)
    }
    targetSeq = candidate.seq
  }
  const event = events.find(candidate => candidate.seq === targetSeq)
  if (event === undefined) {
    throw new FlowError('bad-target', `no session event at seq ${targetSeq}`)
  }
  if (!isHumanUserMessage(event)) {
    throw new FlowError('not-human', `event at seq ${targetSeq} is not a human user message`)
  }
  const targetIndex = surface.indexOf(targetSeq)
  if (targetIndex === -1) {
    throw new FlowError('not-on-surface', `user message at seq ${targetSeq} is no longer in the model context`)
  }
  const shadowedSeqs = surface.slice(targetIndex)
  return {
    targetSeq,
    targetIndex,
    shadowedSeqs,
    surfaceStart: shadowedSeqs[0],
    surfaceEnd: shadowedSeqs[shadowedSeqs.length - 1],
  }
}

/**
 * Split the log into turn segments from turn/start and turn/end boundaries.
 * Each segment is {turn, startSeq, endSeq} where endSeq is undefined while the
 * turn is still open.
 *
 * @param {readonly object[]} events
 * @returns {{turn:number,startSeq:number,endSeq:number|undefined}[]}
 */
export function buildTurnSegments(events) {
  const segments = []
  for (const event of Array.isArray(events) ? events : []) {
    if (event.type === 'turn/start') {
      const turn = event.data?.turn
      if (typeof turn === 'number' && Number.isSafeInteger(turn)) {
        segments.push({ turn, startSeq: event.seq, endSeq: undefined })
      }
    } else if (event.type === 'turn/end') {
      const current = segments[segments.length - 1]
      if (current !== undefined && current.endSeq === undefined) current.endSeq = event.seq
    }
  }
  return segments
}

/** The turn a log seq belongs to (the last turn/start at or before seq). */
export function turnOfSeq(segments, seq) {
  let found
  for (const segment of segments) {
    if (segment.startSeq > seq) break
    found = segment
  }
  return found
}

/** The distinct turns covering a seq list (used to hide shadowed transcript spans). */
export function turnsOfSeqs(segments, seqs) {
  const turns = new Set()
  for (const seq of Array.isArray(seqs) ? seqs : []) {
    const segment = turnOfSeq(segments, seq)
    if (segment !== undefined) turns.add(segment.turn)
  }
  return [...turns].sort((a, b) => a - b)
}

/**
 * Map each surface human user message to its turn anchor. The client uses this
 * to translate a rendered transcript row (which carries data-chat-turn) back
 * to a log seq, because DSH 0.2.x does not expose event seqs to client plugins.
 *
 * @param {readonly object[]} events
 * @param {readonly number[]} surface
 * @returns {{turn:number,userSeq:number,turnStartSeq:number,promptText:string}[]}
 */
export function surfaceUserTurns(events, surface) {
  const segments = buildTurnSegments(events)
  const out = []
  for (const candidate of listCandidates(events, surface, Number.MAX_SAFE_INTEGER)) {
    const segment = turnOfSeq(segments, candidate.seq)
    if (segment === undefined) continue
    out.push({
      turn: segment.turn,
      userSeq: candidate.seq,
      turnStartSeq: segment.startSeq,
      promptText: candidate.preview,
    })
  }
  return out
}

/** Human rendering of one candidate line (command fallback listing). */
export function formatCandidate(candidate) {
  const time = new Date(candidate.time)
  const hh = String(time.getHours()).padStart(2, '0')
  const mm = String(time.getMinutes()).padStart(2, '0')
  return `${candidate.index}. ${hh}:${mm} ${candidate.preview || '(no text)'}`
}
