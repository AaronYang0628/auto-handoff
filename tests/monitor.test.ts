import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addManualMark, createMonitorState, getMonitorStatus, MonitorSourceError, pollMonitor } from '../src/monitor.ts';

const NOW = '2026-10-02T03:00:00.000Z';
const LATER = '2026-10-02T04:00:00.000Z';
const SESSION = 'synthetic-session-a';
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
async function fixture(t: any, adapter: 'codex-rollout-v1-partial' | 'csm-jsonl-v1' = 'codex-rollout-v1-partial') {
  const cwd = await mkdtemp(join(tmpdir(), 'csm-monitor-中文 '));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const path = join(cwd, 'synthetic events.jsonl');
  const meta = adapter === 'codex-rollout-v1-partial'
    ? { timestamp: NOW, type: 'session_meta', payload: { id: SESSION, cwd } }
    : { schema_version: 1, timestamp: NOW, type: 'session_meta', session_id: SESSION, cwd };
  const state = createMonitorState({ sessionId: SESSION, cwd, sourcePath: path, adapter });
  await writeFile(path, line(meta));
  return { cwd, path, meta, state };
}
function usage(last: number | null, total = 9_000_000, timestamp: string | null = NOW, window: number | null = 100_000) {
  return { timestamp, type: 'event_msg', payload: { type: 'token_count', info: {
    last_token_usage: last === null ? null : { total_tokens: last },
    total_token_usage: { total_tokens: total, cached_input_tokens: 1234 },
    model_context_window: window,
  } } };
}
function normalized(type: string, payload: Record<string, unknown>, eventId: string) {
  return { schema_version: 1, timestamp: NOW, event_id: eventId, type, session_id: SESSION, payload };
}

test('cumulative tokens never become context occupancy', async t => {
  const f = await fixture(t);
  await appendFile(f.path, line(usage(null)));
  const { status } = await pollMonitor(f.state, { now: NOW });
  assert.equal(status.metrics.cumulative_tokens.value, 9_000_000);
  assert.equal(status.metrics.cumulative_tokens.availability, 'available');
  assert.equal(status.metrics.context_occupancy_percent.value, null);
  assert.equal(status.metrics.context_occupancy_percent.availability, 'unknown');
  assert.equal(status.recommendation.state, 'insufficient_data');
});

test('last-request occupancy is explicitly estimated and thresholds are heuristics', async t => {
  const f = await fixture(t);
  await appendFile(f.path, line(usage(90_000)));
  const before = await readFile(f.path);
  const { state, status } = await pollMonitor(f.state, { now: NOW });
  assert.deepEqual(await readFile(f.path), before, 'source remains read-only');
  assert.equal(status.metrics.context_occupancy_percent.value, 90);
  assert.equal(status.metrics.context_occupancy_percent.availability, 'estimated');
  assert.equal(status.metrics.context_occupancy_percent.measurement_method, 'last_request_tokens_div_model_window');
  assert.equal(status.recommendation.state, 'handoff_suggested');
  assert.equal(status.recommendation.heuristic, true);
  assert.equal(status.recommendation.evidence[0].line, 2);
  assert.equal(getMonitorStatus(state, { now: NOW }).recommendation.notify, false);
  assert.equal(getMonitorStatus(state, { now: NOW }).recommendation.suppressed_reason, 'duplicate_recommendation');
});

test('explicit normalized runtime context is distinct from the partial rollout estimate', async t => {
  const f = await fixture(t, 'csm-jsonl-v1');
  await appendFile(f.path, line(normalized('context_usage', { context_tokens: 71, context_window_tokens: 100, cumulative_tokens: 10_000, measurement_method: 'runtime_reported_context' }, 'usage-1')));
  const { status } = await pollMonitor(f.state, { now: NOW });
  assert.equal(status.metrics.context_occupancy_percent.availability, 'available');
  assert.equal(status.metrics.context_occupancy_percent.value, 71);
  assert.equal(status.recommendation.state, 'checkpoint');
  const highThreshold = getMonitorStatus((await pollMonitor(f.state, { now: NOW })).state, { now: NOW, rules: { checkpointPercent: 80, handoffPercent: 95 } });
  assert.equal(highThreshold.recommendation.state, 'continue');
});

test('unknown normalized measurement semantics cannot claim occupancy', async t => {
  const f = await fixture(t, 'csm-jsonl-v1');
  await appendFile(f.path, line(normalized('context_usage', { context_tokens: 99, context_window_tokens: 100, cumulative_tokens: 300 }, 'usage-1')));
  const { status } = await pollMonitor(f.state, { now: NOW });
  assert.equal(status.metrics.context_occupancy_percent.availability, 'unknown');
  assert.equal(status.metrics.cumulative_tokens.value, 300);
});

