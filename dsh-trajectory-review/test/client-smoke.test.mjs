/**
 * Client smoke test without a browser: register the bundle through a fake
 * module loader, call the slot's component through a tiny React stand-in, and
 * assert both the off and the reviewed branches render their visible text.
 * Run with: node --test test/
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

/** Minimal React stand-in: enough to execute a render function once. */
function makeReact() {
  const Fragment = Symbol('Fragment')
  const scope = { stack: [], current: { index: 0, values: [] }, presets: [] }
  const withScope = (component, values, run) => {
    const previous = scope.current
    scope.current = { index: 0, values }
    try {
      return run()
    } finally {
      scope.current = previous
    }
  }
  const take = fallback => {
    const index = scope.current.index++
    return scope.current.values[index] ?? fallback
  }
  return {
    Fragment,
    createElement(type, props, ...children) {
      const flat = children.length === 1 ? children[0] : children
      return { type, props: { ...(props ?? {}), ...(children.length === 0 ? {} : { children: flat }) } }
    },
    useState(initial) {
      const value = take(typeof initial === 'function' ? initial() : initial)
      return [value, () => {}]
    },
    useEffect() {},
    useRef(initial) {
      return { current: initial }
    },
    useCallback(fn) {
      return fn
    },
    useMemo(fn) {
      return fn()
    },
    __withScope: withScope,
  }
}

/** Render an element tree to text, executing function components. */
function renderToText(react, node, depth = 0) {
  assert.ok(depth < 60, 'render tree is too deep; a component probably recurses')
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(child => renderToText(react, child, depth + 1)).join(' ')
  if (typeof node.type === 'function') {
    return react.__withScope(node.type, [], () => renderToText(react, node.type(node.props), depth + 1))
  }
  if (typeof node.type === 'symbol') return renderToText(react, node.props?.children, depth + 1)
  return renderToText(react, node.props?.children, depth + 1)
}

/** Load the client bundle once and return its registered plugin face. */
async function loadClient() {
  const registrations = []
  globalThis.window = {
    __ModuleLoader__: {
      load(definition) {
        registrations.push(definition)
      },
    },
  }
  const react = makeReact()
  // Evaluate the plain side-effect bundle as a fresh script per test; an ESM
  // import would run its loader call only once for the whole file.
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  new Function('window', 'document', source)(globalThis.window, globalThis.document)
  assert.equal(registrations.length, 1)
  const definition = registrations[0]
  assert.equal(definition.id, 'dsh-trajectory-review')
  return { definition, react }
}

/** Build the slot registration the plugin's apply() performs. */
async function registerView(react) {
  const { definition } = await loadClient()
  const plugin = definition.factory(() => react)
  const slots = {
    injected: [],
    inject(owner, callback) {
      this.injected.push(owner)
      this.registration = callback()
    },
    register(options, component) {
      return { options, component }
    },
  }
  const disposers = []
  const ctx = {
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return typeof dispose === 'function' ? dispose : () => {}
    },
    slots,
  }
  plugin.apply(ctx)
  assert.deepEqual(plugin.inject, ['slots'])
  assert.deepEqual(slots.injected, ['conversation.view'])
  const registration = slots.registration
  assert.equal(registration.options.id, 'trace-review')
  assert.equal(registration.options.order, 20)
  assert.equal(registration.options.label(), '轨迹审查')
  assert.deepEqual(registration.options.inject('session-9'), { sessionId: 'session-9' })
  return { registration, disposers }
}

/** Fake document so the styles registration succeeds. */
function installDocument() {
  const head = []
  globalThis.document = {
    visibilityState: 'visible',
    head: { appendChild: element => { head.push(element) } },
    createElement: tag => ({ tag, textContent: '', setAttribute() {}, remove() { head.splice(head.indexOf(this), 1) } }),
  }
  return head
}

test('client bundle registers one conversation view and applies its styles', async () => {
  const head = installDocument()
  globalThis.fetch = async () => ({ json: async () => ({ ok: true, state: null }) })
  const react = makeReact()
  const { registration, disposers } = await registerView(react)
  assert.equal(head.length, 1)
  assert.equal(head[0].textContent.includes('.trv-node'), true)
  // Disposal removes the style tag again.
  disposers.forEach(fn => fn())
  assert.equal(head.length, 0)
})

test('the off state explains the feature and offers the toggle', async () => {
  installDocument()
  globalThis.fetch = async () => ({ json: async () => ({ ok: true, state: null }) })
  const react = makeReact()
  const { registration } = await registerView(react)
  const text = renderToText(react, registration.component({ sessionId: 'session-1' }))
  assert.match(text, /为这个会话开启轨迹审查/)
  assert.match(text, /开始审查/)
  assert.match(text, /任务完成质量|四维/)
})

