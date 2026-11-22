/**
 * Host half of the trajectory-review plugin.
 *
 * Watches committed Session events for Sessions the user turned review on,
 * turns them into review nodes, asks the current route's model to grade each
 * batch against the four-dimension rules, and serves the resulting snapshot to
 * the browser half over one same-origin HTTP prefix.
 *
 * The plugin adds nothing to the reviewed Session: no events, no tools, no
 * prompts. Review requests are ordinary auxiliary model calls that never enter
 * a Session log.
 * @module dsh-trajectory-review
 */

import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import {
  applyEvent,
  buildReviewRequest,
  DIMENSIONS,
  createTrack,
  parseReviewerText,
  severityOf,
  snippet,
  trackView,
  validateResponse,
  RULE_VERSION,
} from './core.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'trajectory-review'

/** Services required before the plugin is useful. */
export const inject = ['webServer', 'sessions', 'llm']

/** Route prefix owned by this plugin. */
const ROUTE = '/trajectory-review'

/** Defaults; a profile row may override them through its `config`. */
const DEFAULTS = {
  batchSize: 4,
  debounceMs: 2200,
  maxEvidenceChars: 700,
  maxHistoryNodes: 30,
  maxNodes: 1200,
  maxConsecutiveFailures: 2,
  maxTokens: 8192,
  reviewPrompt: '',
  reviewPromptFile: '',
  provider: '',
  model: '',
  stateDir: '',
}

/** Read one JSON request body with a size bound. */
async function readJson(req, limit = 64 * 1024) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limit) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (total === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** Send one JSON response. */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/** Accumulate stream text and the reported token usage for one review call. */
async function streamReview(stream) {
  let text = ''
  let usage = null
  let finish = null
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'reasoning-delta') continue
    else if (chunk.type === 'usage') usage = chunk.usage
    else if (chunk.type === 'finish') {
      finish = chunk.reason
      if (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted') {
        const failure = chunk.reason.failure ?? {}
        throw new Error(`review request ended with ${chunk.reason.kind} ${failure.code ?? ''}: ${failure.message ?? ''}`)
      }
    }
  }
  if (finish === null) throw new Error('review request produced no terminal finish')
  if (finish.kind !== 'stop') throw new Error(`review request ended with ${finish.kind}`)
  return { text, usage }
}

/**
 * Install the host half: tracking, the reviewer loop, persistence, and the
 * HTTP prefix the browser half reads.
 * @param ctx - host plugin context.
 * @param config - the loader row's configuration overrides.
 */
