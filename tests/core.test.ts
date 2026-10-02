import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createCheckpoint, loadLatestPacket } from '../src/handoff.ts';
import { doctor, handoff } from '../src/launcher.ts';
import { codexHome, digest, readJson, sessionDir, UserError } from '../src/storage.ts';
import { installSkill, uninstallSkill } from '../src/installer.ts';

function fixture(t: any, mode = 'success') {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'csm-test-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const cwd = path.join(tmp, '项目 with spaces;$(literal)'); fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, 'README.md'), 'Goal and evidence.\n');
  const root = path.join(tmp, 'private-state'), input = path.join(tmp, 'input.json');
  const session = 'source-session-123';
  const checkpoint = {
    schema_version: 1, session_id: session, cwd, goal: '保留约束并完成任务',
    constraints: [{ id: 'safe', text: 'No deployment', source: 'User turn 1', status: 'confirmed' }],
    acceptance: ['Tests pass'], decisions: ['Use a CLI'], rejected_approaches: ['Do not copy full transcripts'],
    todos: ['Add tests'], blockers: [], important_files: ['README.md'], next_step: 'Run focused tests', ongoing_operations: [], writers_stopped: true,
  };
  fs.writeFileSync(input, JSON.stringify(checkpoint));
  const executable = path.join(tmp, 'fake codex.mjs');
  fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ mode }));
  fs.writeFileSync(executable, `#!/usr/bin/env node
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
const own=path.dirname(fileURLToPath(import.meta.url));const args=process.argv.slice(2);
if(args.includes('--version')){console.log('codex-cli 0.159.2');process.exit(0)}
if(args.includes('--help')){console.log('--profile --cd --json --sandbox read-only --output-schema --output-last-message');process.exit(0)}
const {mode}=JSON.parse(fs.readFileSync(path.join(own,'settings.json')));
const calls=path.join(own,'calls.json');const count=fs.existsSync(calls)?JSON.parse(fs.readFileSync(calls)).count:0;
fs.writeFileSync(calls,JSON.stringify({count:count+1,args,home:process.env.CODEX_HOME}));
let prompt='';for await(const part of process.stdin)prompt+=part;
const reportPath=args[args.indexOf('--output-last-message')+1];const operation=JSON.parse(fs.readFileSync(path.join(path.dirname(reportPath),'operation.json')));
const manifest=JSON.parse(fs.readFileSync(path.join(operation.packet,'manifest.json')));
if(mode==='profile'){console.error('unknown profile');process.exit(2)}
if(mode==='auth'){console.error('authentication failed');process.exit(1)}
if(mode==='timeout-before')await new Promise(()=>{setInterval(()=>{},1000)});
if(mode!=='no-thread')console.log(JSON.stringify({type:'thread.started',thread_id:mode==='source-id'?operation.source_session_id:'new-real-fixture-id'}));
if(mode==='hold')await new Promise(r=>setTimeout(r,450));
if(mode==='timeout-after')await new Promise(()=>{setInterval(()=>{},1000)});
if(mode==='malformed')console.log('not JSON');
if(mode==='nonzero')process.exit(9);
const report={schema_version:1,operation_id:operation.operation_id,packet_sha256:manifest.packet_sha256,received_constraint_ids:manifest.checkpoint.constraints.filter(c=>c.status!=='superseded').map(c=>c.id),verified_files:Object.entries(manifest.snapshot.files).map(([name,value])=>({path:name,sha256:value.exists?value.sha256:'missing'})),next_step:'Run focused tests',ready:true,blockers:[]};
if(mode==='wrong-digest')report.packet_sha256='bad';
if(mode==='wrong-op')report.operation_id='other';
if(mode==='missing-constraint')report.received_constraint_ids=[];
if(mode==='duplicate-constraint')report.received_constraint_ids.push(report.received_constraint_ids[0]);
if(mode==='file-mismatch')report.verified_files[0].sha256='bad';
if(mode==='extra-field')report.arbitrary='bad';
if(mode==='blocked'){report.ready=false;report.blockers=['Need clarification']}
if(mode!=='report-missing')fs.writeFileSync(reportPath,JSON.stringify(report));
if(mode==='mutate')fs.appendFileSync(path.join(operation.cwd,'README.md'),'changed');
if(mode!=='no-turn')console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:42,output_tokens:7}}));
`); fs.chmodSync(executable, 0o755);
  const packet = () => createCheckpoint(root, session, cwd, input);
  const options = { root, session, cwd, profile: 'user-chosen', executable };
  return { tmp, cwd, root, input, session, checkpoint, executable, packet, options };
}