test('same-workspace different session is rejected before any state is returned', async t => {
  const f = await fixture(t);
  await writeFile(f.path, line({ ...f.meta, payload: { id: 'synthetic-session-b', cwd: f.cwd } }) + line(usage(99_000)));
  await assert.rejects(pollMonitor(f.state, { now: NOW }), (error: any) => error instanceof MonitorSourceError && error.code === 'session_mismatch');
  assert.equal(f.state.events.length, 0);
});

test('workspace conflicts and later conflicting event identity are rejected', async t => {
  const f = await fixture(t);
  await writeFile(f.path, line({ ...f.meta, payload: { id: SESSION, cwd: join(f.cwd, 'other') } }));
  await assert.rejects(pollMonitor(f.state), { code: 'workspace_mismatch' });
  await writeFile(f.path, line(f.meta) + line({ ...usage(80_000), session_id: 'synthetic-session-b' }));
  await assert.rejects(pollMonitor(f.state), { code: 'session_mismatch' });
});

test('source lacking both identity fields is rejected; no newest-file fallback exists', async t => {
  const f = await fixture(t);
  await writeFile(f.path, line(usage(80_000)));
  await assert.rejects(pollMonitor(f.state), { code: 'missing_identity' });
  await writeFile(f.path, line({ type: 'session_meta', payload: { id: SESSION } }));
  await assert.rejects(pollMonitor(f.state), { code: 'missing_identity' });
});

test('partial UTF-8 JSONL records survive saved state without retaining raw text', async t => {
  const f = await fixture(t);
  const record = Buffer.from(line({ ...usage(75_000), irrelevant: '秘密中文' }));
  const partialAt = record.indexOf(Buffer.from('秘')) + 1;
  await appendFile(f.path, record.subarray(0, partialAt));
  const first = await pollMonitor(f.state, { now: NOW });
  assert.equal(first.events.length, 1);
  assert.ok(first.status.pending_bytes > 0);
  assert.equal(first.status.metrics.context_occupancy_percent.value, null);
  assert.equal(JSON.stringify(first.state).includes('irrelevant'), false);
  await appendFile(f.path, record.subarray(partialAt));
  const second = await pollMonitor(JSON.parse(JSON.stringify(first.state)), { now: NOW });
  assert.equal(second.events.length, 1);
  assert.equal(second.status.metrics.context_occupancy_percent.value, 75);
  assert.equal(second.status.pending_bytes, 0);
  assert.equal((await pollMonitor(second.state, { now: NOW })).events.length, 0);
});

test('duplicate event IDs and replay after file rotation are deduplicated', async t => {
  const f = await fixture(t);
  const record = { ...usage(88_000), event_id: 'event-1' };
  await appendFile(f.path, line(record) + line(record));
  const first = await pollMonitor(f.state, { now: NOW });
  assert.equal(first.state.events.filter(event => event.kind === 'context_usage').length, 1);
  await rename(f.path, `${f.path}.old`);
  await writeFile(f.path, line(f.meta) + line(record));
  const replay = await pollMonitor(first.state, { now: NOW });
  assert.equal(replay.events.length, 0);
  assert.equal(replay.state.identity_verified, true);
  assert.equal(replay.state.cursor.generation, 2);
  assert.ok(replay.status.diagnostics.some(item => item.code === 'source_rotated'));
});

test('rotation re-verifies session and does not silently accept another source', async t => {
  const f = await fixture(t);
  const first = await pollMonitor(f.state, { now: NOW });
  await rename(f.path, `${f.path}.old`);
  await writeFile(f.path, line({ ...f.meta, payload: { id: 'different-session', cwd: f.cwd } }));
  await assert.rejects(pollMonitor(first.state, { now: NOW }), { code: 'session_mismatch' });
});

test('copy-truncate and same-size rewrite restart at explicit source metadata', async t => {
  const f = await fixture(t);
  await appendFile(f.path, line(usage(70_000)));
  const first = await pollMonitor(f.state, { now: NOW });
  await writeFile(f.path, line(f.meta) + line(usage(80_000)));
  const second = await pollMonitor(first.state, { now: NOW });
  assert.equal(second.state.cursor.generation, 2);
  assert.equal(second.status.metrics.context_occupancy_percent.value, 80);
  await writeFile(f.path, line(f.meta));
  const third = await pollMonitor(second.state, { now: NOW });
  assert.equal(third.state.cursor.generation, 3);
});

