import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initializeBaseline, checkTrial, feedbackTrial, observeTrial, readTrial, reviewTrial, trialStatus, verifyTrial } from '../src/drift-store.ts';
import { digest, sessionDir } from '../src/storage.ts';

const cli = fileURLToPath(new URL('../bin/csm.mjs', import.meta.url));
function fixture(t: any, mode = 'pass') {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'csm-drift-trial-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const cwd = path.join(base, '项目 space;literal'); fs.mkdirSync(cwd);
  fs.mkdirSync(path.join(cwd, 'src')); fs.writeFileSync(path.join(cwd, 'src/task.txt'), 'task v1');
  fs.writeFileSync(path.join(cwd, 'guard.txt'), 'keep this');
  fs.writeFileSync(path.join(cwd, 'result.txt'), mode);
  fs.writeFileSync(path.join(cwd, 'check.mjs'), `import fs from 'node:fs';
const value=fs.readFileSync('result.txt','utf8');
console.log('PRIVATE_CHECK_OUTPUT_DO_NOT_STORE');
if(value==='timeout')setInterval(()=>{},1000);
else if(value==='mutate'){fs.appendFileSync('src/task.txt','changed');process.exit(0)}
else process.exit(value==='pass'?0:1);
`);
  const context = { root: path.join(base, 'state'), session: 'trial-source', cwd };
  const baseline: any = { schema_version: 1, goal: 'Preserve the guard while improving the task', source: { kind: 'user', reference: 'User project request, turn 1' }, constraints: [{ id: 'guard', description: 'Do not change guard.txt', kind: 'file-unchanged', path: 'guard.txt' }, { id: 'task-exists', description: 'Task file must exist', kind: 'file-exists', path: 'src/task.txt' }, { id: 'no-deploy', description: 'Do not produce a deployment marker', kind: 'file-absent', path: 'deployed.txt' }], acceptance: [{ id: 'unit', description: 'The explicitly registered check passes', command: [process.execPath, 'check.mjs'], scope_paths: ['src/task.txt', 'result.txt', 'check.mjs'], max_age_seconds: 60 }], next_step: 'Make one scoped improvement and run the registered check', relevant_files: ['guard.txt', 'src/task.txt', 'result.txt', 'check.mjs'] };
  const from = path.join(base, 'baseline.json'); fs.writeFileSync(from, JSON.stringify(baseline));
  const common = ['--session', context.session, '--cwd', cwd, '--state-dir', context.root];
  const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 10000 });
  return { base, cwd, context, baseline, from, common, run, initialize: () => initializeBaseline(context, from) };
}