test('checkpoint preserves selected state, private permissions, and bounded source metadata', t => {
  const f = fixture(t); const result = f.packet(); const loaded = loadLatestPacket(f.root, f.session, f.cwd);
  assert.equal(loaded.manifest.checkpoint.goal, f.checkpoint.goal);
  assert.equal((loaded.manifest.snapshot.files['README.md'] as {sha256: string}).sha256, digest('Goal and evidence.\n'));
  assert.equal(result.ready_to_initialize, true);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(result.packet).mode & 0o777, 0o700);
    for (const name of fs.readdirSync(result.packet)) assert.equal(fs.statSync(path.join(result.packet, name)).mode & 0o777, 0o600);
  }
});
test('checkpoint rejects mismatched session, cwd, duplicate constraints, and malformed input', t => {
  const f = fixture(t);
  for (const replacement of [{ session_id: 'other' }, { cwd: path.dirname(f.cwd) }, { constraints: [...f.checkpoint.constraints, ...f.checkpoint.constraints] }, { writers_stopped: 'yes' }]) {
    fs.writeFileSync(f.input, JSON.stringify({ ...f.checkpoint, ...replacement })); assert.throws(f.packet, UserError);
  }
  fs.writeFileSync(f.input, 'not JSON'); assert.throws(f.packet, /Invalid UTF-8 JSON/);
});
test('checkpoint rejects oversized input and credential file references', t => {
  const f = fixture(t); fs.writeFileSync(f.input, ' '.repeat(300000)); assert.throws(f.packet, /limit/);
  for (const name of ['.env', '.aws/credentials', '.codex/auth.json', '.ssh/id_rsa', '.npmrc', '.netrc', '.git-credentials', '../outside']) {
    fs.writeFileSync(f.input, JSON.stringify({ ...f.checkpoint, important_files: [name] })); assert.throws(f.packet, UserError);
  }
});
test('packet tampering is detected before launching', async t => {
  const f = fixture(t); const packet = f.packet(); fs.appendFileSync(path.join(packet.packet, 'handoff.md'), 'tamper');
  await assert.rejects(handoff({ ...f.options, dryRun: true }), /integrity/);
});
test('dry-run preserves selected profile, cwd, CODEX_HOME, and shell-free argv', async t => {
  const f = fixture(t); f.packet(); const result: any = await handoff({ ...f.options, dryRun: true });
  assert.equal(result.launches, 0); assert.equal(result.profile, f.options.profile); assert.equal(result.env.CODEX_HOME, codexHome());
  assert.deepEqual(result.argv.slice(0, 8), [f.executable, 'exec', '--profile', 'user-chosen', '--cd', f.cwd, '--sandbox', 'read-only']);
  assert(!result.argv.some((value: string) => ['--last', '--ephemeral', 'fork', '--dangerously-bypass-approvals-and-sandbox'].includes(value)));
  assert(!fs.existsSync(path.join(f.tmp, 'calls.json')));
});
test('malicious profile is rejected and cwd metacharacters remain literal', async t => {
  const f = fixture(t); f.packet();
  for (const profile of ['--dangerous', 'x; touch injected', '../../auth', 'a\0b', 'x\ny']) await assert.rejects(handoff({ ...f.options, profile, dryRun: true }), UserError);
  assert(!fs.existsSync(path.join(f.cwd, 'injected')));
});
test('dirty Git state is preserved without auto stage or commit', async t => {
  const f = fixture(t);
  const git = (args: string[]) => spawnSync('git', ['-C', f.cwd, ...args], { encoding: 'utf8' });
  assert.equal(git(['init', '-q']).status, 0); assert.equal(git(['add', 'README.md']).status, 0);
  fs.appendFileSync(path.join(f.cwd, 'README.md'), 'dirty'); fs.writeFileSync(path.join(f.cwd, 'untracked.txt'), 'secret source content not collected');
  const before = git(['status', '--porcelain']).stdout; f.packet(); await handoff({ ...f.options, dryRun: true });
  assert.equal(git(['status', '--porcelain']).stdout, before);
  assert(!JSON.stringify(loadLatestPacket(f.root, f.session, f.cwd).manifest).includes('secret source content'));
});
test('nonignored runtime state inside a Git repository is refused', t => {
  const f = fixture(t); spawnSync('git', ['-C', f.cwd, 'init', '-q']);
  assert.throws(() => createCheckpoint(path.join(f.cwd, 'public-packets'), f.session, f.cwd, f.input), /not ignored/);
  assert.throws(() => createCheckpoint(f.cwd, f.session, f.cwd, f.input), /repository root/);
  fs.writeFileSync(path.join(f.cwd, '.gitignore'), '.auto-handoff/\n');
  assert(createCheckpoint(path.join(f.cwd, '.auto-handoff'), f.session, f.cwd, f.input).packet);
});
test('known writers and changed snapshot block creation', async t => {
  const f = fixture(t); fs.writeFileSync(f.input, JSON.stringify({ ...f.checkpoint, writers_stopped: false })); f.packet();
  await assert.rejects(handoff(f.options), /writers/);
  fs.writeFileSync(f.input, JSON.stringify(f.checkpoint)); f.packet(); fs.appendFileSync(path.join(f.cwd, 'README.md'), 'new');
  await assert.rejects(handoff(f.options), /snapshot changed/);
});
test('successful initialization waits for full report, turn, and process and is idempotent', async t => {
  const f = fixture(t); f.packet(); const first: any = await handoff(f.options);
  assert.equal(first.state, 'ready'); assert.equal(first.target_session_id, 'new-real-fixture-id'); assert.equal(first.launch_count, 1);
  assert(first.resume_argv.includes(f.cwd)); assert(first.resume_argv.includes(f.options.profile)); assert(!first.resume_argv.includes('--last'));
  const second: any = await handoff(f.options); assert.equal(second.reused, true);
  assert.equal(readJson(path.join(f.tmp, 'calls.json')).count, 1);
  assert.equal(readJson(path.join(f.tmp, 'calls.json')).home, codexHome());
});
test('real ID is persisted while initialization is still running and one source lock blocks duplicates', async t => {
  const f = fixture(t, 'hold'); f.packet(); const running = handoff(f.options);
  const current = path.join(sessionDir(f.root, f.session, f.cwd), 'operation-current.json');
  const deadline = Date.now() + 3000; let observed: any;
  while (Date.now() < deadline) {
    if (fs.existsSync(current)) { observed = readJson(current); if (observed.state === 'initializing') break; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(observed.state, 'initializing'); assert.equal(observed.target_session_id, 'new-real-fixture-id');
  await assert.rejects(handoff(f.options), /lock/);
  assert.equal((await running).state, 'ready');
});
for (const mode of ['wrong-digest', 'wrong-op', 'missing-constraint', 'duplicate-constraint', 'file-mismatch', 'extra-field', 'blocked', 'report-missing', 'mutate', 'nonzero']) {
  test(`invalid initialization is never ready: ${mode}`, async t => {
    const f = fixture(t, mode); f.packet(); const result: any = await handoff(f.options);
    assert.equal(result.state, 'failed'); assert.equal(result.target_session_id, 'new-real-fixture-id'); assert(result.resume_command);
    const again: any = await handoff({ ...f.options, operationId: result.operation_id }); assert.equal(again.reused, true);
    assert.equal(readJson(path.join(f.tmp, 'calls.json')).count, 1);
  });
}
for (const mode of ['no-thread', 'no-turn', 'malformed', 'source-id', 'auth', 'profile']) {
  test(`ambiguous initialization is uncertain: ${mode}`, async t => {
    const f = fixture(t, mode); f.packet(); const result: any = await handoff(f.options);
    assert.equal(result.state, 'uncertain'); assert.notEqual(result.state, 'ready');
    if (mode === 'auth') assert.match(result.error, /Authentication/);
    if (mode === 'profile') assert.match(result.error, /profile/);
    const again: any = await handoff({ ...f.options, operationId: result.operation_id }); assert.equal(again.reused, true);
  });
}
test('timeout without a known ID remains uncertain and never blindly relaunches', async t => {
  const f = fixture(t, 'timeout-before'); f.packet(); const result: any = await handoff({ ...f.options, timeoutSeconds: 1 });
  assert.equal(result.state, 'uncertain'); assert.match(result.error, /timed out/); assert(result.elapsed_ms >= 900); const next: any = await handoff({ ...f.options, operationId: result.operation_id }); assert.equal(next.reused, true);
  assert.equal(readJson(path.join(f.tmp, 'calls.json')).count, 1);
});
test('timeout after a real ID retains the exact recovery command', async t => {
  const f = fixture(t, 'timeout-after'); f.packet(); const result: any = await handoff({ ...f.options, timeoutSeconds: 1 });
  assert.equal(result.state, 'uncertain'); assert.equal(result.target_session_id, 'new-real-fixture-id');
  assert.match(result.error, /timed out/); assert(result.elapsed_ms >= 900); assert.match(result.resume_command, /new-real-fixture-id/);
});
test('a new checkpoint cannot create a second session after failed initialization with a known ID', async t => {
  const f = fixture(t, 'wrong-digest'); f.packet(); const first: any = await handoff(f.options);
  assert.equal(first.state, 'failed'); assert.equal(first.target_session_id, 'new-real-fixture-id');
  f.packet(); await assert.rejects(handoff(f.options), /new-real-fixture-id.*csm status/);
  assert.equal(readJson(path.join(f.tmp, 'calls.json')).count, 1);
});
test('missing executable and unsupported Windows shell shim fail safely', async t => {
  const f = fixture(t); f.packet(); assert.equal(doctor(path.join(f.tmp, 'absent')).capabilities.fresh_session_initialization, 'unsupported');
  await assert.rejects(handoff({ ...f.options, executable: path.join(f.tmp, 'absent') }), /unavailable/);
  await assert.rejects(handoff({ ...f.options, executable: 'codex.cmd', dryRun: true }), /shell=false/);
});
test('installer is idempotent, rejects unmanaged conflicts, and preserves edited files', t => {
  const f = fixture(t); const result = installSkill('project', f.cwd); assert.equal(result.installed.length, 1);
  assert.deepEqual(installSkill('project', f.cwd).installed, result.installed);
  const skill = path.join(result.installed[0], 'SKILL.md'); fs.appendFileSync(skill, '\nuser edit');
  assert.throws(() => installSkill('project', f.cwd), /user edits/);
  const removed = uninstallSkill('project', f.cwd); assert(removed.preserved.includes(skill)); assert(fs.existsSync(skill));
});
test('installer installs legacy alias only when requested and clean uninstall removes managed skills', t => {
  const f = fixture(t); const result = installSkill('project', f.cwd, true); assert.equal(result.installed.length, 2);
  uninstallSkill('project', f.cwd, true); for (const dir of result.installed) assert(!fs.existsSync(dir));
});
