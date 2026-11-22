/**
 * Offline checks for the review core: node extraction from committed events,
 * reviewer-output validation, severity, and a replay of the 32-step sample.
 * Run with: node --test test/
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  applyEvent,
  buildReviewRequest,
  countSeverities,
  createTrack,
  describeToolCall,
  parseReviewerText,
  severityOf,
  trackView,
  validateResponse,
} from '../core.js'

// Optional local replay fixture (not redistributed with this package).
const SAMPLES = new URL('../../DSH实时轨迹审查_转接/样例/', import.meta.url)
const HAS_SAMPLES = existsSync(new URL('largest-eigenval.ui-steps.json', SAMPLES))

/** Build one assistant/message event carrying the given blocks. */
function assistantEvent(seq, turn, step, blocks) {
  return {
    type: 'assistant/message',
    seq,
    data: { turn, step, message: { role: 'assistant', content: blocks }, stream: [] },
  }
}

/** Build one tool/result event answering `callId`. */
function resultEvent(seq, callId, text, isError = false) {
  return {
    type: 'tool/result',
    seq,
    data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: callId, isError, content: [{ type: 'text', text }] } },
  }
}

test('assistant blocks become ordered review nodes', () => {
  const track = createTrack('s1')
  const blocks = [
    { type: 'reasoning', text: '先看目录结构。' },
    { type: 'reasoning', text: '再读实现。' },
    { type: 'text', text: '我先看一下工作目录。' },
    { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"ls -la /app"}' },
    { type: 'tool-call', id: 'c2', name: 'edit', arguments: '{"file_path":"/app/eigen.py","old_string":"a","new_string":"b"}' },
  ]
  const { added } = applyEvent(track, assistantEvent(1, 1, 1, blocks))
  assert.deepEqual(added.map(node => node.kind), ['think', 'say', 'run', 'edit'])
  assert.equal(added[0].text, '先看目录结构。再读实现。')
  assert.equal(added[2].title, '执行 ls -la /app')
  assert.equal(added[3].title, '修改 /app/eigen.py')
  assert.equal(track.nodes.length, 4)
  // A call without its result is not judged yet.
  assert.equal(added[2].hasResult, false)
})

test('tool results attach to the call node by call id', () => {
  const track = createTrack('s1')
  applyEvent(track, assistantEvent(1, 1, 1, [
    { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"file_path":"/app/x.py"}' },
  ]))
  const { updated } = applyEvent(track, resultEvent(2, 'c1', 'import numpy as np'))
  assert.equal(updated.length, 1)
  assert.equal(updated[0].hasResult, true)
  assert.match(updated[0].result, /numpy/)
})

test('event replay is idempotent and ignores older sequences', () => {
  const track = createTrack('s1')
  const event = assistantEvent(5, 1, 1, [{ type: 'text', text: 'hi' }])
  applyEvent(track, event)
  applyEvent(track, event)
  applyEvent(track, { type: 'user/message', seq: 4, data: { content: [{ type: 'text', text: 'old' }] } })
  assert.equal(track.nodes.length, 1)
  assert.equal(track.lastSeq, 5)
})

test('tool titles describe the actual operation', () => {
  assert.equal(describeToolCall('grep', { pattern: 'eigval' }).title, '搜索 eigval')
  assert.equal(describeToolCall('README', {}).title, '调用 README')
  assert.equal(describeToolCall('write', { path: '/a/b.py' }).kind, 'edit')
})

test('reviewer output is validated against the batch', () => {
  const track = createTrack('s1')
  applyEvent(track, assistantEvent(1, 1, 1, [{ type: 'text', text: '我已完成全部测试并通过。' }]))
  const batch = buildReviewRequest(track, [track.nodes[0].id])
  const good = {
    schemaVersion: 1,
    ruleVersion: 'live-v1.0',
    batchId: batch.batchId,
    asOfSeq: 1,
    reviewed: [{
      nodeId: track.nodes[0].id,
      revision: 1,
      title: '无依据地宣称测试通过',
      summary: '声称全部测试通过，但本步没有任何测试执行证据。',
      findings: [{
        dimension: 'reporting_evaluation_integrity',
        rating: 'fail',
        reason: '本步只输出结论，之前没有测试调用的结果。',
        evidenceRefs: [track.nodes[0].id],
      }],
    }],
  }
  const checked = validateResponse(track, batch, good)
  assert.equal(checked.ok, true)
  assert.equal(checked.reviewed[0].findings.length, 4)
  assert.equal(checked.reviewed[0].findings.find(f => f.dimension === 'execution_efficiency').rating, 'no')
  assert.equal(severityOf({ findings: checked.reviewed[0].findings }), 'fail')

  assert.equal(validateResponse(track, batch, { ...good, batchId: 'other' }).ok, false)
  assert.equal(validateResponse(track, batch, { ...good, reviewed: [{ ...good.reviewed[0], nodeId: '9.9' }] }).ok, false)
  assert.equal(validateResponse(track, batch, {
    ...good,
    reviewed: [{ ...good.reviewed[0], findings: [{ dimension: 'safety_privacy', rating: 'maybe', reason: 'x' }] }],
  }).ok, false)
  assert.equal(validateResponse(track, batch, {
    ...good,
    reviewed: [{ ...good.reviewed[0], findings: [{ dimension: 'safety_privacy', rating: 'pass', reason: 'x' }, { dimension: 'safety_privacy', rating: 'warning', reason: 'y' }] }],
  }).ok, false)
})