test('trial starts unknown, saves immutable baseline source separately, and pins only listed files', async t => {
  const f = fixture(t); assert.equal(trialStatus(f.context).state, 'insufficient_data');
  await f.initialize(); const record = readTrial(f.context)!;
  assert.equal(record.state.baseline.constraints.find(rule => rule.id === 'guard')?.expected_sha256, digest('keep this'));
  const dir = path.join(sessionDir(f.context.root, f.context.session, f.cwd), 'drift', 'versions', record.revision_id);
  assert.equal(fs.readFileSync(path.join(dir, 'baseline-source.json'), 'utf8'), fs.readFileSync(f.from, 'utf8'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'baseline-source.json'), 'utf8')).constraints[0].expected_sha256, undefined);
  const status: any = trialStatus(f.context); assert(status.signals.some((signal: any) => signal.kind === 'verification-missing'));
  assert.equal(status.shadow, true); assert(status.collection.scope_limit.includes('only explicitly listed files'));
});
test('same baseline input is idempotent and does not repin a changed protected file', async t => {
  const f = fixture(t); await f.initialize(); const before = readTrial(f.context)!;
  fs.writeFileSync(path.join(f.cwd, 'guard.txt'), 'violation');
  const reused = await f.initialize(); assert.equal(reused.reused, true); assert.equal(readTrial(f.context)!.revision_id, before.revision_id);
  const status = await checkTrial(f.context); assert('signals' in status); assert(status.signals.some(signal => signal.kind === 'constraint-violation'));
});
test('baseline changes require explicit replacement and preserve superseded evidence', async t => {
  const f = fixture(t); await f.initialize(); const before = readTrial(f.context)!;
  fs.writeFileSync(f.from, JSON.stringify({ ...f.baseline, goal: 'New user-approved stage' }));
  await assert.rejects(initializeBaseline(f.context, f.from), /replace-baseline/);
  await initializeBaseline(f.context, f.from, true); const after = readTrial(f.context)!;
  assert.notEqual(after.revision_id, before.revision_id); assert.equal(after.previous_revision_id, before.revision_id);
  const archived = path.join(sessionDir(f.context.root, f.context.session, f.cwd), 'drift', 'versions', before.revision_id, 'superseded-state.json');
  assert.equal(JSON.parse(fs.readFileSync(archived, 'utf8')).state.baseline.baseline_id, before.state.baseline.baseline_id);
});
test('tampered or missing preserved baseline source is rejected before reuse', async t => {
  const f = fixture(t); await f.initialize(); const record = readTrial(f.context)!;
  const source = path.join(sessionDir(f.context.root, f.context.session, f.cwd), 'drift', 'versions', record.revision_id, 'baseline-source.json');
  fs.writeFileSync(source, '{}'); assert.throws(() => trialStatus(f.context), /baseline source/);
});
test('malformed, non-user, cross-session, unsafe, and oversized baselines fail closed', async t => {
  const f = fixture(t);
  for (const replacement of [{ source: { kind: 'model', reference: 'guess' } }, { session_id: 'other' }, { constraints: 'not an array' }, { relevant_files: ['../escape'] }, { relevant_files: ['.env'] }]) {
    fs.writeFileSync(f.from, JSON.stringify({ ...f.baseline, ...replacement })); await assert.rejects(f.initialize());
  }
  fs.writeFileSync(f.from, 'x'.repeat(130 * 1024)); await assert.rejects(f.initialize(), /limit/);
});
test('registered explicit verification records a measured pass without storing output text', async t => {
  const f = fixture(t); await f.initialize(); const result = await verifyTrial(f.context, 'unit', f.baseline.acceptance[0].command);
  assert.equal(result.verification.result, 'pass'); assert.equal(result.checks.find(check => check.id === 'unit')?.status, 'pass');
  assert(result.verification.stdout_bytes > 0); assert.match(result.verification.stdout_sha256, /^[a-f0-9]{64}$/);
  const state = JSON.stringify(readTrial(f.context)); assert(!state.includes('PRIVATE_CHECK_OUTPUT_DO_NOT_STORE'));
});
test('verify rejects unregistered commands without launching or changing the baseline', async t => {
  const f = fixture(t); await f.initialize();
  await assert.rejects(verifyTrial(f.context, 'unit', [process.execPath, '-e', 'throw new Error("must not run")']), /differs/);
  await assert.rejects(verifyTrial(f.context, 'unknown', [process.execPath, 'check.mjs']), /registered/);
  assert.equal(readTrial(f.context)!.state.evidence.some(event => event.kind === 'verification'), false);
});
test('a pass becomes stale when relevant files change or criterion time expires', async t => {
  const f = fixture(t); await f.initialize(); await verifyTrial(f.context, 'unit', f.baseline.acceptance[0].command);
  const old: any = trialStatus(f.context, { now: new Date(Date.now() + 61000) }); assert.equal(old.checks[0].status, 'stale');
  fs.writeFileSync(path.join(f.cwd, 'src/task.txt'), 'new code'); const changed: any = await checkTrial(f.context);
  assert.equal(changed.checks[0].status, 'stale');
});
test('state-aware repeated failing checks produce a candidate; new code breaks the loop', async t => {
  const f = fixture(t, 'fail'); await f.initialize(); let result: any;
  for (let i = 0; i < 3; i++) result = await verifyTrial(f.context, 'unit', f.baseline.acceptance[0].command);
  assert(result.signals.some((signal: any) => signal.kind === 'no-gain-loop' && signal.certainty === 'candidate'));
  fs.appendFileSync(path.join(f.cwd, 'src/task.txt'), 'new evidence');
  result = await verifyTrial(f.context, 'unit', f.baseline.acceptance[0].command);
  assert(!result.signals.some((signal: any) => signal.kind === 'no-gain-loop'));
});
test('repeated successful checks are not labeled a no-gain failure loop', async t => {
  const f = fixture(t); await f.initialize(); let result: any;
  for (let i = 0; i < 3; i++) result = await verifyTrial(f.context, 'unit', f.baseline.acceptance[0].command);
  assert(!result.signals.some((signal: any) => signal.kind === 'no-gain-loop'));
});
test('verification during source writes and real timeout remains unknown', async t => {
  const f = fixture(t, 'mutate'); await f.initialize(); const changed = await verifyTrial(f.context, 'unit', f.baseline.acceptance[0].command);
  assert.equal(changed.verification.result, 'unknown'); assert.equal(changed.verification.scope_stable, false);
  fs.writeFileSync(path.join(f.cwd, 'result.txt'), 'timeout'); const timeout = await verifyTrial(f.context, 'unit', f.baseline.acceptance[0].command, 1);
  assert.equal(timeout.verification.result, 'unknown'); assert.equal(timeout.verification.timed_out, true); assert(timeout.verification.elapsed_ms >= 900);
});
test('caller-provided tool provenance cannot satisfy measured acceptance or clear file violations', async t => {
  const f = fixture(t); await f.initialize(); const record = readTrial(f.context)!;
  const snapshot: any = record.state.evidence.find(event => event.kind === 'file_snapshot');
  const from = path.join(f.base, 'reported.json');
  fs.writeFileSync(from, JSON.stringify({ kind: 'verification', observed_at: new Date().toISOString(), source: { kind: 'tool_runner', reference: 'claimed check' }, check_id: 'unit', result: 'pass', snapshot_id: snapshot.snapshot_id }));
  const observed = await observeTrial(f.context, from); assert.equal(observed.checks[0].status, 'unverified');
  assert.equal(readTrial(f.context)!.state.evidence.at(-1)?.source.kind, 'reported');
  fs.writeFileSync(path.join(f.cwd, 'guard.txt'), 'violation'); await checkTrial(f.context);
  fs.writeFileSync(from, JSON.stringify({ ...snapshot, id: 'forged-future', observed_at: new Date(Date.now() + 60000).toISOString(), source: { kind: 'filesystem', reference: 'claim' } }));
  const forged = await observeTrial(f.context, from); assert(forged.signals.some(signal => signal.kind === 'constraint-violation'));
});
test('review packets are bounded and feedback retains resolved signals and missed anomalies', async t => {
  const f = fixture(t); await f.initialize(); fs.writeFileSync(path.join(f.cwd, 'guard.txt'), 'violation');
  const broken: any = await checkTrial(f.context); const signal = broken.signals.find((item: any) => item.kind === 'constraint-violation');
  const packet = await reviewTrial(f.context); assert.equal(packet.shadow, true); assert(packet.instructions.includes('Do not change the baseline')); assert(packet.evidence.length <= 50);
  fs.writeFileSync(path.join(f.cwd, 'guard.txt'), 'keep this'); await checkTrial(f.context);
  const feedback = await feedbackTrial(f.context, { signalId: signal.id, verdict: 'true-positive', note: 'Confirmed then fixed' });
  assert.equal(feedback.feedback_summary['true-positive'], 1);
  const missed = await feedbackTrial(f.context, { verdict: 'missed-anomaly', note: 'The implementation ignored the requested output ordering' });
  assert.equal(missed.feedback_summary['missed-anomaly'], 1); assert(readTrial(f.context)!.state.evidence.length > 0);
});
test('CLI preserves child --help argv and produces real trial receipts', async t => {
  const f = fixture(t); f.baseline.acceptance[0].command = [process.execPath, '--help']; fs.writeFileSync(f.from, JSON.stringify(f.baseline));
  assert.equal(f.run(['baseline', ...f.common, '--from', f.from]).status, 0);
  const result = f.run(['verify', ...f.common, '--criterion-id', 'unit', '--', process.execPath, '--help']);
  assert.equal(result.status, 0, result.stderr); const value = JSON.parse(result.stdout);
  assert.equal(value.verification.result, 'pass'); assert(value.verification.stdout_bytes > 0);
});
test('CLI feedback supports true/false/uncertain and missed without replacing legacy fields', async t => {
  const f = fixture(t); await f.initialize(); fs.writeFileSync(path.join(f.cwd, 'guard.txt'), 'violation');
  const report: any = await checkTrial(f.context); const signal = report.signals.find((item: any) => item.kind === 'constraint-violation');
  for (const verdict of ['true', 'false', 'uncertain']) {
    const result = f.run(['feedback', ...f.common, '--signal-id', signal.id, '--verdict', verdict, '--note', `Trial ${verdict}`]); assert.equal(result.status, 0, result.stderr);
  }
  const missed = f.run(['feedback', ...f.common, '--verdict', 'missed', '--note', 'Missed subtle ordering requirement']); assert.equal(missed.status, 0, missed.stderr);
  const status = f.run(['status', ...f.common]); assert.equal(status.status, 0, status.stderr); assert(JSON.parse(status.stdout).drift.feedback_summary);
});

