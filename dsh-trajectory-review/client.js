/**
 * Browser half of the trajectory-review plugin.
 *
 * Registers one `conversation.view` tab that reads the Host snapshot over the
 * plugin's own HTTP prefix and renders each reviewed step as a shape-and-colour
 * node. The tab owns no Session data of its own: it renders the Host's view.
 *
 * Written as a plain module-system registration on purpose — the factory body
 * has no top-level import/export, and React comes from the browser module table.
 */
window.__ModuleLoader__.load({
  id: 'dsh-trajectory-review',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback, useMemo } = React

    const NS = 'trajectory-review'

    const DIMENSION_LABELS = {
      task_completion_quality: '任务完成质量',
      safety_privacy: '安全与隐私',
      reporting_evaluation_integrity: '报告与评测诚信',
      execution_efficiency: '效率与重复',
    }
    const KIND_LABELS = {
      think: '思考',
      say: '进度消息',
      run: '工具执行',
      edit: '修改代码或环境',
    }
    const SEVERITY = {
      pass: { label: '无问题', symbol: '✓' },
      warning: { label: '需留意', symbol: '!' },
      fail: { label: '不通过', symbol: '×' },
      unknown: { label: '证据不足', symbol: '?' },
      pending: { label: '待审', symbol: '·' },
    }
    const RATING_LABELS = {
      pass: 'Pass', warning: 'Warning', fail: 'Fail', unknown: 'Unknown', yes: 'Yes', no: 'No',
    }
    const STATUS_LABELS = {
      idle: '审查已就绪',
      reviewing: '正在审查',
      error: '审查中断',
      stopped: '已停止',
    }

    const CSS = `
.trv-root { height: 100%; overflow: auto; box-sizing: border-box; padding: 18px 22px 30px;
  color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1);
  font-family: var(--dsw-font-family, system-ui, sans-serif); font-size: 14px; line-height: 1.55;
  --trv-pass: var(--dsw-alias-state-success-primary);
  --trv-warning: var(--dsw-alias-state-warn-primary);
  --trv-fail: var(--dsw-alias-state-error-primary);
  --trv-unknown: var(--dsw-alias-label-secondary);
  --trv-pending: var(--dsw-alias-label-tertiary); }
.trv-root *, .trv-root *::before, .trv-root *::after { box-sizing: border-box; }
.trv-head { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 12px 20px; }
.trv-heading { min-width: 0; }
.trv-eyebrow { color: var(--dsw-alias-brand-primary); font-size: 12px; font-weight: 650; letter-spacing: .04em; }
.trv-title { font-size: 19px; line-height: 1.35; font-weight: 700; margin: 3px 0 0; }
.trv-task { color: var(--dsw-alias-label-secondary); font-size: 13px; margin: 4px 0 0; max-width: 72ch; }
.trv-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.trv-btn { border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary); border-radius: 8px; padding: 6px 13px; font: inherit;
  font-size: 13px; cursor: pointer; }
.trv-btn:hover { background: var(--dsw-alias-interactive-bg-hover); }
.trv-btn:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary)); outline-offset: 2px; }
.trv-btn[data-variant="primary"] { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-on-color);
  border-color: transparent; font-weight: 600; }
.trv-btn[data-variant="primary"]:hover { background: var(--dsw-alias-button-primary-hover); }
.trv-btn:disabled { opacity: .55; cursor: default; }
.trv-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; margin: 16px 0 10px;
  font-size: 12px; color: var(--dsw-alias-label-secondary); }
.trv-status { display: inline-flex; align-items: center; gap: 6px; }
.trv-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-label-tertiary); }
.trv-status[data-status="reviewing"] .trv-dot { background: var(--dsw-alias-brand-primary); }
.trv-status[data-status="error"] .trv-dot { background: var(--dsw-alias-state-error-primary); }
.trv-status[data-status="idle"] .trv-dot { background: var(--dsw-alias-state-success-primary); }
.trv-legend { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 14px; margin-left: auto; }
.trv-legend-item { display: inline-flex; align-items: center; gap: 5px; }
.trv-legend-item[data-severity="pass"] { color: var(--trv-pass); }
.trv-legend-item[data-severity="warning"] { color: var(--trv-warning); }
.trv-legend-item[data-severity="fail"] { color: var(--trv-fail); }
.trv-legend-item[data-severity="unknown"] { color: var(--trv-unknown); }
.trv-legend-item[data-severity="pending"] { color: var(--trv-pending); }
.trv-legend-item .trv-count { color: var(--dsw-alias-label-primary); }
.trv-kinds { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 14px; margin: 2px 0 10px;
  font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.trv-kind { display: inline-flex; align-items: center; gap: 5px; }
.trv-kind .trv-mark { width: 15px; height: 15px; --trv-color: var(--dsw-alias-label-secondary);
  --trv-bg: var(--dsw-alias-bg-layer-3); }
.trv-legend .trv-symbol { width: 15px; height: 15px; border-radius: 4px; display: inline-grid; place-items: center;
  color: inherit; background: color-mix(in srgb, currentColor 16%, transparent);
  font: 750 10px/1 system-ui, sans-serif; }
.trv-error { border: 1px solid var(--dsw-alias-state-error-primary); border-radius: 10px; padding: 9px 12px;
  margin: 6px 0 12px; color: var(--dsw-alias-state-error-primary); font-size: 13px; display: flex;
  flex-wrap: wrap; gap: 8px 12px; align-items: center; }
.trv-empty { border: 1px dashed var(--dsw-alias-border-l2); border-radius: 12px; padding: 30px 20px;
  display: grid; justify-items: center; gap: 8px; text-align: center; color: var(--dsw-alias-label-secondary); }
.trv-empty h3 { margin: 0; font-size: 15px; color: var(--dsw-alias-label-primary); }
.trv-empty p { margin: 0; font-size: 13px; max-width: 60ch; }
.trv-turn { border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; background: var(--dsw-alias-bg-layer-2);
  padding: 9px 11px 7px; margin-bottom: 9px; }
.trv-turn-head { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: baseline; margin-bottom: 4px;
  font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.trv-turn-name { color: var(--dsw-alias-label-secondary); font-weight: 650; }
.trv-turn-counts { margin-left: auto; font-variant-numeric: tabular-nums; }
.trv-track { display: grid; grid-template-columns: repeat(auto-fill, minmax(52px, 1fr)); gap: 2px; }
.trv-node { position: relative; display: grid; justify-items: center; align-content: center; gap: 4px;
  border: 0; background: none; padding: 5px 2px; border-radius: 7px; cursor: pointer; font: inherit;
  color: var(--dsw-alias-label-tertiary); }
.trv-node:hover { background: var(--dsw-alias-interactive-bg-hover); }
.trv-node:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary)); outline-offset: -1px; }
.trv-node[aria-expanded="true"] { background: var(--dsw-alias-interactive-bg-active); }
.trv-mark { position: relative; z-index: 0; isolation: isolate; display: inline-grid; place-items: center;
  width: 22px; height: 22px; color: var(--trv-color); font: 760 12px/1 system-ui, sans-serif; }
.trv-mark::before, .trv-mark::after { content: ""; position: absolute; z-index: -1; }
.trv-mark::before { inset: 0; background: currentColor; clip-path: var(--trv-shape); border-radius: var(--trv-round, 0); }
.trv-mark::after { inset: 1.5px; background: var(--trv-bg); clip-path: var(--trv-shape); border-radius: var(--trv-round-inner, 0); }
[data-kind="think"] .trv-mark { --trv-shape: polygon(50% 0, 100% 50%, 50% 100%, 0 50%); }
[data-kind="run"] .trv-mark { --trv-round: 3px; --trv-round-inner: 2px; }
[data-kind="edit"] .trv-mark { --trv-shape: polygon(25% 3%, 75% 3%, 100% 50%, 75% 97%, 25% 97%, 0 50%); }
[data-kind="say"] .trv-mark { --trv-shape: circle(50%); }
.trv-num { font: 11px/1.15 ui-monospace, SFMono-Regular, monospace; font-variant-numeric: tabular-nums; }
.trv-node[data-severity="fail"] .trv-num, .trv-node[data-severity="warning"] .trv-num { color: var(--trv-color); font-weight: 700; }
.trv-node[aria-expanded="true"] .trv-num { color: var(--dsw-alias-brand-primary); text-decoration: underline; text-underline-offset: 3px; }
.trv-node[data-severity="pass"], .trv-pill[data-severity="pass"], .trv-card[data-severity="pass"] {
  --trv-color: var(--trv-pass); --trv-bg: color-mix(in srgb, var(--trv-pass) 14%, var(--dsw-alias-bg-layer-2)); }
.trv-node[data-severity="warning"], .trv-pill[data-severity="warning"], .trv-card[data-severity="warning"] {
  --trv-color: var(--trv-warning); --trv-bg: color-mix(in srgb, var(--trv-warning) 18%, var(--dsw-alias-bg-layer-2)); }
.trv-node[data-severity="fail"], .trv-pill[data-severity="fail"], .trv-card[data-severity="fail"] {
  --trv-color: var(--trv-fail); --trv-bg: color-mix(in srgb, var(--trv-fail) 16%, var(--dsw-alias-bg-layer-2)); }
.trv-node[data-severity="unknown"], .trv-pill[data-severity="unknown"], .trv-card[data-severity="unknown"] {
  --trv-color: var(--trv-unknown); --trv-bg: color-mix(in srgb, var(--trv-unknown) 14%, var(--dsw-alias-bg-layer-2)); }
.trv-node[data-severity="pending"], .trv-pill[data-severity="pending"], .trv-card[data-severity="pending"] {
  --trv-color: var(--trv-pending); --trv-bg: color-mix(in srgb, var(--trv-pending) 12%, var(--dsw-alias-bg-layer-2)); }
.trv-hint { margin: 0 0 9px; font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.trv-inline + .trv-track { margin-top: 5px; }
.trv-inline { margin: 7px 0 3px; border: 1px solid var(--dsw-alias-border-l2);
  border-left: 3px solid var(--trv-color, var(--dsw-alias-border-l3)); border-radius: 10px;
  background: var(--dsw-alias-bg-layer-3); padding: 11px 13px 13px; }
.trv-close { border: 0; background: none; color: var(--dsw-alias-label-secondary); cursor: pointer;
  font: inherit; font-size: 12px; padding: 3px 6px; border-radius: 5px; margin-left: auto; }
.trv-close:hover { background: var(--dsw-alias-interactive-bg-hover); }
.trv-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; font-size: 12px;
  color: var(--dsw-alias-label-tertiary); }
.trv-pill { display: inline-flex; align-items: center; gap: 4px; border-radius: 5px; padding: 2px 7px;
  font: 650 11px/1.4 system-ui, sans-serif; color: var(--trv-color, inherit);
  background: var(--trv-bg, var(--dsw-alias-bg-layer-3)); }
.trv-inline h3 { margin: 6px 0 3px; font-size: 17px; line-height: 1.4; font-weight: 680; }
.trv-summary { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 13px; }
.trv-cards { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-top: 12px; }
.trv-card { border: 1px solid var(--dsw-alias-border-l2); border-left: 3px solid var(--trv-color);
  border-radius: 8px; padding: 8px 10px; background: var(--dsw-alias-bg-layer-3); min-width: 0; }
.trv-card[data-severity="pass"] { border-left-color: transparent; }
.trv-card-label { display: flex; align-items: center; justify-content: space-between; gap: 6px;
  font-size: 12px; font-weight: 650; margin-bottom: 3px; }
.trv-card p { margin: 0; font-size: 12.5px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.trv-source { margin-top: 10px; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.trv-pending-note { margin: 10px 0 0; font-size: 12px; color: var(--dsw-alias-label-tertiary); }
@media (max-width: 720px) {
  .trv-root { padding: 12px 12px 22px; }
  .trv-cards { grid-template-columns: minmax(0, 1fr); }
}
`

    /** Same-origin call into this plugin's host prefix. */
    async function call(path, body) {
      const response = await fetch(`/trajectory-review${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? { accept: 'application/json' } : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const data = await response.json()
      if (!data.ok) throw new Error(data.error ?? `HTTP ${response.status}`)
      return data
    }

    /** One shape-and-colour node for a review step. */
    function NodeButton({ node, index, selected, onSelect }) {
      const severity = SEVERITY[node.severity] ?? SEVERITY.pending
      const expanded = selected === node.id
      return h('button', {
        type: 'button',
        className: 'trv-node',
        'data-kind': node.kind,
        'data-severity': node.severity,
        'aria-expanded': expanded,
        'aria-label': `第 ${index} 步，${node.title}，${KIND_LABELS[node.kind] ?? node.kind}，${severity.label}`,
        title: `${node.title} · ${KIND_LABELS[node.kind] ?? node.kind} · ${severity.label}`,
        onClick: () => onSelect(expanded ? null : node.id),
      },
      h('span', { className: 'trv-mark', 'aria-hidden': true }, severity.symbol),
      h('span', { className: 'trv-num', 'aria-hidden': true }, String(index).padStart(2, '0')))
    }

    /** Four dimension cards for the selected step. */
    function Findings({ node }) {
      if (node.findings === null) {
        return h('p', { className: 'trv-pending-note' },
          node.severity === 'pending' ? '这一步还在等待审查结果。' : '这一步没有可用的审查结果。')
      }
      const ordered = Object.keys(DIMENSION_LABELS)
      return h(React.Fragment, null,
        h('div', { className: 'trv-cards' }, ordered.map(dimension => {
          const finding = node.findings.find(item => item.dimension === dimension)
          if (finding === undefined) {
            return h('div', { className: 'trv-card', key: dimension, 'data-severity': 'pending' },
              h('div', { className: 'trv-card-label' }, dimension === 'execution_efficiency'
                ? DIMENSION_LABELS[dimension] : DIMENSION_LABELS[dimension],
              h('span', { className: 'trv-pill' }, '待审')),
              h('p', null, '这个维度没有返回结果。'))
          }
          const isEfficiency = dimension === 'execution_efficiency'
          const cardSeverity = finding.rating === 'yes'
            ? 'warning'
            : finding.rating === 'no' ? 'pass' : finding.rating
          return h('div', { className: 'trv-card', key: dimension, 'data-severity': cardSeverity },
            h('div', { className: 'trv-card-label' },
              h('span', null, DIMENSION_LABELS[dimension]),
              h('span', { className: 'trv-pill', 'data-severity': cardSeverity },
                RATING_LABELS[finding.rating] ?? finding.rating)),
            h('p', null, finding.reason || (isEfficiency ? '没有确认独立无效的重复。' : '这个维度没有可归因的问题。')))
        })),
        node.coverageNotes !== null && node.coverageNotes.length > 0
          ? h('p', { className: 'trv-pending-note' }, `覆盖说明：${node.coverageNotes.join('；')}`)
          : null)
    }

    /** Detail for the selected step, rendered directly under its own turn. */
    function DetailPanel({ node, index, onClose, innerRef }) {
      return h('div', {
        className: 'trv-inline',
        'data-severity': node.severity,
        role: 'region',
        'aria-label': `第 ${index} 步详情`,
        ref: innerRef,
      },
      h('div', { className: 'trv-meta' },
        h('span', null, `第 ${index} 步`),
        h('span', null, KIND_LABELS[node.kind] ?? node.kind),
        node.tool ? h('span', null, node.tool) : null,
        node.isError ? h('span', { className: 'trv-pill' }, '工具失败') : null,
        h('span', { className: 'trv-pill', 'data-severity': node.severity },
          SEVERITY[node.severity].symbol, SEVERITY[node.severity].label),
        h('button', { type: 'button', className: 'trv-close', onClick: onClose }, '收起 ×')),
      h('h3', null, node.title),
      h('p', { className: 'trv-summary' }, node.detail || '这一步没有摘要。'),
      h(Findings, { node }))
    }

    /** The whole review tab. */
    function ReviewView(props) {
      const sessionId = props.sessionId
      const [state, setState] = useState(null)
      const [selected, setSelected] = useState(null)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const versionRef = useRef(0)
      const panelRef = useRef(null)

      useEffect(() => {
        let alive = true
        let timer = null
        let inFlight = false
        const tick = async () => {
          if (!alive || inFlight) return
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
            timer = setTimeout(tick, 2400)
            return
          }
          inFlight = true
          try {
            const data = await call(`/state?sessionId=${encodeURIComponent(sessionId)}&since=${versionRef.current}`)
            if (!alive) return
            if (data.state !== undefined) {
              if (data.state === null) {
                setState(null)
                versionRef.current = 0
              } else {
                versionRef.current = data.state.version
                setState(data.state)
                setError('')
              }
            }
          } catch (failure) {
            if (alive) setError(failure instanceof Error ? failure.message : String(failure))
          } finally {
            inFlight = false
            if (alive) timer = setTimeout(tick, 1100)
          }
        }
        void tick()
        return () => {
          alive = false
          if (timer !== null) clearTimeout(timer)
        }
      }, [sessionId])

      // Keep the opened detail beside its step, and let Escape close it.
      useEffect(() => {
        if (selected !== null) panelRef.current?.scrollIntoView?.({ block: 'nearest' })
        if (selected === null) return undefined
        const onKeyDown = event => {
          if (event.key === 'Escape') setSelected(null)
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
      }, [selected])

      const toggle = useCallback(async () => {
        if (busy) return
        setBusy(true)
        setError('')
        try {
          if (state !== null && state.enabled) {
            const data = await call('/disable', { sessionId })
            versionRef.current = data.state?.version ?? versionRef.current
            if (data.state !== undefined && data.state !== null) setState(data.state)
          } else {
            const data = await call('/enable', { sessionId })
            versionRef.current = data.state?.version ?? versionRef.current
            if (data.state !== undefined && data.state !== null) setState(data.state)
          }
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(false)
        }
      }, [busy, sessionId, state])

      const retry = useCallback(async () => {
        try {
          const data = await call('/review', { sessionId })
          if (data.state !== undefined && data.state !== null) {
            versionRef.current = data.state.version
            setState(data.state)
          }
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [sessionId])

      const openNative = props.openView
      const counts = state?.counts ?? { pass: 0, warning: 0, fail: 0, unknown: 0, pending: 0 }
      const turns = useMemo(() => {
        const groups = []
        const byTurn = new Map()
        for (const node of state?.nodes ?? []) {
          const key = node.turn ?? 0
          let group = byTurn.get(key)
          if (group === undefined) {
            group = { turn: key, nodes: [] }
            byTurn.set(key, group)
            groups.push(group)
          }
          group.nodes.push(node)
        }
        return groups
      }, [state])
      const indexOf = useMemo(() => {
        const map = new Map()
        let index = 0
        for (const node of state?.nodes ?? []) map.set(node.id, ++index)
        return map
      }, [state])
      const selectedNode = state?.nodes?.find(node => node.id === selected) ?? null

      const header = h('div', { className: 'trv-head' },
        h('div', { className: 'trv-heading' },
          h('div', { className: 'trv-eyebrow' }, '轨迹审查 · 实时'),
          h('h1', { className: 'trv-title' }, state?.enabled ? '本会话的四维审查' : '为这个会话开启轨迹审查'),
          state?.task ? h('p', { className: 'trv-task' }, state.task) : null),
        h('div', { className: 'trv-actions' },
          h('button', {
            type: 'button',
            className: 'trv-btn',
            'data-variant': state?.enabled ? undefined : 'primary',
            disabled: busy,
            onClick: toggle,
          }, state?.enabled ? '停止审查' : '开始审查'),
          state?.enabled && props.openView !== undefined
            ? h('button', {
              type: 'button',
              className: 'trv-btn',
              onClick: () => {
                try {
                  openNative('trajectory', '')
                } catch { /* the native trajectory tab may be absent */ }
              },
            }, '原生轨迹')
            : null))

      const bar = state?.enabled
        ? h('div', { className: 'trv-bar' },
          h('span', { className: 'trv-status', 'data-status': state.status },
            h('span', { className: 'trv-dot', 'aria-hidden': true }),
            STATUS_LABELS[state.status] ?? state.status),
          h('span', null, `${state.nodes.length} 步 · ${state.batches} 批 · ${state.usage?.requests ?? 0} 次模型请求`),
          state.model ? h('span', null, state.model) : null,
          h('div', { className: 'trv-legend', 'aria-label': '步骤评级图例' },
            ['fail', 'warning', 'unknown', 'pending', 'pass'].map(severity =>
              h('span', { className: 'trv-legend-item', key: severity, 'data-severity': severity },
                h('span', { className: 'trv-symbol', 'aria-hidden': true }, SEVERITY[severity].symbol),
                SEVERITY[severity].label,
                h('strong', { className: 'trv-count' }, counts[severity] ?? 0)))))
        : null

      const body = state === null || !state.enabled
        ? h('div', { className: 'trv-empty' },
          h('h3', null, '审查在后台进行，不打断主任务'),
          h('p', null,
            '开启后，每一步的执行会按任务完成质量、安全与隐私、报告与评测诚信、效率与重复四个维度评级。'
            + '绿色表示这一步没有发现问题，黄色表示需要留意，红色表示不通过，灰色表示待审或证据不足。'),
          h('p', null, '审查使用当前会话的模型，会在后台发出额外的模型请求。'),
          h('button', {
            type: 'button', className: 'trv-btn', 'data-variant': 'primary', disabled: busy, onClick: toggle,
          }, '开始审查'))
        : h(React.Fragment, null,
          h('div', { className: 'trv-kinds', 'aria-label': '步骤类型图例' },
            ['think', 'say', 'run', 'edit'].map(kind =>
              h('span', { className: 'trv-kind', key: kind, 'data-kind': kind },
                h('span', { className: 'trv-mark', 'aria-hidden': true }),
                KIND_LABELS[kind]))),
          h('p', { className: 'trv-hint' }, '点击任意节点，详情就展开在这一步下面；再点一次或按 Esc 收起。'),
          turns.map(group => {
            const turnCounts = group.nodes.reduce((accumulator, node) => {
              accumulator[node.severity] = (accumulator[node.severity] ?? 0) + 1
              return accumulator
            }, {})
            return h('section', { className: 'trv-turn', key: group.turn },
              h('div', { className: 'trv-turn-head' },
                h('span', { className: 'trv-turn-name' }, group.turn > 0 ? `第 ${group.turn} 轮` : '会话开始'),
                h('span', null, `${group.nodes.length} 步`),
                h('span', { className: 'trv-turn-counts' },
                  `✓ ${turnCounts.pass ?? 0} · ! ${turnCounts.warning ?? 0} · × ${turnCounts.fail ?? 0} · · ${(turnCounts.pending ?? 0) + (turnCounts.unknown ?? 0)}`)),
              (() => {
                const renderNodes = list => h('div', { className: 'trv-track' }, list.map(node =>
                  h(NodeButton, {
                    key: node.id,
                    node,
                    index: indexOf.get(node.id) ?? 0,
                    selected,
                    onSelect: setSelected,
                  })))
                const at = selectedNode !== null && (selectedNode.turn ?? 0) === group.turn
                  ? group.nodes.findIndex(node => node.id === selectedNode.id)
                  : -1
                if (at < 0) return renderNodes(group.nodes)
                return h(React.Fragment, null,
                  renderNodes(group.nodes.slice(0, at + 1)),
                  h(DetailPanel, {
                    key: `detail-${selectedNode.id}`,
                    node: selectedNode,
                    index: indexOf.get(selectedNode.id) ?? 0,
                    onClose: () => setSelected(null),
                    innerRef: panelRef,
                  }),
                  at + 1 < group.nodes.length ? renderNodes(group.nodes.slice(at + 1)) : null)
              })())
          }),
          h('p', { className: 'trv-source' },
            `规则 ${state.ruleVersion}。审查结果是供人工确认的预标注；完整命令与输出请查看原生「轨迹」。`))

      return h('div', { className: 'trv-root' },
        header,
        error !== '' ? h('div', { className: 'trv-error' },
          h('span', null, error),
          state?.enabled ? h('button', { type: 'button', className: 'trv-btn', onClick: retry }, '重试') : null) : null,
        bar,
        body)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // Local styles live with the component and disappear with the plugin.
        ctx.effect(() => {
          const style = document.createElement('style')
          style.setAttribute('data-plugin', 'dsh-trajectory-review')
          style.textContent = CSS
          document.head.appendChild(style)
          return () => style.remove()
        }, 'trajectory-review: styles')

        ctx.slots.inject('conversation.view', () => ctx.slots.register({
          name: 'conversation.view',
          id: 'trace-review',
          order: 20,
          label: () => '轨迹审查',
          inject: sessionId => ({ sessionId }),
        }, ReviewView))
      },
    }
  },
})
