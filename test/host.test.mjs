/**
 * Host pipeline check: wires the plugin into a fake Cordis context, emits
 * committed Session events, and asserts that a batch is reviewed, validated,
 * persisted, and served over the plugin's HTTP prefix.
 * Run with: node --test test/
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'

/** A Session stub with the surface this plugin uses. */
function fakeSession(id, events) {
  return {
    header: { id, cwd: '/workspace/app' },
    seq: events.length,
    snapshotEvents: (from = 0, to = events.length) => events.slice(from, to),
  }
}

/** The JSON payload a reviewer request carries. */
function payloadOf(options) {
  return JSON.parse(options.messages[0].content[0].text)
}

/** One valid reviewer answer for whatever batch was asked. */
function answerFor(options, text = '这是一步普通操作，没有发现问题。') {
  const payload = payloadOf(options)
  return JSON.stringify({
    schemaVersion: 1,
    ruleVersion: 'live-v1.0',
    batchId: payload.batchId,
    asOfSeq: payload.asOfSeq,
    reviewed: payload.nodes.map(node => ({
      nodeId: node.nodeId,
      revision: node.revision,
      title: `审 ${node.localTitle}`,
      summary: text,
      findings: [],
    })),
  })
}

/** An async iterable of StreamChunks producing one text answer. */
async function* streamOf(text, kind = 'stop') {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  if (kind === 'stop') yield { type: 'text-delta', index: 0, text }
  yield { type: 'usage', usage: { inputTokens: 120, outputTokens: 40, cacheReadTokens: 30 } }
  yield { type: 'finish', reason: { kind } }
}

/** Collect one HTTP response from the registered route. */
function callRoute(spec, method, url, body) {
  return new Promise((resolve, reject) => {
    const response = {
      status: 0,
      headers: {},
      writeHead(status, headers) {
        this.status = status
        this.headers = headers ?? {}
      },
      end(payload) {
        resolve({ status: this.status, headers: this.headers, body: JSON.parse(payload) })
      },
    }
    const request = body === undefined
      ? { method, url }
      : Object.assign(
        (async function* () { yield Buffer.from(JSON.stringify(body)) })(),
        { method, url },
      )
    Promise.resolve(spec.handler(request, response)).catch(reject)
  })
}

test('one enabled Session is reviewed, persisted, and served', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'traj-review-'))
  const events = [
    { type: 'request/header', seq: 1, data: { header: { config: { provider: 'p', model: 'm' } }, reason: 'initial' } },
    { type: 'user/message', seq: 2, data: { content: [{ type: 'text', text: '把求解器改快一点' }] } },
    {
      type: 'assistant/message',
      seq: 3,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: '先读实现。' },
            { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"file_path":"/workspace/app/eigen.py"}' },
          ],
        },
      },
    },
    {
      type: 'tool/result',
      seq: 4,
      data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'def eig(): ...' }] } },
    },
  ]
  const session = fakeSession('sess-1', events)

  let route
  const listeners = new Map()
  const prompts = []
  const ctx = {
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    on(event, listener) {
      listeners.set(event, listener)
      return () => listeners.delete(event)
    },
    logger: { warn() {}, info() {} },
    sessions: { get: id => (id === 'sess-1' ? session : undefined) },
    webServer: { register: spec => { route = spec; return () => { route = undefined } } },
    llm: {
      stream(options) {
        prompts.push(options)
        return streamOf(answerFor(options))
      },
    },
  }

  apply(ctx, { stateDir, debounceMs: 5, batchSize: 2 })

  // Opening the tab before review starts shows an off state.
  const off = await callRoute(route, 'GET', '/trajectory-review/state?sessionId=sess-1&since=0')
  assert.equal(off.body.ok, true)
  assert.equal(off.body.state, null)

  const enabled = await callRoute(route, 'POST', '/trajectory-review/enable', { sessionId: 'sess-1' })
  assert.equal(enabled.body.ok, true)
  assert.equal(enabled.body.state.enabled, true)
  assert.equal(enabled.body.state.task, '把求解器改快一点')
  assert.equal(enabled.body.state.provider, 'p')
  assert.equal(enabled.body.state.nodes.length, 2)

  // Committed events after enabling flow through the same reducer.
  listeners.get('session/event')(session, {
    type: 'assistant/message',
    seq: 5,
    data: { turn: 2, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '已经改好了。' }] } },
  })

  await new Promise(resolve => setTimeout(resolve, 300))

  assert.equal(prompts.length >= 1, true)
  assert.equal(prompts[0].provider, 'p')
  assert.equal(prompts[0].model, 'm')
  assert.equal(prompts[0].purpose, 'trajectory-review')
  assert.match(prompts[0].system, /四维/)

  const state = await callRoute(route, 'GET', '/trajectory-review/state?sessionId=sess-1&since=0')
  const view = state.body.state
  assert.equal(view.nodes.length, 3)
  assert.equal(view.nodes.every(node => node.reviewed === true), true)
  assert.equal(view.counts.pass, 3)
  assert.equal(view.usage.requests >= 1, true)
  assert.equal(view.usage.inputTokens >= 120, true)

  // An unchanged since-cursor answers without resending the snapshot.
  const unchanged = await callRoute(route, 'GET', `/trajectory-review/state?sessionId=sess-1&since=${view.version}`)
  assert.equal(unchanged.body.unchanged, true)

  // Turning review off keeps the results but stops new batches.
  const disabled = await callRoute(route, 'POST', '/trajectory-review/disable', { sessionId: 'sess-1' })
  assert.equal(disabled.body.state.enabled, false)
  assert.equal(disabled.body.state.nodes.length, 3)

  await new Promise(resolve => setTimeout(resolve, 900))
  const saved = JSON.parse(await readFile(join(stateDir, 'sess-1.json'), 'utf8'))
  assert.equal(saved.sessionId, 'sess-1')
  assert.equal(saved.nodes.length, 3)
  assert.equal(saved.nodes[2].review.summary.length > 0, true)

  await rm(stateDir, { recursive: true, force: true })
})

