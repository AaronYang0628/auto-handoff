import test from 'node:test';
import assert from 'node:assert/strict';
import { addDriftEvidence, addDriftFeedback, createDriftState, createReviewPacket, evaluateDrift, hashCommand, recordDriftAssessment, validateBaseline } from '../src/drift.ts';
import type { DriftState } from '../src/drift.ts';

const NOW = '2026-10-02T12:00:00.000Z';
const AT = (seconds: number) => new Date(Date.parse(NOW) + seconds * 1000).toISOString();
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const COMMAND = ['node', '--test', 'test.mjs'];
const SOURCE = { kind: 'filesystem', reference: 'Synthetic selected-file snapshot', epoch: 'baseline-epoch-1' };
const FILE = 'src/main.ts';
function baseline(extra: Record<string, unknown> = {}) {
  return validateBaseline({ schema_version: 1, source: { kind: 'user', reference: 'Synthetic user supplied baseline' }, goal: 'Preserve behavior while fixing one bug', constraints: [], acceptance: [{ id: 'unit', description: 'Registered unit test command succeeds', command: COMMAND, scope_paths: [FILE] }], relevant_files: [FILE], next_step: 'Run the registered test', ...extra }, { sessionId: 'synthetic-session', cwd: '/synthetic/project', now: NOW });
}
function fresh(extra: Record<string, unknown> = {}) { return createDriftState(baseline(extra)); }
function snapshot(state: DriftState, id = 'snapshot-a', at = NOW, files: unknown[] = [{ path: FILE, status: 'present', sha256: HASH_A }], source = SOURCE) {
  return addDriftEvidence(state, { kind: 'file_snapshot', snapshot_id: id, files, observed_at: at, source });
}
function verification(state: DriftState, result = 'pass', extra: Record<string, unknown> = {}) {
  return addDriftEvidence(state, { kind: 'verification', check_id: 'unit', result, snapshot_id: 'snapshot-a', command_hash: hashCommand(COMMAND), observed_at: NOW, source: { ...SOURCE, kind: 'tool_runner' }, ...extra });
}
function action(state: DriftState, sequence: number, extra: Record<string, unknown> = {}) {
  return addDriftEvidence(state, { kind: 'action', action_hash: HASH_A, result_hash: HASH_B, before_snapshot_id: 'snapshot-a', after_snapshot_id: 'snapshot-a', evidence_revision: 'known-evidence-a', outcome: 'failure', expected_polling: false, new_evidence: false, observed_at: AT(sequence), source: { ...SOURCE, kind: 'tool_runner' }, ...extra });
}
const hasLoop = (state: DriftState) => evaluateDrift(state, { now: AT(10) }).signals.some(signal => signal.kind === 'no-gain-loop');

test('baseline identity is stable, bound to scope, and independent of creation time', () => {
  const a = baseline();
  const b = validateBaseline({ ...a, created_at: AT(10) }, { sessionId: a.session_id, cwd: a.workspace });
  assert.equal(a.baseline_id, b.baseline_id);
  assert.notEqual(a.baseline_id, baseline({ goal: 'A user-approved changed goal' }).baseline_id);
  assert.throws(() => createDriftState({ ...a, goal: 'Silently rewritten by an agent' }), /immutable contents/);
  assert.throws(() => validateBaseline(a, { sessionId: 'another-session', cwd: a.workspace }), /mismatch/);
  assert.throws(() => baseline({ source: { kind: 'model', reference: 'Agent interpretation' } }), /user baseline/);
});

test('only explicit safe relative paths and unique rules are accepted', () => {
  for (const path of ['../outside', '/absolute', '.aws/config', '.env', '.git/config']) assert.throws(() => baseline({ relevant_files: [path] }));
  assert.throws(() => baseline({ constraints: [{ id: 'C1', kind: 'file-unchanged', path: FILE, description: 'Keep file' }] }), /Expected file hash/);
  assert.throws(() => baseline({ constraints: [{ id: 'unit', kind: 'manual', description: 'Duplicate ID' }] }), /duplicate/);
});

test('baseline state and evidence updates are immutable and never preserve unknown raw fields', () => {
  const original = fresh();
  const updated = addDriftEvidence(original, { kind: 'file_snapshot', snapshot_id: 'a', observed_at: NOW, source: SOURCE, files: [{ path: FILE, status: 'present', sha256: HASH_A }], raw_chat: 'synthetic private text' });
  assert.equal(original.evidence.length, 0);
  assert.equal(updated.evidence.length, 1);
  assert.equal(JSON.stringify(updated).includes('synthetic private text'), false);
  assert.deepEqual(updated.baseline, original.baseline);
});