export function apply(ctx, config = {}) {
  const options = { ...DEFAULTS, ...config }
  /** Resolve `~/…` and relative prompt paths (relative to the DSH home). */
  const promptPath = value => {
    if (value.startsWith('~')) return join(homedir(), value.slice(1))
    if (isAbsolute(value)) return value
    return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), value)
  }
  /** Where the rules prompt in use came from: built-in, the config, or a file. */
  let promptSource = 'builtin'
  if (options.reviewPromptFile !== '') {
    try {
      options.reviewPrompt = readFileSync(promptPath(options.reviewPromptFile), 'utf8')
      promptSource = 'file'
      if (String(options.reviewPrompt).trim() === '') {
        options.reviewPrompt = ''
        promptSource = 'builtin'
      }
      if (options.reviewPrompt !== '') {
        ctx.logger?.info?.('trajectory-review: review rules from %s', options.reviewPromptFile)
      }
      if (typeof config.reviewPrompt === 'string' && config.reviewPrompt.trim() !== '') {
        ctx.logger?.warn?.('trajectory-review: reviewPromptFile overrides reviewPrompt')
      }
    } catch (error) {
      ctx.logger?.warn?.(
        'trajectory-review: cannot read reviewPromptFile %s: %s; using the built-in rules',
        options.reviewPromptFile,
        error instanceof Error ? error.message : String(error),
      )
      options.reviewPrompt = ''
      promptSource = 'builtin'
    }
  } else if (typeof options.reviewPrompt === 'string' && options.reviewPrompt.trim() !== '') {
    promptSource = 'config'
  } else {
    options.reviewPrompt = ''
  }
  if (promptSource !== 'builtin') {
    // The output contract is appended to any custom prompt, but a rules text
    // that never mentions a dimension usually means the wrong file was given.
    const missing = DIMENSIONS.filter(dimension => !String(options.reviewPrompt).includes(dimension))
    if (missing.length > 0) {
      ctx.logger?.warn?.(
        'trajectory-review: review rules do not mention %s; responses are still validated against those dimensions',
        missing.join(', '),
      )
    }
  }
  const stateDir = options.stateDir !== ''
    ? options.stateDir
    : join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'trajectory-review')
  /** sessionId -> track */
  const tracks = new Map()
  /** sessionId -> debounce timer for the next batch */
  const timers = new Map()
  /** sessionId -> in-flight review promise */
  const running = new Map()
  /** sessionId -> consecutive failed batches */
  const failures = new Map()
  /** sessionId -> pending persistence timer */
  const writes = new Map()
  /** Sessions with no persisted state, so a poll does not re-read the disk. */
  const missing = new Set()
  /** sessionId -> in-flight persisted-state load */
  const loads = new Map()
  /** Sessions already backfilled from a persisted record after a reload. */
  const resumed = new Set()
  const lifecycle = new AbortController()
  /** Set once the plugin unloads, so late callbacks stop scheduling work. */
  let stopped = false

  const sessionIdOf = session => String(session?.header?.id ?? session?.id ?? '')

  /** Path of one Session's persisted review state. */
  const statePath = sessionId => join(stateDir, `${encodeURIComponent(sessionId)}.json`)

  /** Persist one track soon; coalesces bursts of events. */
  const persist = (track) => {
    if (writes.has(track.sessionId)) return
    const timer = setTimeout(() => {
      writes.delete(track.sessionId)
      const body = JSON.stringify({
        version: track.version,
        ruleVersion: RULE_VERSION,
        sessionId: track.sessionId,
        enabled: track.enabled,
        task: track.task,
        cwd: track.cwd,
        provider: track.provider,
        model: track.model,
        lastSeq: track.lastSeq,
        startedSeq: track.startedSeq,
        usage: track.usage,
        batches: track.batches,
        nodes: track.nodes.map(node => ({
          id: node.id,
          seq: node.seq,
          kind: node.kind,
          title: node.title,
          detail: node.detail,
          text: node.kind === 'think' || node.kind === 'say' ? snippet(node.text ?? '', 400) : undefined,
          toolName: node.toolName,
          callId: node.callId,
          result: node.result,
          isError: node.isError,
          hasResult: node.hasResult,
          turn: node.turn,
          step: node.step,
          review: node.review,
        })),
      })
      mkdir(stateDir, { recursive: true })
        .then(() => writeFile(statePath(track.sessionId), body, 'utf8'))
        .catch(error => ctx.logger?.warn?.('trajectory-review: persist failed: %s', error?.message ?? error))
    }, 700)
    timer.unref?.()
    writes.set(track.sessionId, timer)
  }

  /** Load one Session's persisted state, if this Session was reviewed before. */
  const loadTrack = async (sessionId) => {
    try {
      const raw = await readFile(statePath(sessionId), 'utf8')
      const saved = JSON.parse(raw)
      const track = createTrack(sessionId, options)
      track.enabled = saved.enabled !== false
      track.task = typeof saved.task === 'string' ? saved.task : ''
      track.cwd = typeof saved.cwd === 'string' ? saved.cwd : ''
      track.provider = typeof saved.provider === 'string' ? saved.provider : ''
      track.model = typeof saved.model === 'string' ? saved.model : ''
      track.lastSeq = Number.isInteger(saved.lastSeq) ? saved.lastSeq : -1
      track.startedSeq = Number.isInteger(saved.startedSeq) ? saved.startedSeq : -1
      track.usage = { ...track.usage, ...(saved.usage ?? {}) }
      track.batches = Number.isInteger(saved.batches) ? saved.batches : 0
      track.nodes = Array.isArray(saved.nodes) ? saved.nodes : []
      for (const node of track.nodes) {
        node.review = node.review ?? null
        if (typeof node.callId === 'string') track.byCall.set(node.callId, node)
      }
      track.version = (Number.isInteger(saved.version) ? saved.version : 1) + 1
      return track
    } catch {
      return null
    }
  }

  /**
   * Load a Session's persisted review record once, or report that it has none.
   * Polling a never-reviewed Session must not re-read the disk on every tick.
   * @returns the restored track, or undefined when this Session was never reviewed.
   */
  const loadIfSaved = (sessionId) => {
    const known = tracks.get(sessionId)
    if (known !== undefined) return Promise.resolve(known)
    if (missing.has(sessionId)) return Promise.resolve(undefined)
    const inFlight = loads.get(sessionId)
    if (inFlight !== undefined) return inFlight
    const load = (async () => {
      const restored = await loadTrack(sessionId)
      if (restored === null) {
        missing.add(sessionId)
        return undefined
      }
      tracks.set(sessionId, restored)
      return restored
    })().finally(() => loads.delete(sessionId))
    loads.set(sessionId, load)
    return load
  }

  /** Route (provider/model) used for review calls, preferring an explicit config. */
  const routeOf = track => ({
    provider: options.provider !== '' ? options.provider : track.provider,
    model: options.model !== '' ? options.model : track.model,
  })

  /** Enqueue one node for review when it has enough evidence to judge. */
  const enqueue = (track, node) => {
    if (node.review !== null || track.pending.includes(node.id)) return
    track.pending.push(node.id)
  }

  /** Node ids that are ready: text nodes always, tool nodes once their result landed. */
  const enqueueReady = (track, nodes) => {
    for (const node of nodes) {
      if (node.kind === 'think' || node.kind === 'say') enqueue(track, node)
      else if (node.hasResult) enqueue(track, node)
    }
  }

  /** A closed turn cannot produce more evidence: judge its unanswered calls as they are. */
  const enqueueClosed = (track, turn) => {
    for (const node of track.nodes) {
      if (node.turn !== turn) continue
      if (node.review !== null) continue
      if (!node.hasResult && (node.kind === 'run' || node.kind === 'edit')) enqueue(track, node)
    }
  }

  /** Schedule the next batch after the debounce window. */
  const schedule = (track) => {
    if (stopped || !track.enabled) return
    if (timers.has(track.sessionId)) return
    const timer = setTimeout(() => {
      timers.delete(track.sessionId)
      void pump(track)
    }, options.debounceMs)
    timer.unref?.()
    timers.set(track.sessionId, timer)
  }

  /** Merge one validated batch into the track. */
  const merge = (track, reviewed) => {
    const byId = new Map(track.nodes.map(node => [node.id, node]))
    for (const item of reviewed) {
      const node = byId.get(item.nodeId)
      if (node === undefined) continue
      node.review = {
        title: item.title,
        summary: item.summary,
        findings: item.findings,
        coverageNotes: item.coverageNotes,
        ruleVersion: RULE_VERSION,
        reviewedAt: Date.now(),
      }
      track.reviewCount += 1
    }
    track.version += 1
    track.updatedAt = Date.now()
  }

  /** Run one batch when the track is idle, ready, and enabled. */
  const pump = async (track) => {
    if (stopped || !track.enabled || track.reviewing || running.has(track.sessionId)) return
    // Drop ids already reviewed by an earlier batch or a restored track.
    track.pending = track.pending.filter((id, index, list) =>
      list.indexOf(id) === index
      && track.nodes.find(node => node.id === id)?.review === null)
    if (track.pending.length === 0) {
      track.status = 'idle'
      return
    }
    if (track.nodes.length > options.maxNodes) {
      track.status = 'idle'
      track.error = `轨迹超过 ${options.maxNodes} 个节点，已停止继续审查。`
      return
    }
    const route = routeOf(track)
    if (route.provider === '' || route.model === '') {
      track.status = 'error'
      track.error = '主会话还没有可用的模型路由，等待下一步模型请求后重试。'
      return
    }
    const cap = Math.min(options.batchSize, track.batchCap ?? options.batchSize)
    const ids = track.pending.splice(0, cap)
    const batch = buildReviewRequest(track, ids, options)
    track.reviewing = true
    track.status = 'reviewing'
    track.version += 1
    track.batches += 1
    const task = (async () => {
      try {
        const { text, usage } = await streamReview(ctx.llm.stream({
          provider: route.provider,
          model: route.model,
          system: batch.system,
          messages: [{ role: 'user', content: [{ type: 'text', text: batch.user }] }],
          temperature: 0,
          maxTokens: options.maxTokens,
          sessionId: track.sessionId,
          purpose: 'trajectory-review',
          signal: lifecycle.signal,
        }))
        track.usage.requests += 1
        if (usage !== null) {
          track.usage.inputTokens += Number(usage.inputTokens ?? 0)
          track.usage.outputTokens += Number(usage.outputTokens ?? 0)
          track.usage.cacheReadTokens += Number(usage.cacheReadTokens ?? 0)
        }
        const parsed = parseReviewerText(text)
        const checked = validateResponse(track, batch, parsed)
        if (!checked.ok) throw new Error(`响应校验失败：${checked.error}`)
        merge(track, checked.reviewed)
        failures.set(track.sessionId, 0)
        track.batchCap = undefined
        track.status = 'idle'
        track.error = null
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const failed = (failures.get(track.sessionId) ?? 0) + 1
        failures.set(track.sessionId, failed)
        track.error = message
        ctx.logger?.warn?.('trajectory-review: batch failed: %s', message)
        // A batch cut off by the output cap is not a real failure: halve the
        // batch and try again, without spending the failure budget.
        if (/max-tokens/.test(message) && ids.length > 1) {
          track.batchCap = Math.max(1, Math.floor(ids.length / 2))
          track.pending.unshift(...ids.filter(id => track.nodes.find(node => node.id === id)?.review === null))
          failures.set(track.sessionId, Math.max(0, failed - 1))
          track.status = 'idle'
        } else if (failed < options.maxConsecutiveFailures) {
          // One retry per failure budget: keep the nodes queued and let the
          // debounce timer try again with a fresh request.
          track.pending.unshift(...ids.filter(id => track.nodes.find(node => node.id === id)?.review === null))
          track.status = 'idle'
        } else {
          track.status = 'error'
        }
        track.version += 1
      } finally {
        track.reviewing = false
        running.delete(track.sessionId)
        persist(track)
        if (track.enabled && track.pending.length > 0 && track.status !== 'error') {
          schedule(track)
        }
      }
    })()
    running.set(track.sessionId, task)
    await task
  }

  /** Start reviewing one Session: create or restore the track, then backfill. */
  const enable = async (sessionId, force = true) => {
    let track = tracks.get(sessionId) ?? await loadIfSaved(sessionId)
    if (track === undefined) {
      track = createTrack(sessionId, options)
      tracks.set(sessionId, track)
    }
    if (force) track.enabled = true
    if (track.error === '主会话还没有可用的模型路由，等待下一步模型请求后重试。') track.error = null
    if (track.status === 'stopped') track.status = 'idle'
    const session = ctx.sessions.get(sessionId)
    if (session !== undefined) {
      const cwd = session.header?.cwd
      if (typeof cwd === 'string' && cwd !== '') track.cwd = cwd
      if (track.startedSeq < 0) track.startedSeq = track.lastSeq + 1
      // Fold every committed event this track has not seen, so a review started
      // mid-conversation (or after a restart) covers the steps that already happened.
      let events = []
      try {
        events = session.snapshotEvents(Math.max(0, track.lastSeq + 1), Number(session.seq))
      } catch (error) {
        ctx.logger?.warn?.('trajectory-review: history read failed: %s', error?.message ?? error)
      }
      for (const event of events) {
        const outcome = applyEvent(track, event)
        enqueueReady(track, outcome.added)
        enqueueReady(track, outcome.updated)
        if (event.type === 'turn/end') enqueueClosed(track, event.data?.turn)
      }
    }
    // Retry anything a failed batch left behind.
    for (const node of track.nodes) {
      if (node.review !== null) continue
      if (node.kind === 'think' || node.kind === 'say' || node.hasResult) enqueue(track, node)
    }
    track.version += 1
    persist(track)
    if (track.pending.length > 0) schedule(track)
    return track
  }

  /** Stop reviewing one Session without discarding what was reviewed. */
  const disable = sessionId => {
    const track = tracks.get(sessionId)
    if (track === undefined) return
    track.enabled = false
    track.pending.length = 0
    track.status = 'stopped'
    track.version += 1
    const timer = timers.get(sessionId)
    if (timer !== undefined) {
      clearTimeout(timer)
      timers.delete(sessionId)
    }
    persist(track)
  }

  // One post-commit listener: filter to enabled Sessions, reduce, and queue.
  ctx.effect(() => ctx.on('session/event', (session, event) => {
    const sessionId = sessionIdOf(session)
    const track = tracks.get(sessionId)
    if (track === undefined || !track.enabled) return
    const outcome = applyEvent(track, event)
    if (outcome.added.length > 0 || outcome.updated.length > 0) {
      enqueueReady(track, outcome.added)
      enqueueReady(track, outcome.updated)
    }
    if (event.type === 'turn/end') enqueueClosed(track, event.data?.turn)
    if (outcome.added.length === 0 && outcome.updated.length === 0 && event.type !== 'turn/end') return
    track.version += 1
    persist(track)
    if (track.pending.length >= options.batchSize) {
      const timer = timers.get(sessionId)
      if (timer !== undefined) {
        clearTimeout(timer)
        timers.delete(sessionId)
      }
      void pump(track)
    } else if (track.pending.length > 0) {
      schedule(track)
    }
  }))

  // The HTTP prefix the browser half reads and toggles.
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE,
    handler: async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const tail = url.pathname.slice(ROUTE.length) || '/'
        if (req.method === 'GET' && tail === '/state') {
          const sessionId = url.searchParams.get('sessionId') ?? ''
          const track = tracks.get(sessionId) ?? await loadIfSaved(sessionId)
          if (track === undefined) {
            sendJson(res, 200, { ok: true, state: null })
            return
          }
          // Reopening a reviewed Session resumes it: fold the events that
          // happened since the saved cursor and keep reviewing if it was on.
          if (track.enabled && !resumed.has(sessionId)) {
            resumed.add(sessionId)
            void enable(sessionId, false)
          }
          const since = Number(url.searchParams.get('since') ?? '0')
          if (since === track.version) {
            sendJson(res, 200, { ok: true, unchanged: true, version: track.version })
            return
          }
          sendJson(res, 200, { ok: true, state: trackView(track) })
          return
        }
        if (req.method === 'GET' && tail === '/diag') {
          // Read-only diagnostics: why the browser half is or is not composed.
          const readService = name => (typeof ctx.get === 'function' ? ctx.get(name) : undefined)
          const clientModules = readService('clientModules')
          const loader = readService('loader')
          const internal = loader?.internal
          const base = loader?.baseUrl ?? (process.env.DSH_PROFILE_DIR === undefined
            ? 'file:///'
            : `file://${process.env.DSH_PROFILE_DIR}/`)
          const report = {
            hasClientModules: clientModules !== undefined,
            clientPath: clientModules?.clientPath?.('dsh-trajectory-review') ?? null,
            baseline: clientModules?.artifactBaseline?.('dsh-trajectory-review') ?? null,
            graphEntry: clientModules?.graph?.().entries?.find(entry => entry.id === 'dsh-trajectory-review') ?? null,
            reviewPrompt: {
              source: promptSource,
              chars: String(options.reviewPrompt ?? '').length,
            },
            loader: {
              base: String(base),
              hasInternal: internal !== undefined,
              internalVersion: internal?.version ?? null,
            },
          }
          const attempt = (label, run) => {
            try {
              report[label] = run()
            } catch (error) {
              report[`${label}Error`] = error instanceof Error ? error.message : String(error)
            }
          }
          attempt('resolveModule', () => JSON.stringify(internal.resolveSync(base, { specifier: 'dsh-trajectory-review', attributes: {} })))
          attempt('resolvePkgJson', () => createRequire(String(base)).resolve('dsh-trajectory-review/package.json'))
          attempt('manifestClient', () => {
            const file = createRequire(String(base)).resolve('dsh-trajectory-review/package.json')
            const pkg = JSON.parse(require('node:fs').readFileSync(file, 'utf8'))
            return JSON.stringify({ dsh: pkg.dsh, exports: pkg.exports })
          })
          sendJson(res, 200, { ok: true, report })
          return
        }
        if (req.method === 'POST' && tail === '/enable') {
          const body = await readJson(req)
          const sessionId = String(body.sessionId ?? '')
          if (sessionId === '') {
            sendJson(res, 400, { ok: false, error: 'sessionId is required' })
            return
          }
          const track = await enable(sessionId)
          sendJson(res, 200, { ok: true, state: trackView(track) })
          return
        }
        if (req.method === 'POST' && tail === '/disable') {
          const body = await readJson(req)
          const sessionId = String(body.sessionId ?? '')
          disable(sessionId)
          const track = tracks.get(sessionId)
          sendJson(res, 200, { ok: true, state: track === undefined ? null : trackView(track) })
          return
        }
        if (req.method === 'POST' && tail === '/review') {
          const body = await readJson(req)
          const sessionId = String(body.sessionId ?? '')
          const track = tracks.get(sessionId)
          if (track !== undefined) {
            track.error = null
            failures.set(sessionId, 0)
            track.version += 1
            void pump(track)
          }
          sendJson(res, 200, { ok: true, state: track === undefined ? null : trackView(track) })
          return
        }
        sendJson(res, 404, { ok: false, error: 'unknown trajectory-review route' })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'trajectory-review: /trajectory-review routes')

  ctx.effect(() => () => {
    stopped = true
    lifecycle.abort()
    for (const timer of timers.values()) clearTimeout(timer)
    for (const timer of writes.values()) clearTimeout(timer)
  }, 'trajectory-review: stop timers and in-flight reviews')
}
