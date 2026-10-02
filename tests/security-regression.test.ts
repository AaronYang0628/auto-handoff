import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createCheckpoint, loadLatestPacket } from '../src/handoff.ts';
import { handoff } from '../src/launcher.ts';
import type { Operation } from '../src/launcher.ts';
import { installSkill, uninstallSkill } from '../src/installer.ts';
import { atomicWrite, codexHome, privateDir, sessionDir } from '../src/storage.ts';
import { safeFile, snapshot } from '../src/snapshot.ts';

function fixture(t: { after: (fn: () => void) => void }) {
  // Canonicalize the OS temp root itself: macOS often exposes /var via a symlink.
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'csm-security-test-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const cwd = path.join(base, 'project'), root = path.join(base, 'state');
  fs.mkdirSync(cwd);
  const checkpoint = {
    schema_version: 1, session_id: 'synthetic-source', cwd, goal: 'Synthetic review task',
    constraints: [], acceptance: [], decisions: [], rejected_approaches: [], todos: [], blockers: [],
    important_files: ['task.txt'], next_step: 'Inspect the synthetic task', ongoing_operations: [], writers_stopped: true,
  };
  fs.writeFileSync(path.join(cwd, 'task.txt'), 'original synthetic content\n');
  const input = path.join(base, 'checkpoint-input.json');
  fs.writeFileSync(input, JSON.stringify(checkpoint));
  return { base, cwd, root, checkpoint, input };
}

const symlinkOptions = { skip: process.platform === 'win32' ? 'Windows symlink privileges are not guaranteed in this unverified platform.' : false };

test('private packet creation rejects a symlink state ancestor', symlinkOptions, t => {
  const f = fixture(t);
  const outside = path.join(f.base, 'unrelated'); fs.mkdirSync(outside);
  const link = path.join(f.base, 'state-link'); fs.symlinkSync(outside, link, 'dir');
  assert.throws(() => createCheckpoint(path.join(link, 'nested-state'), f.checkpoint.session_id, f.cwd, f.input));
  assert.deepEqual(fs.readdirSync(outside), [], 'no packet or directory may be written through the symlink');
});

test('an absent important file may not escape through a symlink ancestor', symlinkOptions, t => {
  const f = fixture(t);
  const outside = path.join(f.base, 'unrelated'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.cwd, 'linked'), 'dir');
  assert.throws(() => safeFile(f.cwd, 'linked/absent.txt'));
});

test('uninstall rejects a symlinked skill directory before deleting anything', symlinkOptions, t => {
  const f = fixture(t);
  const outside = path.join(f.base, 'unrelated-skill'); fs.mkdirSync(outside);
  const marker = path.join(outside, '.auto-handoff-install.json');
  fs.writeFileSync(marker, JSON.stringify({ schema_version: 1, name: 'auto-handoff', files: {} }));
  const extra = path.join(outside, 'unmanaged-empty'); fs.mkdirSync(extra);
  const skills = path.join(f.cwd, '.agents', 'skills'); fs.mkdirSync(skills, { recursive: true });
  fs.symlinkSync(outside, path.join(skills, 'auto-handoff'), 'dir');
  assert.throws(() => uninstallSkill('project', f.cwd));
  assert.equal(fs.existsSync(marker), true, 'an external marker must not be deleted');
  assert.equal(fs.existsSync(extra), true, 'unmanaged external directories must be preserved');
});

test('uninstall preserves unmanaged empty directories inside a managed skill', t => {
  const f = fixture(t);
  installSkill('project', f.cwd);
  const extra = path.join(f.cwd, '.agents', 'skills', 'auto-handoff', 'user-empty-directory');
  fs.mkdirSync(extra);
  uninstallSkill('project', f.cwd);
  assert.equal(fs.existsSync(extra), true, 'only known installer-created paths may be pruned');
});

test('snapshot retains an important file literally named __proto__', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.cwd, '__proto__'), 'synthetic prototype-named file\n');
  const result = snapshot(f.cwd, ['__proto__']);
  const serialized = JSON.parse(JSON.stringify(result));
  assert.deepEqual(Object.keys(serialized.files), ['__proto__']);
  assert.equal(serialized.files.__proto__.exists, true);
  assert.match(serialized.files.__proto__.sha256, /^[0-9a-f]{64}$/);
});