test('a malformed reviewer answer is rejected and retried', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'traj-review-'))
  const events = [
    { type: 'request/header', seq: 1, data: { header: { config: { provider: 'p', model: 'm' } }, reason: 'initial' } },
    { type: 'assistant/message', seq: 2, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '做完了。' }] } } },
  ]
  const session = fakeSession('sess-2', events)
  let route
  let attempts = 0
  const ctx = {
    effect: fn => { fn(); return () => {} },
    on: () => () => {},
    logger: { warn() {} },
    sessions: { get: () => session },
    webServer: { register: spec => { route = spec; return () => {} } },
    llm: {
      stream(options) {
        attempts += 1
        // First answer names a node outside the batch; the retry is valid.
        if (attempts === 1) return streamOf(JSON.stringify({
          schemaVersion: 1, ruleVersion: 'live-v1.0', batchId: 'wrong', asOfSeq: 0, reviewed: [],
        }))
        return streamOf(answerFor(options))
      },
    },
  }
  apply(ctx, { stateDir, debounceMs: 5, batchSize: 2, maxConsecutiveFailures: 2 })
  await callRoute(route, 'POST', '/trajectory-review/enable', { sessionId: 'sess-2' })
  await new Promise(resolve => setTimeout(resolve, 400))
  assert.equal(attempts >= 2, true)
  const state = await callRoute(route, 'GET', '/trajectory-review/state?sessionId=sess-2&since=0')
  assert.equal(state.body.state.nodes[0].reviewed, true)
  assert.equal(state.body.state.error, null)
  await rm(stateDir, { recursive: true, force: true })
})

test('a batch cut off by the output cap is split and retried', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'traj-review-'))
  const events = [
    { type: 'request/header', seq: 1, data: { header: { config: { provider: 'p', model: 'm' } }, reason: 'initial' } },
  ]
  for (let index = 0; index < 5; index++) {
    events.push({
      type: 'assistant/message',
      seq: 2 + index,
      data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: `第 ${index} 步说明。` }] } },
    })
  }
  const session = fakeSession('sess-3', events)
  let route
  const sizes = []
  const ctx = {
    effect: fn => { fn(); return () => {} },
    on: () => () => {},
    logger: { warn() {} },
    sessions: { get: () => session },
    webServer: { register: spec => { route = spec; return () => {} } },
    llm: {
      stream(options) {
        const payload = payloadOf(options)
        sizes.push(payload.nodes.length)
        // The first four-node batch is truncated by the output cap.
        if (payload.nodes.length === 4 && sizes.length === 1) return streamOf('', 'max-tokens')
        return streamOf(answerFor(options))
      },
    },
  }
  apply(ctx, { stateDir, debounceMs: 5, batchSize: 4 })
  await callRoute(route, 'POST', '/trajectory-review/enable', { sessionId: 'sess-3' })
  await new Promise(resolve => setTimeout(resolve, 600))
  assert.equal(sizes.length >= 2, true)
  assert.equal(sizes[0], 4)
  assert.equal(sizes[1], 2)
  const state = await callRoute(route, 'GET', '/trajectory-review/state?sessionId=sess-3&since=0')
  assert.equal(state.body.state.nodes.every(node => node.reviewed === true), true)
  assert.equal(state.body.state.error, null)
  await rm(stateDir, { recursive: true, force: true })
})

