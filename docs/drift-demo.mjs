#!/usr/bin/env node
// Synthetic trial only: private temporary files and an explicitly registered,
// local Node check. No Codex model calls, credentials, or real session logs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = fileURLToPath(new URL('../bin/csm.mjs', import.meta.url));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-handoff-drift-demo-'));
const project = path.join(temporary, '项目 with spaces');
fs.mkdirSync(project);
fs.writeFileSync(path.join(project, 'spec.md'), 'Synthetic requirement: keep this file unchanged.\n');
fs.writeFileSync(path.join(project, 'task.txt'), 'pending\n');
const session = 'synthetic-drift-demo';
const state = path.join(temporary, 'private-state');
const command = [process.execPath, '-e', "const fs = require('node:fs'); process.exit(fs.readFileSync('task.txt', 'utf8').trim() === 'done' ? 0 : 1)"];
const baselineFile = path.join(temporary, 'baseline.json');
fs.writeFileSync(baselineFile, JSON.stringify({
  schema_version: 1, session_id: session, workspace: project,
  source: { kind: 'user', reference: 'Synthetic demo fixture; not an authenticated user request.' },
  goal: 'Synthetic task: keep spec.md unchanged and set task.txt to done.',
  constraints: [{ id: 'C1', description: 'Keep the synthetic specification unchanged.', kind: 'file-unchanged', path: 'spec.md' }],
  acceptance: [{ id: 'A1', description: 'The declared task file contains done.', command, scope_paths: ['task.txt'], max_age_seconds: 900 }],
  next_step: 'Run the synthetic check, inspect the candidate, then make the intended fixture change.',
  relevant_files: ['spec.md', 'task.txt'],
}, null, 2));

function run(name, args = [], expected = 0) {
  const result = spawnSync(process.execPath, [cli, name, '--session', session, '--cwd', project, '--state-dir', state, ...args], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
  if (result.error) throw result.error;
  assert.equal(result.status, expected, `${name}: ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout);
}
const initial = run('baseline', ['--from', baselineFile]);
assert.equal(initial.state, 'insufficient_data');
assert.equal(initial.checks[0].status, 'missing');
let repeated;
for (let index = 0; index < 3; index++) repeated = run('verify', ['--criterion-id', 'A1', '--', ...command], 3);
const loop = repeated.signals.find(signal => signal.kind === 'no-gain-loop');
assert(loop, 'Three identical failing checks on one unchanged scope should produce a candidate.');
assert.equal(loop.certainty, 'candidate');
const packet = run('review');
assert.equal(packet.purpose, 'selective-human-review');
run('feedback', ['--signal-id', loop.id, '--verdict', 'false', '--note', 'Synthetic demo: these retries were intentionally repeated to exercise the rule, not an unintended project loop.']);
fs.writeFileSync(path.join(project, 'task.txt'), 'done\n');
const finished = run('verify', ['--criterion-id', 'A1', '--', ...command]);
assert.equal(finished.verification.result, 'pass');
assert.equal(finished.state, 'continue');
assert(!finished.signals.some(signal => signal.kind === 'no-gain-loop'));
console.log(JSON.stringify({
  synthetic: true, model_calls: 0, temporary_directory: temporary,
  baseline: initial.state,
  repeated_failed_checks: { state: repeated.state, signal: loop.kind, certainty: loop.certainty },
  selective_review: { signals: packet.signals.length, evidence: packet.evidence.length },
  after_intended_change: { state: finished.state, verification: finished.verification.result },
  feedback_summary: finished.feedback_summary,
  note: 'Only declared synthetic files were checked. This does not establish real-project accuracy. Temporary files are retained for inspection.',
}, null, 2));