function recordReadyOperation(f: ReturnType<typeof fixture>) {
  const prepared = createCheckpoint(f.root, f.checkpoint.session_id, f.cwd, f.input);
  const { packet, manifest } = loadLatestPacket(f.root, f.checkpoint.session_id, f.cwd);
  const operationId = prepared.checkpoint_id;
  const dir = sessionDir(f.root, f.checkpoint.session_id, f.cwd);
  const operationDir = path.join(dir, 'operations', operationId); privateDir(operationDir);
  const operation: Operation = {
    schema_version: 1, operation_id: operationId, state: 'ready', created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    source_session_id: f.checkpoint.session_id, target_session_id: 'synthetic-created-thread', profile: 'synthetic-profile',
    cwd: f.cwd, codex_home: codexHome(), codex_executable: path.join(f.base, 'not-a-real-codex-executable'),
    packet, packet_sha256: manifest.packet_sha256, launch_count: 1,
    report_path: path.join(operationDir, 'init-report.json'), elapsed_ms: 10, exit_code: 0,
    init_report: {
      schema_version: 1, operation_id: operationId, packet_sha256: manifest.packet_sha256, received_constraint_ids: [],
      verified_files: [{ path: 'task.txt', sha256: (manifest.snapshot.files['task.txt'] as { sha256: string }).sha256 }],
      next_step: 'Inspect the synthetic task', ready: true, blockers: [],
    },
  };
  atomicWrite(operation.report_path, operation.init_report);
  atomicWrite(path.join(operationDir, 'operation.json'), operation);
  atomicWrite(path.join(dir, 'operation-current.json'), operation);
  return operation;
}

test('an existing operation remains recoverable after the workspace changes', async t => {
  const f = fixture(t), operation = recordReadyOperation(f);
  fs.writeFileSync(path.join(f.cwd, 'task.txt'), 'subsequent synthetic edits\n');
  const result = await handoff({ root: f.root, session: operation.source_session_id, cwd: f.cwd, profile: operation.profile, operationId: operation.operation_id, executable: operation.codex_executable });
  assert.equal(result.target_session_id, operation.target_session_id);
  assert.equal(result.launch_count, 1);
  assert.ok('reused' in result);
  assert.equal(result.reused, true);
  assert.match(String(result.resume_command), /synthetic-created-thread/);
});

test('an existing operation remains recoverable after a newer checkpoint', async t => {
  const f = fixture(t), operation = recordReadyOperation(f);
  fs.writeFileSync(f.input, JSON.stringify({ ...f.checkpoint, goal: 'Later synthetic checkpoint' }));
  createCheckpoint(f.root, f.checkpoint.session_id, f.cwd, f.input);
  const result = await handoff({ root: f.root, session: operation.source_session_id, cwd: f.cwd, profile: operation.profile, operationId: operation.operation_id, executable: operation.codex_executable });
  assert.equal(result.target_session_id, operation.target_session_id);
  assert.equal(result.packet_sha256, operation.packet_sha256);
  assert.ok('reused' in result);
  assert.equal(result.reused, true);
});