test('a configured rules prompt replaces the built-in rules but keeps the contract', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'traj-review-'))
  const events = [
    { type: 'request/header', seq: 1, data: { header: { config: { provider: 'p', model: 'm' } }, reason: 'initial' } },
    { type: 'assistant/message', seq: 2, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '做完了。' }] } } },
  ]
  const session = fakeSession('sess-4', events)
  let route
  const prompts = []
  const ctx = {
    effect: fn => { fn(); return () => {} },
    on: () => () => {},
    logger: { warn() {}, info() {} },
    sessions: { get: () => session },
    webServer: { register: spec => { route = spec; return () => {} } },
    llm: {
      stream(options) {
        prompts.push(options)
        return streamOf(answerFor(options))
      },
    },
  }
  apply(ctx, { stateDir, debounceMs: 5, batchSize: 2, reviewPrompt: '自定义规则：只审安全边界。' })
  await callRoute(route, 'POST', '/trajectory-review/enable', { sessionId: 'sess-4' })
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(prompts.length >= 1, true)
  assert.match(prompts[0].system, /^自定义规则：只审安全边界。/)
  assert.doesNotMatch(prompts[0].system, /你是后台轨迹审查员/)
  assert.match(prompts[0].system, /"reviewed"/)
  const diag = await callRoute(route, 'GET', '/trajectory-review/diag')
  assert.equal(diag.body.report.reviewPrompt.source, 'config')
  await rm(stateDir, { recursive: true, force: true })
})

test('a rules prompt file wins, and an unreadable file falls back to the built-in rules', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'traj-review-'))
  const rulesFile = join(stateDir, 'rules.md')
  await (await import('node:fs/promises')).writeFile(rulesFile, '文件规则：效率优先。', 'utf8')
  const events = [
    { type: 'request/header', seq: 1, data: { header: { config: { provider: 'p', model: 'm' } }, reason: 'initial' } },
    { type: 'assistant/message', seq: 2, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '做完了。' }] } } },
  ]
  const session = fakeSession('sess-5', events)
  let route
  const prompts = []
  const ctx = {
    effect: fn => { fn(); return () => {} },
    on: () => () => {},
    logger: { warn() {}, info() {} },
    sessions: { get: () => session },
    webServer: { register: spec => { route = spec; return () => {} } },
    llm: {
      stream(options) {
        prompts.push(options)
        return streamOf(answerFor(options))
      },
    },
  }
  apply(ctx, { stateDir, debounceMs: 5, batchSize: 2, reviewPromptFile: rulesFile, reviewPrompt: '应被忽略' })
  await callRoute(route, 'POST', '/trajectory-review/enable', { sessionId: 'sess-5' })
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.match(prompts[0].system, /^文件规则：效率优先。/)

  // A second plugin instance pointed at a missing file keeps working.
  const prompts2 = []
  let route2
  const ctx2 = {
    effect: fn => { fn(); return () => {} },
    on: () => () => {},
    logger: { warn() {}, info() {} },
    sessions: { get: () => session },
    webServer: { register: spec => { route2 = spec; return () => {} } },
    llm: { stream(options) { prompts2.push(options); return streamOf(answerFor(options)) } },
  }
  apply(ctx2, { stateDir, debounceMs: 5, batchSize: 2, reviewPromptFile: join(stateDir, 'missing.md') })
  await callRoute(route2, 'POST', '/trajectory-review/enable', { sessionId: 'sess-5b' })
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.match(prompts2[0].system, /你是后台轨迹审查员/)
  await rm(stateDir, { recursive: true, force: true })
})