test('the reviewed state renders nodes, counts, and findings', async () => {
  installDocument()
  globalThis.fetch = async () => ({ json: async () => ({ ok: true, state: null }) })
  const react = makeReact()
  const { registration } = await registerView(react)
  const state = {
    sessionId: 'session-1',
    version: 7,
    enabled: true,
    status: 'idle',
    error: null,
    task: '让程序更快找出最大模特征值',
    cwd: '/workspace/app',
    provider: 'p',
    model: 'm',
    ruleVersion: 'live-v1.0',
    counts: { pass: 1, warning: 1, fail: 1, unknown: 0, pending: 1 },
    batches: 2,
    usage: { requests: 2, inputTokens: 900, outputTokens: 120, cacheReadTokens: 0 },
    nodes: [
      {
        id: '3.0', seq: 3, kind: 'think', title: '思考先读实现', detail: '先读实现。',
        severity: 'pass', turn: 1, step: 1, tool: null, isError: false, hasResult: true,
        reviewed: true, coverageNotes: null,
        findings: [
          { dimension: 'task_completion_quality', rating: 'pass', reason: '没有可归因的问题。', evidenceRefs: [] },
          { dimension: 'safety_privacy', rating: 'pass', reason: '没有可归因的问题。', evidenceRefs: [] },
          { dimension: 'reporting_evaluation_integrity', rating: 'pass', reason: '没有可归因的问题。', evidenceRefs: [] },
          { dimension: 'execution_efficiency', rating: 'no', reason: '没有确认重复。', evidenceRefs: [] },
        ],
      },
      {
        id: '5.0', seq: 5, kind: 'run', title: '执行 pytest', detail: 'pytest -q',
        severity: 'fail', turn: 1, step: 1, tool: 'bash', isError: false, hasResult: true,
        reviewed: true, coverageNotes: ['只看到退出码。'],
        findings: [
          { dimension: 'task_completion_quality', rating: 'fail', reason: '测试失败但仍继续删除了实现。', evidenceRefs: ['5.0'] },
          { dimension: 'safety_privacy', rating: 'pass', reason: '没有可归因的问题。', evidenceRefs: [] },
          { dimension: 'reporting_evaluation_integrity', rating: 'warning', reason: '宣称测试通过，但输出是失败。', evidenceRefs: ['5.0'] },
          { dimension: 'execution_efficiency', rating: 'yes', reason: '重复了第 4 步已经完成的同一命令。', evidenceRefs: ['4.0'] },
        ],
      },
      {
        id: '6.0', seq: 6, kind: 'edit', title: '修改 eigen.py', detail: '/app/eigen.py',
        severity: 'warning', turn: 2, step: 1, tool: 'edit', isError: false, hasResult: true,
        reviewed: true, coverageNotes: null, findings: [],
      },
      {
        id: '7.0', seq: 7, kind: 'say', title: '说明已改好', detail: '已经改好了。',
        severity: 'pending', turn: 2, step: 1, tool: null, isError: false, hasResult: true,
        reviewed: false, coverageNotes: null, findings: null,
      },
    ],
  }
  // The first useState call in the view holds the fetched snapshot.
  const view = registration.component
  const text = react.__withScope(view, [state], () => renderToText(react, view({ sessionId: 'session-1', openView: () => {} })))
  assert.match(text, /本会话的四维审查/)
  assert.match(text, /让程序更快找出最大模特征值/)
  assert.match(text, /第 1 轮/)
  assert.match(text, /第 2 轮/)
  assert.match(text, /4 步 · 2 批 · 2 次模型请求/)
  assert.match(text, /轨迹审查 · 实时/)
  assert.match(text, /停止审查/)
  assert.match(text, /原生轨迹/)
  assert.match(text, /无问题|需留意|不通过/)
  assert.match(text, /01/)
  assert.match(text, /04/)

  // Selecting the failing node renders its four dimension cards and reasons.
  const selected = react.__withScope(view, [state, '5.0'], () =>
    renderToText(react, view({ sessionId: 'session-1', openView: () => {} })))
  assert.match(selected, /第 2 步/)
  assert.match(selected, /测试失败但仍继续删除了实现/)
  assert.match(selected, /宣称测试通过，但输出是失败/)
  assert.match(selected, /重复了第 4 步已经完成的同一命令/)
  assert.match(selected, /覆盖率说明|覆盖说明/)
  assert.match(selected, /收起 ×/)

  // The detail must sit inside the selected step's own turn, not in a footer:
  // its text appears after 第 1 轮 and before 第 2 轮, and the old fixed
  // inspector heading is gone.
  const turnOne = selected.indexOf('第 1 轮')
  const turnTwo = selected.indexOf('第 2 轮')
  const reason = selected.indexOf('测试失败但仍继续删除了实现')
  assert.equal(turnOne >= 0 && turnTwo > turnOne, true)
  assert.equal(reason > turnOne && reason < turnTwo, true)
  assert.doesNotMatch(selected, /步骤详情/)
})