test('evidence identity mismatches and reused evidence IDs with changed content are rejected', () => {
  const state = fresh();
  const evidence = { id: 'same-id', kind: 'manual', observation: 'drift', note: 'Synthetic issue', observed_at: NOW, source: { ...SOURCE, kind: 'reported' } };
  assert.throws(() => addDriftEvidence(state, { ...evidence, session_id: 'foreign' }), /identity/);
  const first = addDriftEvidence(state, evidence);
  assert.equal(addDriftEvidence(first, evidence).evidence.length, 1);
  assert.throws(() => addDriftEvidence(first, { ...evidence, note: 'Different issue' }), /reused/);
});

test('missing verification is unknown, never evidence that work is correct', () => {
  const report = evaluateDrift(fresh(), { now: NOW });
  assert.equal(report.state, 'insufficient_data');
  assert.equal(report.checks[0].status, 'missing');
  assert.ok(report.signals.some(signal => signal.kind === 'verification-missing'));
  assert.equal(report.shadow, true);
});

test('registered measured command can pass on a fresh matching complete snapshot', () => {
  const report = evaluateDrift(verification(snapshot(fresh())), { now: NOW });
  assert.equal(report.state, 'continue');
  assert.equal(report.checks[0].status, 'pass');
  assert.equal(report.capabilities.verification, 'measured');
});

test('arbitrary exit zero or a reported pass cannot satisfy registered acceptance', () => {
  const state = snapshot(fresh());
  const reported = verification(state, 'pass', { source: { ...SOURCE, kind: 'reported' } });
  assert.equal(evaluateDrift(reported, { now: NOW }).checks[0].status, 'unverified');
  const wrongCommand = verification(state, 'pass', { command_hash: hashCommand(['true']) });
  assert.equal(evaluateDrift(wrongCommand, { now: NOW }).checks[0].status, 'unverified');
  const noCommand = verification(snapshot(fresh({ acceptance: [{ id: 'unit', description: 'Unregistered semantic claim' }] })));
  assert.equal(evaluateDrift(noCommand, { now: NOW }).checks[0].status, 'unverified');
});

test('latest failed check supersedes an earlier pass and old late-arriving records do not supersede it', () => {
  let state = verification(snapshot(fresh()), 'pass');
  state = verification(state, 'fail', { observed_at: AT(2) });
  state = verification(state, 'pass', { observed_at: AT(-1) });
  const report = evaluateDrift(state, { now: AT(3) });
  assert.equal(report.checks[0].status, 'fail');
  assert.equal(report.state, 'review');
  assert.ok(report.signals.some(signal => signal.kind === 'verification-failed' && signal.certainty === 'observed'));
});

test('a file edit invalidates an earlier pass and source-epoch changes also invalidate it', () => {
  let state = verification(snapshot(fresh()));
  state = snapshot(state, 'snapshot-b', AT(1), [{ path: FILE, status: 'present', sha256: HASH_B }]);
  assert.equal(evaluateDrift(state, { now: AT(2) }).checks[0].status, 'stale');
  state = snapshot(state, 'snapshot-a', AT(3), undefined, { ...SOURCE, epoch: 'new-epoch' });
  assert.equal(evaluateDrift(state, { now: AT(4) }).checks[0].status, 'stale');
});

test('observing an old check now does not refresh its measurement timestamp', () => {
  let state = snapshot(fresh(), 'snapshot-a', AT(1000));
  state = verification(state, 'pass', { observed_at: NOW });
  assert.equal(evaluateDrift(state, { now: AT(1000) }).checks[0].status, 'stale');
});

test('criterion-specific freshness and incomplete file coverage remain unknown', () => {
  let state = snapshot(fresh({ acceptance: [{ id: 'unit', description: 'Very recent test', command: COMMAND, max_age_seconds: 5 }] }));
  state = verification(state);
  assert.equal(evaluateDrift(state, { now: AT(10) }).checks[0].status, 'stale');
  const missingScope = verification(snapshot(fresh(), 'snapshot-a', NOW, []));
  assert.equal(evaluateDrift(missingScope, { now: NOW }).checks[0].status, 'stale');
});