test('workspace changes during capability probes prevent the actual launch', symlinkOptions, async t => {
  const f = fixture(t);
  createCheckpoint(f.root, f.checkpoint.session_id, f.cwd, f.input);
  const launchMarker = path.join(f.base, 'actual-launch-marker');
  const executable = path.join(f.base, 'synthetic-codex');
  fs.writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') console.log('synthetic-codex-1');
else if (args.includes('--help')) {
  if (args[0] === 'exec') fs.writeFileSync(${JSON.stringify(path.join(f.cwd, 'task.txt'))}, 'changed during capability probe\\n');
  console.log('--profile --cd --json --sandbox read-only --output-schema --output-last-message');
} else {
  fs.writeFileSync(${JSON.stringify(launchMarker)}, 'should never launch');
  process.exitCode = 1;
}
`, { mode: 0o700 });
  try { await handoff({ root: f.root, session: f.checkpoint.session_id, cwd: f.cwd, profile: 'synthetic-profile', executable }); }
  catch (error) { assert.match(String(error), /snapshot|changed/i); }
  assert.equal(fs.existsSync(launchMarker), false, 'rechecking only after launch is too late');
});


test('a persistent watcher preserves a concurrently added manual mark', { timeout: 15000 }, async t => {
  const f = fixture(t);
  const source = path.join(f.base, 'synthetic-source.jsonl');
  fs.writeFileSync(source, JSON.stringify({ type: 'session_meta', payload: { id: f.checkpoint.session_id, cwd: f.cwd } }) + '\n');
  const cli = fileURLToPath(new URL('../bin/csm.mjs', import.meta.url));
  const common = ['--session', f.checkpoint.session_id, '--cwd', f.cwd, '--state-dir', f.root];
  const watcher = spawn(process.execPath, [cli, 'watch', ...common, '--source', source, '--interval-seconds', '1'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', stderr = '';
  watcher.stdout.setEncoding('utf8'); watcher.stderr.setEncoding('utf8');
  watcher.stdout.on('data', (chunk: string) => { output += chunk; });
  watcher.stderr.on('data', (chunk: string) => { stderr += chunk; });
  const closed = new Promise<void>(resolve => watcher.once('close', () => resolve()));
  t.after(async () => { if (watcher.exitCode === null) watcher.kill('SIGTERM'); await closed; });
  const pollCount = () => output.split('"source_verified": true').length - 1;
  const waitForPoll = async (minimum: number) => {
    const deadline = Date.now() + 8000;
    while (pollCount() < minimum) {
      assert.equal(watcher.exitCode, null, `watcher exited: ${stderr}`);
      assert.ok(Date.now() < deadline, `timed out waiting for synthetic watcher: ${stderr}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  await waitForPoll(1);
  const mark = spawnSync(process.execPath, [cli, 'mark', ...common, '--kind', 'constraint-violation', '--constraint-id', 'synthetic-constraint'], { encoding: 'utf8', timeout: 8000 });
  assert.equal(mark.status, 0, mark.stderr);
  const observed = pollCount();
  await waitForPoll(observed + 1);
  const state = JSON.parse(fs.readFileSync(path.join(sessionDir(f.root, f.checkpoint.session_id, f.cwd), 'monitor.json'), 'utf8'));
  assert.equal(state.events.some((event: { kind: string; payload: { constraint_id?: string } }) => event.kind === 'manual_mark' && event.payload.constraint_id === 'synthetic-constraint'), true, 'watch must not overwrite a mark written by another command');
});

test('a filename-only gitignore pattern cannot authorize private runtime writes', t => {
  const f = fixture(t);
  assert.equal(spawnSync('git', ['-C', f.cwd, 'init', '-q']).status, 0);
  fs.writeFileSync(path.join(f.cwd, '.gitignore'), '*.md\n');
  const unsafeRoot = path.join(f.cwd, 'not-ignored-state');
  assert.throws(() => createCheckpoint(unsafeRoot, f.checkpoint.session_id, f.cwd, f.input));
  assert.equal(fs.existsSync(unsafeRoot), false, 'all private writes must be blocked before creating the state directory');
  const status = spawnSync('git', ['-C', f.cwd, 'status', '--short', '--untracked-files=all'], { encoding: 'utf8' });
  assert.doesNotMatch(status.stdout, /not-ignored-state/);
});

test('the repository root itself cannot be used as private state', t => {
  const f = fixture(t);
  assert.equal(spawnSync('git', ['-C', f.cwd, 'init', '-q']).status, 0);
  assert.throws(() => createCheckpoint(f.cwd, f.checkpoint.session_id, f.cwd, f.input));
  assert.equal(fs.existsSync(path.join(f.cwd, 'sessions')), false, 'containment must be checked before appending a path separator');
});

test('a dot-dot-prefixed child remains inside its repository for privacy checks', t => {
  const f = fixture(t);
  assert.equal(spawnSync('git', ['-C', f.cwd, 'init', '-q']).status, 0);
  const unsafeRoot = path.join(f.cwd, '..private-state');
  assert.throws(() => createCheckpoint(unsafeRoot, f.checkpoint.session_id, f.cwd, f.input));
  assert.equal(fs.existsSync(unsafeRoot), false, 'a name starting with two dots is not a parent traversal');
});
