/** No-auth example: synthetic project + checkpoint + launch preview. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = fileURLToPath(new URL('../bin/csm.mjs', import.meta.url));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-handoff-demo-'));
const project = path.join(temporary, '示例 project');
const state = path.join(temporary, 'state');
fs.mkdirSync(project);
fs.writeFileSync(path.join(project, 'README.md'), '# Synthetic demo\n\nNo production files or live Codex session.\n');
const session = 'synthetic-demo-session';
const checkpointFile = path.join(temporary, 'task-state.json');
fs.writeFileSync(checkpointFile, JSON.stringify({
  schema_version: 1,
  session_id: session,
  cwd: fs.realpathSync(project),
  goal: 'Demonstrate a handoff preview using synthetic data only.',
  constraints: [{ id: 'DEMO-C1', text: 'Do not launch a real Codex session.', source: 'docs/demo.mjs fixture', status: 'confirmed' }],
  acceptance: ['The preview reports dry_run=true and launches=0.'],
  decisions: ['[verified; source: this script] Use a temporary synthetic workspace.'],
  rejected_approaches: [],
  todos: ['Review the returned launch preview.'],
  blockers: [],
  important_files: ['README.md'],
  next_step: 'Read the synthetic README without modifying it.',
  ongoing_operations: [],
  writers_stopped: true,
}, null, 2));

function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8', shell: false,
    env: { ...process.env, CODEX_HOME: path.join(temporary, 'unused-codex-home') },
  });
  if (result.error || result.status !== 0) {
    throw new Error(result.stderr.trim() || result.error?.message || `CLI exited ${result.status}`);
  }
  return JSON.parse(result.stdout);
}

const common = ['--session', session, '--cwd', project, '--state-dir', state];
const checkpoint = run(['checkpoint', ...common, '--from', checkpointFile]);
const preview = run(['handoff', ...common, '--profile', 'synthetic-demo-no-launch', '--dry-run']);
if (preview.dry_run !== true || preview.launches !== 0) throw new Error('Unexpected demo result.');
console.log(JSON.stringify({
  demo: 'Synthetic data; no Codex process or model session was launched.',
  directory: temporary,
  checkpoint,
  preview,
  cleanup: 'The temporary example files are retained for inspection. Remove this directory when no longer needed.',
}, null, 2));