test('explicit file constraints are deterministic while unlisted paths remain outside coverage', () => {
  const state = snapshot(fresh({ constraints: [{ id: 'C1', description: 'Do not edit this file', kind: 'file-unchanged', path: FILE, expected_sha256: HASH_B }] }));
  const report = evaluateDrift(state, { now: NOW });
  const violation = report.signals.find(signal => signal.kind === 'constraint-violation')!;
  assert.equal(violation.certainty, 'observed');
  assert.deepEqual(violation.baseline_refs, ['C1']);
  assert.equal(report.state, 'review');
});

test('absent/existing constraints distinguish missing files from unreadable files', () => {
  const state = snapshot(fresh({ constraints: [{ id: 'must-exist', description: 'Required file', kind: 'file-exists', path: FILE }, { id: 'must-absent', description: 'No generated secret', kind: 'file-absent', path: 'artifact.txt' }] }), 'snapshot-a', NOW, [{ path: FILE, status: 'missing' }, { path: 'artifact.txt', status: 'unreadable' }]);
  const report = evaluateDrift(state, { now: NOW });
  assert.ok(report.signals.some(signal => signal.kind === 'constraint-violation' && signal.baseline_refs.includes('must-exist')));
  assert.ok(report.signals.some(signal => signal.kind === 'constraint-unverified' && signal.baseline_refs.includes('must-absent')));
});

test('manual semantic constraints remain explicitly uncovered even with a passing check', () => {
  const state = verification(snapshot(fresh({ constraints: [{ id: 'tone', description: 'Preserve the user intent and writing tone', kind: 'manual' }] })));
  const report = evaluateDrift(state, { now: NOW });
  assert.equal(report.state, 'insufficient_data');
  assert.ok(report.signals.some(signal => signal.kind === 'constraint-unverified' && signal.baseline_refs.includes('tone')));
});

test('three equivalent failing actions are only a state-linked no-gain candidate', () => {
  let state = snapshot(fresh());
  for (let i = 1; i <= 3; i++) state = action(state, i);
  const report = evaluateDrift(state, { now: AT(4) });
  const candidate = report.signals.find(signal => signal.kind === 'no-gain-loop')!;
  assert.equal(candidate.certainty, 'candidate');
  assert.equal(candidate.evidence_ids.length, 3);
  assert.equal(report.capabilities.state_linked_actions, 'available');
});

test('missing captured snapshots and before/after state changes cannot produce a loop', () => {
  let missing = fresh();
  let changed = snapshot(fresh());
  for (let i = 1; i <= 3; i++) {
    missing = action(missing, i);
    changed = action(changed, i, { before_snapshot_id: 'earlier-snapshot' });
  }
  assert.equal(hasLoop(missing), false);
  assert.equal(hasLoop(changed), false);
});

test('reported linkage cannot impersonate an instrumented no-gain loop', () => {
  let state = snapshot(fresh());
  for (let i = 1; i <= 3; i++) state = action(state, i, { source: { ...SOURCE, kind: 'reported' } });
  assert.equal(hasLoop(state), false);
  assert.equal(evaluateDrift(state, { now: AT(4) }).capabilities.state_linked_actions, 'unknown');
});

test('new evidence, changed result, expected polling, success and unknown outcomes break loops', () => {
  for (const difference of [{ new_evidence: true }, { expected_polling: true }, { result_hash: HASH_A }, { evidence_revision: 'new-evidence' }, { outcome: 'success' }, { outcome: 'unknown' }]) {
    let state = action(action(snapshot(fresh()), 1), 2);
    state = action(state, 3, difference);
    assert.equal(hasLoop(state), false, JSON.stringify(difference));
  }
});

test('intervening meaningful non-action evidence breaks no-gain runs', () => {
  let state = action(action(snapshot(fresh()), 1), 2);
  state = addDriftEvidence(state, { kind: 'manual', observation: 'progress', note: 'New diagnosis verified', observed_at: AT(2.5), source: { ...SOURCE, kind: 'reported' } });
  state = action(state, 3);
  assert.equal(hasLoop(state), false);
});