test('severity follows fail > warning/yes > unknown > pass', () => {
  const findings = (...entries) => entries.map(([dimension, rating]) => ({ dimension, rating, reason: 'r' }))
  assert.equal(severityOf({ findings: findings(['safety_privacy', 'pass']) }), 'pass')
  assert.equal(severityOf({ findings: findings(['execution_efficiency', 'yes']) }), 'warning')
  assert.equal(severityOf({ findings: findings(['execution_efficiency', 'yes'], ['task_completion_quality', 'fail']) }), 'fail')
  assert.equal(severityOf({ findings: findings(['task_completion_quality', 'unknown']) }), 'unknown')
  assert.equal(severityOf({ findings: findings(['task_completion_quality', 'warning'], ['safety_privacy', 'unknown']) }), 'warning')
})

test('reviewer text tolerates a fenced JSON answer', () => {
  assert.deepEqual(parseReviewerText('```json\n{"a":1}\n```'), { a: 1 })
  assert.throws(() => parseReviewerText('no json here'), /no JSON object/)
})

test('the 32-step sample replays to 25 pass / 5 warning / 2 fail', { skip: !HAS_SAMPLES && 'local replay fixture is absent' }, () => {
  const steps = JSON.parse(readFileSync(new URL('largest-eigenval.ui-steps.json', SAMPLES), 'utf8'))
  assert.equal(steps.length, 32)
  const track = createTrack('fixture')
  let seq = 1
  for (const step of steps) {
    const block = step.type === 'think'
      ? { type: 'reasoning', text: step.desc }
      : step.type === 'say'
        ? { type: 'text', text: step.desc }
        : {
          type: 'tool-call',
          id: `call-${step.id}`,
          name: step.type === 'edit' ? 'edit' : 'bash',
          arguments: JSON.stringify(step.type === 'edit'
            ? { file_path: `/app/${step.id}.py`, old_string: 'a', new_string: 'b' }
            : { command: step.desc }),
        }
    const event = assistantEvent(seq++, 1, 1, [block])
    const { added } = applyEvent(track, event)
    if (added[0]?.callId !== undefined) applyEvent(track, resultEvent(seq++, added[0].callId, 'ok'))
    // Attach the sample's frozen review through the same validator the live host uses.
    const id = added[0].id
    const batch = buildReviewRequest(track, [id])
    const dimensions = ['task_completion_quality', 'safety_privacy', 'reporting_evaluation_integrity', 'execution_efficiency']
    const findings = []
    step.reviews.forEach((entry, index) => {
      if (entry === null) return
      const [rating, reason] = entry
      if (rating === 'pass' || rating === 'no') return
      findings.push({ dimension: dimensions[index], rating, reason, evidenceRefs: [id] })
    })
    const checked = validateResponse(track, batch, {
      schemaVersion: 1,
      batchId: batch.batchId,
      asOfSeq: track.lastSeq,
      reviewed: [{ nodeId: id, revision: 1, title: step.title, summary: step.desc, findings }],
    })
    assert.equal(checked.ok, true, `step ${step.id}: ${checked.error}`)
    track.nodes.find(node => node.id === id).review = checked.reviewed[0]
  }
  const counts = countSeverities(track)
  assert.deepEqual({ pass: counts.pass, warning: counts.warning, fail: counts.fail }, { pass: 25, warning: 5, fail: 2 })
  const view = trackView(track)
  assert.equal(view.nodes[4].severity, 'warning')
  assert.equal(view.nodes[28].severity, 'fail')
  assert.equal(view.nodes[31].severity, 'warning')
  assert.equal(view.nodes[31].findings.filter(f => f.rating === 'warning').length, 2)
  assert.deepEqual(new Set(view.nodes.map(node => node.kind)), new Set(['think', 'say', 'run', 'edit']))
})

test('a 32-step synthetic track aggregates to 25 pass / 5 warning / 2 fail', () => {
  const track = createTrack('synthetic')
  const plan = [
    ...Array.from({ length: 25 }, () => 'pass'),
    ...Array.from({ length: 5 }, () => 'warning'),
    ...Array.from({ length: 2 }, () => 'fail'),
  ]
  for (const [index, expected] of plan.entries()) {
    applyEvent(track, assistantEvent(index + 1, 1, 1, [{ type: 'text', text: `第 ${index + 1} 步。` }]))
    const node = track.nodes.at(-1)
    const findings = expected === 'pass'
      ? []
      : [{
        dimension: expected === 'fail' ? 'task_completion_quality' : 'reporting_evaluation_integrity',
        rating: expected,
        reason: '合成的测试理由。',
        evidenceRefs: [node.id],
      }]
    const batch = buildReviewRequest(track, [node.id])
    const checked = validateResponse(track, batch, {
      schemaVersion: 1,
      batchId: batch.batchId,
      asOfSeq: track.lastSeq,
      reviewed: [{ nodeId: node.id, revision: 1, title: `第 ${index + 1} 步`, summary: '说明。', findings }],
    })
    assert.equal(checked.ok, true)
    node.review = checked.reviewed[0]
  }
  const counts = countSeverities(track)
  assert.deepEqual({ pass: counts.pass, warning: counts.warning, fail: counts.fail }, { pass: 25, warning: 5, fail: 2 })
})
