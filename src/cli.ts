import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { atomicWrite, directory, now, privateDir, readJson, requireText, sessionDir, sessionId, stateRoot, UserError, VERSION, withLock } from './storage.ts';
import { createCheckpoint } from './handoff.ts';
import { doctor, handoff } from './launcher.ts';
import { installSkill, uninstallSkill } from './installer.ts';
import { addManualMark, createMonitorState, getMonitorStatus, migrateMonitorState, pollMonitor } from './monitor.ts';
import type { MonitorState } from './monitor.ts';
import { checkTrial, feedbackTrial, initializeBaseline, observeTrial, reviewTrial, trialStatus, verifyTrial } from './drift-store.ts';
import { validateStateLocation } from './snapshot.ts';

const help = `auto-handoff / csm ${VERSION} (Node.js >=22.18)

Commands:
  doctor [--codex PATH]                       Probe CLI help without a model call
  install [--scope user|project] [--legacy-alias]
  uninstall [--scope user|project] [--legacy-alias]
  checkpoint --session ID --cwd DIR --from FILE
  handoff --session ID --cwd DIR --profile NAME [--dry-run]
          [--operation-id ID] [--timeout-seconds 120] [--codex PATH]
  watch --session ID --cwd DIR --source FILE [--once]
        [--adapter codex-rollout-v1-partial|csm-jsonl-v1] [--interval-seconds 5]
  status --session ID --cwd DIR [--json]
  baseline --session ID --cwd DIR --from FILE [--replace-baseline]
  check --session ID --cwd DIR                 Measure selected baseline file rules
  observe --session ID --cwd DIR --from FILE   Import caller-reported evidence
  verify --session ID --cwd DIR --criterion-id ID -- COMMAND [ARGS...]
  review --session ID --cwd DIR                Emit a bounded advisory review packet
  feedback --session ID --cwd DIR --signal-id ID --verdict true|false|uncertain --note TEXT
  feedback --session ID --cwd DIR --verdict missed --note TEXT [--evidence-ids ID,ID]
  mark --session ID --cwd DIR --kind constraint-violation|repetition|phase-complete
       [--constraint-id ID] [--note TEXT]
  feedback --session ID --cwd DIR --operation-id ID --outcome helped|unhelpful|unknown
           [--note TEXT]

All commands support --state-dir DIR. Runtime data defaults outside repositories.
Monitor rules: --checkpoint-percent 70 --repetition-count 3
               --handoff-percent 85 is a deprecated capacity-only compatibility option
               --cooldown-seconds 300 --stale-after-seconds 900
Outputs are JSON. No automatic terminal replacement, transcript discovery, or model fallback.
A real handoff calls your selected Codex profile/provider and may incur usage charges.
`;
function print(value: unknown): void { process.stdout.write(JSON.stringify(value, null, 2) + '\n'); }
export async function main(args: string[]): Promise<number> {
  try {
    const separator = args.indexOf('--');
    const ownArgs = separator === -1 ? args : args.slice(0, separator);
    if (!args.length || ownArgs.includes('--help') || args[0] === 'help') { process.stdout.write(help); return 0; }
    if (args[0] === '--version' || args[0] === 'version') { process.stdout.write(VERSION + '\n'); return 0; }
    const command = args[0];
    const { values, positionals } = parseArgs({ args: args.slice(1), strict: true, allowPositionals: true, options: {
      session: { type: 'string' }, cwd: { type: 'string' }, from: { type: 'string' }, profile: { type: 'string' },
      'state-dir': { type: 'string' }, 'operation-id': { type: 'string' }, 'dry-run': { type: 'boolean' },
      'timeout-seconds': { type: 'string' }, codex: { type: 'string' }, json: { type: 'boolean' },
      source: { type: 'string' }, once: { type: 'boolean' }, 'interval-seconds': { type: 'string' },
      'stale-after-seconds': { type: 'string' }, adapter: { type: 'string' },
      kind: { type: 'string' }, 'constraint-id': { type: 'string' }, note: { type: 'string' }, outcome: { type: 'string' },
      scope: { type: 'string' }, 'legacy-alias': { type: 'boolean' },
      'replace-baseline': { type: 'boolean' }, 'criterion-id': { type: 'string' },
      'signal-id': { type: 'string' }, verdict: { type: 'string' }, 'evidence-ids': { type: 'string' },
      'checkpoint-percent': { type: 'string' }, 'handoff-percent': { type: 'string' }, 'repetition-count': { type: 'string' }, 'cooldown-seconds': { type: 'string' },
    } });
    if (positionals.length && command !== 'verify') throw new UserError('Unexpected positional arguments. Use --help.');
    const required = (key: keyof typeof values): string => requireText(values[key], `--${key}`, 4096);
    if (command === 'doctor') { print(doctor(values.codex)); return 0; }
    const cwd = directory(values.cwd ?? process.cwd());
    if (command === 'install' || command === 'uninstall') {
      print((command === 'install' ? installSkill : uninstallSkill)(values.scope ?? 'project', cwd, values['legacy-alias'])); return 0;
    }
    const session = sessionId(required('session'));
    const root = stateRoot(values['state-dir']);
    const dir = sessionDir(root, session, cwd);
    const trial = { root, session, cwd };
    if (command === 'baseline') { print(await initializeBaseline(trial, path.resolve(required('from')), values['replace-baseline'])); return 0; }
    if (command === 'checkpoint') { print(createCheckpoint(root, session, cwd, path.resolve(required('from')))); return 0; }
    if (command === 'handoff') {
      const result = await handoff({ root, session, cwd, profile: required('profile'), operationId: values['operation-id'], dryRun: values['dry-run'], timeoutSeconds: values['timeout-seconds'] === undefined ? undefined : Number(values['timeout-seconds']), executable: values.codex });
      print(result); return result.state === 'failed' ? 3 : result.state === 'uncertain' ? 4 : 0;
    }
    const monitorFile = path.join(dir, 'monitor.json');
    const readMonitor = (): MonitorState => {
      const state = fs.existsSync(monitorFile) ? migrateMonitorState(readJson(monitorFile, 16 * 1024 * 1024)) : createMonitorState({ sessionId: session, cwd });
      if (state.binding?.session_id !== session || state.binding?.workspace !== cwd) throw new UserError('Stored monitor identity mismatch.');
      return state;
    };
    let monitor = readMonitor();
    const staleAfterMs = values['stale-after-seconds'] === undefined ? undefined : Number(values['stale-after-seconds']) * 1000;
    if (staleAfterMs !== undefined && (!Number.isFinite(staleAfterMs) || staleAfterMs < 0)) throw new UserError('Stale interval must be a nonnegative number.');
    const numberOption = (key: keyof typeof values) => values[key] === undefined ? undefined : Number(values[key]);
    const monitorOptions = { staleAfterMs, rules: { checkpointPercent: numberOption('checkpoint-percent'), handoffPercent: numberOption('handoff-percent'), repetitionCount: numberOption('repetition-count'), cooldownMs: values['cooldown-seconds'] === undefined ? undefined : Number(values['cooldown-seconds']) * 1000 } };
    const driftOptions = { staleAfterMs, repetitionCount: numberOption('repetition-count') };
    if (command === 'check') { print(await checkTrial(trial, monitor, driftOptions)); return 0; }
    if (command === 'observe') { print(await observeTrial(trial, path.resolve(required('from')), driftOptions)); return 0; }
    if (command === 'review') { print(await reviewTrial(trial, driftOptions)); return 0; }
    if (command === 'verify') {
      const result = await verifyTrial(trial, required('criterion-id'), positionals, numberOption('timeout-seconds') ?? 300, driftOptions);
      print(result); return result.verification.result === 'fail' ? 3 : result.verification.result === 'unknown' ? 4 : 0;
    }
    if (command === 'feedback' && values.verdict !== undefined) {
      const verdicts = { true: 'true-positive', false: 'false-positive', uncertain: 'uncertain', missed: 'missed-anomaly' } as const;
      if (!Object.hasOwn(verdicts, values.verdict)) throw new UserError('Trial verdict must be true, false, uncertain, or missed.');
      print(await feedbackTrial(trial, { signalId: values['signal-id'], verdict: verdicts[values.verdict as keyof typeof verdicts], note: required('note'), evidenceIds: values['evidence-ids']?.split(',').filter(Boolean) }, driftOptions)); return 0;
    }
    if (command === 'status') {
      const operationFile = path.join(dir, 'operation-current.json');
      const checkpointFile = path.join(dir, 'checkpoint-latest.json');
      print({ session_id: session, cwd, monitoring: getMonitorStatus(monitor, monitorOptions), drift: trialStatus(trial, driftOptions), checkpoint: fs.existsSync(checkpointFile) ? readJson(checkpointFile) : null, operation: fs.existsSync(operationFile) ? readJson(operationFile) : null });
      return 0;
    }
    if (!['watch', 'mark', 'feedback'].includes(command)) throw new UserError('Unknown command. Use --help.');
    validateStateLocation(root); privateDir(dir);
    if (command === 'mark') {
      const kind = required('kind');
      if (!['constraint-violation', 'repetition', 'phase-complete'].includes(kind)) throw new UserError('Unknown manual mark kind.');
      const result = await withLock(dir, async () => {
        const marked = addManualMark(readMonitor(), { kind: kind as 'constraint-violation' | 'repetition' | 'phase-complete', constraintId: values['constraint-id'], note: values.note }, monitorOptions);
        atomicWrite(monitorFile, marked.state); return marked;
      }, 'monitor.lock', 2000);
      print(result.status); return 0;
    }
    if (command === 'feedback') {
      const operationId = sessionId(required('operation-id'));
      const operation = readJson(path.join(dir, 'operations', operationId, 'operation.json'));
      if (operation.source_session_id !== session || operation.cwd !== cwd) throw new UserError('Feedback operation identity mismatch.');
      const outcome = required('outcome');
      if (!['helped', 'unhelpful', 'unknown'].includes(outcome)) throw new UserError('Outcome must be helped, unhelpful, or unknown.');
      const file = path.join(dir, 'feedback.json');
      const records = fs.existsSync(file) ? readJson(file, 1024 * 1024) : [];
      if (!Array.isArray(records) || records.length >= 1000) throw new UserError('Feedback store is invalid or full. Preserve/archive it before adding more.');
      const feedback = { schema_version: 1, observed_at: now(), operation_id: operationId, source_session_id: session, target_session_id: operation.target_session_id, outcome, note: values.note ?? null };
      if (values.note) requireText(values.note, 'Feedback note', 4000);
      records.push(feedback); atomicWrite(file, records); print(feedback); return 0;
    }
    const sourcePath = path.resolve(required('source'));
    const adapter = values.adapter ?? 'codex-rollout-v1-partial';
    if (!['codex-rollout-v1-partial', 'csm-jsonl-v1'].includes(adapter)) throw new UserError('Unsupported source adapter.');
    const bindMonitor = (current: MonitorState): MonitorState => {
      if (current.binding.source_path === sourcePath && current.binding.adapter === adapter) return current;
      const rebound = createMonitorState({ sessionId: session, cwd, sourcePath, adapter: adapter as 'codex-rollout-v1-partial' | 'csm-jsonl-v1' });
      rebound.events = current.events.filter(event => event.source.adapter === 'manual');
      rebound.seen_event_ids = rebound.events.map(event => event.event_id);
      return rebound;
    };
    const interval = Number(values['interval-seconds'] ?? 5);
    if (!Number.isFinite(interval) || interval < 1 || interval > 3600) throw new UserError('Watch interval must be 1–3600 seconds.');
    let stopped = false;
    let wake: (() => void) | undefined;
    let lastOutput: string | undefined;
    const stop = () => { stopped = true; wake?.(); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    try {
      do {
        const result = await withLock(dir, async () => {
          const polled = await pollMonitor(bindMonitor(readMonitor()), monitorOptions);
          atomicWrite(monitorFile, polled.state); return polled;
        }, 'monitor.lock', 2000);
        monitor = result.state;
        const drift = await checkTrial(trial, monitor, driftOptions, true);
        const comparable = JSON.stringify({ ...result.status, drift: { ...drift, observed_at: undefined, last_files_checked_at: undefined, ...('signals' in drift ? { signals: drift.signals.map(signal => ({ ...signal, evidence_ids: undefined })), checks: drift.checks.map(check => ({ ...check, evidence_id: undefined })) } : {}) }, last_poll_at: undefined, recommendation: { ...result.status.recommendation, notify: undefined, suppressed_reason: undefined } });
        if (lastOutput !== comparable) { print({ ...result.status, drift }); lastOutput = comparable; }
        if (!values.once && !stopped) await new Promise<void>(resolve => {
          const timer = setTimeout(() => { wake = undefined; resolve(); }, interval * 1000);
          wake = () => { clearTimeout(timer); wake = undefined; resolve(); };
        });
      } while (!values.once && !stopped);
    } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
    return 0;
  } catch (error) {
    const message = error instanceof UserError || error instanceof Error ? error.message : 'Unexpected failure.';
    process.stderr.write(JSON.stringify({ error: message }) + '\n'); return 2;
  }
}