test('wrong-command or reported passing verification does not hide a genuine no-gain candidate', () => {
  for (const extra of [{ command_hash: hashCommand(['true']) }, { source: { ...SOURCE, kind: 'reported' } }, { source: { ...SOURCE, kind: 'tool_runner', epoch: 'wrong-epoch' } }]) {
    let state = action(action(snapshot(fresh()), 1), 2);
    state = verification(state, 'pass', { observed_at: AT(2.5), ...extra });
    state = action(state, 3);
    assert.equal(hasLoop(state), true);
  }
});

test('out-of-order action ingestion respects measurement order', () => {
  let state = snapshot(fresh());
  state = action(state, 1);
  state = action(state, 4, { outcome: 'success' });
  state = action(state, 2);
  state = action(state, 3);
  assert.equal(hasLoop(state), false);
});

test('unchanged snapshot refresh keeps alert identity while evidence references advance', () => {
  const extra = { constraints: [{ id: 'C1', description: 'Keep file unchanged', kind: 'file-unchanged', path: FILE, expected_sha256: HASH_B }] };
  let state = snapshot(fresh(extra));
  const first = evaluateDrift(state, { now: NOW }).signals.find(signal => signal.kind === 'constraint-violation')!;
  state = snapshot(state, 'snapshot-a', AT(30));
  const second = evaluateDrift(state, { now: AT(30) }).signals.find(signal => signal.kind === 'constraint-violation')!;
  assert.equal(first.id, second.id);
  assert.notDeepEqual(first.evidence_ids, second.evidence_ids);
});

test('review packet prioritizes review findings and discloses trimmed signals', () => {
  let state = fresh({ constraints: Array.from({ length: 20 }, (_, index) => ({ id: `C${index}`, description: 'Explicit but unverified', kind: 'manual' })) });
  state = snapshot(state);
  state = verification(state, 'fail');
  const packet = createReviewPacket(state, { now: NOW });
  assert.equal(packet.signals.length, 12);
  assert.equal(packet.signals[0].kind, 'verification-failed');
  assert.ok(packet.omitted_signal_count > 0);
  assert.ok(packet.evidence.length <= 20);
  assert.ok(packet.baseline.acceptance.some(check => check.id === 'unit'));
  assert.ok(packet.baseline.constraints.length < 20);
});

test('review packet only includes implicated file metadata without mutating retained evidence', () => {
  const state = snapshot(fresh({ constraints: [{ id: 'keep', description: 'Keep selected file', kind: 'file-unchanged', path: FILE, expected_sha256: HASH_B }] }), 'snapshot-a', NOW, [{ path: FILE, status: 'present', sha256: HASH_A }, { path: 'irrelevant-private-file.ts', status: 'present', sha256: HASH_B }]);
  const packet = createReviewPacket(state, { now: NOW });
  assert.equal(packet.omitted_file_observations, 1);
  assert.equal(JSON.stringify(packet).includes('irrelevant-private-file.ts'), false);
  assert.equal((state.evidence[0] as any).files.length, 2);
});

test('feedback stays auditable after an alert resolves and never erases evidence', () => {
  let state = verification(snapshot(fresh()), 'fail');
  const recorded = recordDriftAssessment(state, { now: NOW });
  const signal = recorded.report.signals.find(signal => signal.kind === 'verification-failed')!;
  state = verification(recorded.state, 'pass', { observed_at: AT(1) });
  const before = state.evidence.length;
  state = addDriftFeedback(state, { signalId: signal.id, verdict: 'false-positive', note: 'The failing fixture was expected', observedAt: AT(2) });
  state = addDriftFeedback(state, { verdict: 'missed-anomaly', note: 'An unlisted UI regression was missed', observedAt: AT(3) });
  assert.equal(state.evidence.length, before);
  assert.equal(state.feedback.length, 2);
  assert.equal(state.feedback[0].signal_id, signal.id);
  assert.equal(state.feedback[1].signal_id, null);
  assert.equal(evaluateDrift(state, { now: AT(3) }).feedback_summary['missed-anomaly'], 1);
  assert.throws(() => addDriftFeedback(state, { signalId: 'foreign-signal', verdict: 'true-positive', note: 'Bad reference', observedAt: AT(3) }), /not present/);
});

test('signals bind baseline revision and workspace, not only repeated symptoms', () => {
  const state = verification(snapshot(fresh()), 'fail');
  const other = verification(snapshot(fresh({ goal: 'A revised user goal' })), 'fail');
  assert.notEqual(evaluateDrift(state, { now: NOW }).signals[0].id, evaluateDrift(other, { now: NOW }).signals[0].id);
});