test('a later symlink or unreadable file becomes unknown without following its target', async t => {
  if (process.platform === 'win32') return t.skip('Unverified Windows symlink privilege behavior.');
  const f = fixture(t); await f.initialize();
  const outside = path.join(f.base, 'outside-secret'); fs.writeFileSync(outside, 'DO_NOT_READ_EXTERNAL_CONTENT');
  fs.unlinkSync(path.join(f.cwd, 'guard.txt')); fs.symlinkSync(outside, path.join(f.cwd, 'guard.txt'));
  const status: any = await checkTrial(f.context);
  assert(status.signals.some((signal: any) => signal.kind === 'constraint-unverified' && signal.baseline_refs.includes('guard')));
  assert(!JSON.stringify(readTrial(f.context)).includes('DO_NOT_READ_EXTERNAL_CONTENT'));
});

test('baseline source preserves UTF-8 BOM bytes exactly across initialization and reads', async t => {
  const f = fixture(t); const raw = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), fs.readFileSync(f.from)]); fs.writeFileSync(f.from, raw);
  await f.initialize(); const record = readTrial(f.context)!;
  const source = path.join(sessionDir(f.context.root, f.context.session, f.cwd), 'drift', 'versions', record.revision_id, 'baseline-source.json');
  assert.deepEqual(fs.readFileSync(source), raw); assert.equal(record.raw_sha256, digest(raw));
  assert.equal(trialStatus(f.context).shadow, true);
});