test('stale observation and missing timestamps remain unavailable for recommendations', async t => {
  const f = await fixture(t);
  await appendFile(f.path, line(usage(90_000)));
  const first = await pollMonitor(f.state, { now: NOW });
  const status = getMonitorStatus(first.state, { now: LATER });
  assert.equal(status.metrics.context_occupancy_percent.value, 90);
  assert.equal(status.metrics.context_occupancy_percent.availability, 'stale');
  assert.equal(status.recommendation.state, 'insufficient_data');
  await appendFile(f.path, line(usage(95_000, 99_000, null)));
  const missing = await pollMonitor(first.state, { now: NOW });
  assert.equal(missing.status.metrics.context_occupancy_percent.availability, 'unknown');
  assert.equal(missing.status.metrics.context_occupancy_percent.value, null);
});

test('model actual is never inferred from requested model', async t => {
  const f = await fixture(t);
  await appendFile(f.path, line({ timestamp: NOW, type: 'turn_context', payload: { cwd: f.cwd, model: 'requested-model' } }));
  const { status } = await pollMonitor(f.state, { now: NOW });
  assert.equal(status.metrics.requested_model.value, 'requested-model');
  assert.equal(status.metrics.reported_model.value, null);
  assert.equal(status.metrics.reported_model.availability, 'unknown');
});

function action(id: string, snapshot: string, extra: Record<string, unknown> = {}) {
  return normalized('action', { action: 'run_test', arguments: { file: 'synthetic.spec.ts' }, result: { code: 1 }, file_snapshot: snapshot, evidence_revision: 'evidence-v1', expected_polling: false, new_evidence: false, ...extra }, id);
}
test('unchanged equivalent actions are only a repetition candidate with evidence', async t => {
  const f = await fixture(t, 'csm-jsonl-v1');
  await appendFile(f.path, [1, 2, 3].map(n => line(action(String(n), 'same-snapshot'))).join(''));
  const { status } = await pollMonitor(f.state, { now: NOW });
  assert.equal(status.recommendation.state, 'review');
  assert.match(status.recommendation.reasons.join(' '), /repetition candidate/);
  assert.equal(status.recommendation.evidence.length, 3);
});

test('changed file state, new evidence, and expected polling break repetition', async t => {
  const f = await fixture(t, 'csm-jsonl-v1');
  await appendFile(f.path, [action('1', 'a'), action('2', 'b'), action('3', 'c')].map(line).join(''));
  let result = await pollMonitor(f.state, { now: NOW });
  assert.equal(result.status.recommendation.state, 'insufficient_data');
  await appendFile(f.path, [action('4', 'c', { expected_polling: true }), action('5', 'c', { new_evidence: true }), action('6', 'c')].map(line).join(''));
  result = await pollMonitor(result.state, { now: NOW });
  assert.equal(result.status.recommendation.state, 'insufficient_data');
});

test('manual-only state supports explicit marks without inventing measurements', () => {
  const state = createMonitorState({ sessionId: SESSION, cwd: '/synthetic/workspace' });
  assert.equal(getMonitorStatus(state, { now: NOW }).recommendation.state, 'insufficient_data');
  assert.throws(() => addManualMark(state, { kind: 'constraint-violation' }), /constraintId/);
  const marked = addManualMark(state, { kind: 'constraint-violation', constraintId: 'C-1', note: 'Synthetic explicit check', eventId: 'manual-1' }, { now: NOW });
  assert.equal(marked.status.recommendation.state, 'review');
  assert.equal(marked.status.metrics.context_occupancy_percent.value, null);
  assert.equal(marked.event.source.adapter, 'manual');
  const duplicate = addManualMark(marked.state, { kind: 'constraint-violation', constraintId: 'C-1', eventId: 'manual-1' }, { now: NOW });
  assert.equal(duplicate.state.events.length, 1);
  const phase = addManualMark(state, { kind: 'phase-complete' }, { now: NOW });
  assert.equal(phase.status.recommendation.state, 'checkpoint');
});

test('supported compaction yields review, missing records do not imply zero', async t => {
  const f = await fixture(t);
  const empty = await pollMonitor(f.state, { now: NOW });
  assert.equal(empty.status.metrics.compactions.availability, 'unknown');
  await appendFile(f.path, line({ timestamp: NOW, type: 'compacted', payload: { message: 'Unstored source text' } }));
  const { state, status } = await pollMonitor(empty.state, { now: NOW });
  assert.equal(status.metrics.compactions.value, 1);
  assert.equal(status.recommendation.state, 'review');
  assert.equal(JSON.stringify(state).includes('Unstored source text'), false);
});

test('compaction invalidates earlier context pressure until a later usage event', async t => {
  const f = await fixture(t);
  await appendFile(f.path, line(usage(90_000)));
  const high = await pollMonitor(f.state, { now: NOW });
  assert.equal(high.status.recommendation.state, 'handoff_suggested');
  await appendFile(f.path, line({ timestamp: NOW, type: 'compacted', payload: {} }));
  const compacted = await pollMonitor(high.state, { now: NOW });
  assert.equal(compacted.status.metrics.context_occupancy_percent.availability, 'unknown');
  assert.equal(compacted.status.metrics.last_context_tokens.value, null);
  assert.match(compacted.status.metrics.context_occupancy_percent.missing_reason!, /predates an observed compaction/);
  assert.equal(compacted.status.metrics.cumulative_tokens.value, 9_000_000);
  assert.equal(compacted.status.recommendation.state, 'review');
  await appendFile(f.path, line(usage(40_000, 9_100_000)));
  const renewed = await pollMonitor(compacted.state, { now: NOW });
  assert.equal(renewed.status.metrics.context_occupancy_percent.value, 40);
  assert.equal(renewed.status.recommendation.state, 'continue');
});

test('a changed identity header is detected even when the file tail is unchanged', async t => {
  const f = await fixture(t);
  const suffix = line({ type: 'irrelevant', payload: 'synthetic-padding'.repeat(1000) });
  await appendFile(f.path, line(usage(90_000)) + suffix);
  const first = await pollMonitor(f.state, { now: NOW });
  await writeFile(f.path, line({ ...f.meta, payload: { id: 'synthetic-session-b', cwd: f.cwd } }) + line(usage(90_000)) + suffix);
  await assert.rejects(pollMonitor(first.state, { now: NOW }), { code: 'session_mismatch' });
});

test('malformed complete record does not block later records; incomplete record is not parsed', async t => {
  const f = await fixture(t);
  await appendFile(f.path, '{malformed}\n' + line(usage(50_000)) + '{"timestamp":');
  const { status } = await pollMonitor(f.state, { now: NOW });
  assert.equal(status.recommendation.state, 'continue');
  assert.ok(status.diagnostics.some(item => item.code === 'malformed_record'));
  assert.ok(status.pending_bytes > 0);
});

test('zero/missing window and invalid thresholds are not treated as valid ratios', async t => {
  const f = await fixture(t);
  await appendFile(f.path, line(usage(80_000, 100_000, NOW, 0)));
  const { state, status } = await pollMonitor(f.state, { now: NOW });
  assert.equal(status.metrics.context_occupancy_percent.value, null);
  assert.throws(() => getMonitorStatus(state, { rules: { checkpointPercent: 90, handoffPercent: 80 } }), /thresholds/);
});

test('obvious credential source paths are rejected before opening', async t => {
  const f = await fixture(t);
  for (const name of ['auth.json', 'credentials', 'credentials.json', '.env', '.env.local', '.npmrc', '.netrc', '.git-credentials', '.ssh/events.jsonl', '.aws/events.jsonl']) {
    assert.throws(() => createMonitorState({ sessionId: SESSION, cwd: f.cwd, sourcePath: join(f.cwd, name) }), { code: 'credential_source' });
  }
  assert.doesNotThrow(() => createMonitorState({ sessionId: SESSION, cwd: f.cwd, sourcePath: join(f.cwd, '.env.example') }));
  assert.doesNotThrow(() => createMonitorState({ sessionId: SESSION, cwd: f.cwd, sourcePath: join(f.cwd, '.codex/sessions/synthetic.jsonl') }));
  const authPath = join(f.cwd, 'auth.json');
  await writeFile(authPath, 'synthetic forbidden fixture, not credentials');
  const persisted = structuredClone(f.state);
  persisted.binding.source_path = authPath;
  await assert.rejects(pollMonitor(persisted, { now: NOW }), { code: 'credential_source' });
  const alias = join(f.cwd, 'aliased-events.jsonl');
  await symlink(authPath, alias);
  const aliased = createMonitorState({ sessionId: SESSION, cwd: f.cwd, sourcePath: alias });
  await assert.rejects(pollMonitor(aliased, { now: NOW }), { code: 'credential_source' });
});
