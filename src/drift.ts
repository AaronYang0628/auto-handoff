import { createHash } from 'node:crypto';
import { isAbsolute, posix, resolve } from 'node:path';

/** Shadow-mode checks compare explicit evidence with an immutable declared baseline.
 * A source label/hash establishes traceability, not authenticated human authorship.
 * The CLI preserves the original supplied baseline separately from this projection.
 */
export interface DriftSource {
  kind: 'user' | 'filesystem' | 'codex-rollout' | 'check' | 'tool_runner' | 'reported';
  reference: string;
  epoch?: string;
}
export interface DriftConstraint {
  id: string;
  description: string;
  kind: 'file-unchanged' | 'file-exists' | 'file-absent' | 'manual';
  path?: string;
  expected_sha256?: string;
}
export interface DriftCriterion { id: string; description: string; command?: string[]; scope_paths?: string[]; max_age_seconds?: number }
export interface DriftBaseline {
  schema_version: 1;
  baseline_id: string;
  session_id: string;
  workspace: string;
  created_at: string;
  source: { kind: 'user'; reference: string };
  goal: string;
  constraints: DriftConstraint[];
  acceptance: DriftCriterion[];
  next_step: string;
  relevant_files: string[];
}
export interface FileObservation {
  path: string;
  status: 'present' | 'missing' | 'unreadable';
  sha256?: string;
}
interface EvidenceBase { id?: string; observed_at: string; source: DriftSource }
export type DriftEvidenceInput = EvidenceBase & (
  { kind: 'file_snapshot'; snapshot_id: string; files: FileObservation[] } |
  { kind: 'verification'; check_id: string; result: 'pass' | 'fail' | 'unknown'; snapshot_id: string; command_hash?: string; summary?: string } |
  { kind: 'action'; action_hash: string; result_hash: string; before_snapshot_id: string; after_snapshot_id: string; evidence_revision: string; outcome: 'success' | 'failure' | 'unknown'; expected_polling: boolean; new_evidence: boolean } |
  { kind: 'manual'; constraint_id?: string; observation: 'drift' | 'progress' | 'phase-complete'; note: string }
);
export type DriftEvidence = DriftEvidenceInput & { id: string; baseline_id: string; session_id: string; workspace: string };
export type FeedbackVerdict = 'true-positive' | 'false-positive' | 'uncertain' | 'missed-anomaly';
export interface DriftFeedback {
  id: string;
  baseline_id: string;
  session_id: string;
  workspace: string;
  signal_id: string | null;
  verdict: FeedbackVerdict;
  note: string;
  observed_at: string;
  evidence_ids: string[];
}
export interface DriftState {
  schema_version: 1;
  baseline: DriftBaseline;
  evidence: DriftEvidence[];
  feedback: DriftFeedback[];
  signal_history: DriftSignal[];
}
export interface DriftOptions { now?: string | Date; staleAfterMs?: number; repetitionCount?: number }
export interface DriftSignal {
  id: string;
  kind: 'constraint-violation' | 'constraint-unverified' | 'verification-failed' | 'verification-missing' | 'verification-stale' | 'verification-unverified' | 'no-gain-loop' | 'manual-drift';
  severity: 'review' | 'check';
  certainty: 'observed' | 'candidate' | 'unknown';
  summary: string;
  evidence_ids: string[];
  baseline_refs: string[];
}
export interface DriftReport {
  schema_version: 1;
  rules_version: 'csm-drift-v1';
  baseline_id: string;
  session_id: string;
  workspace: string;
  observed_at: string;
  shadow: true;
  state: 'review' | 'insufficient_data' | 'continue';
  signals: DriftSignal[];
  checks: { id: string; status: 'pass' | 'fail' | 'missing' | 'stale' | 'unverified'; evidence_id: string | null }[];
  capabilities: { file_constraints: 'available' | 'unknown' | 'stale'; verification: 'measured' | 'reported' | 'missing' | 'stale'; state_linked_actions: 'available' | 'unknown' };
  feedback_summary: Record<FeedbackVerdict, number>;
  limitations: string[];
}
export interface ReviewPacket {
  schema_version: 1;
  purpose: 'selective-human-review';
  shadow: true;
  baseline: Pick<DriftBaseline, 'baseline_id' | 'session_id' | 'workspace' | 'source' | 'goal' | 'next_step' | 'constraints' | 'acceptance'>;
  signals: DriftSignal[];
  evidence: DriftEvidence[];
  feedback: DriftFeedback[];
  questions: string[];
  omitted_evidence_count: number;
  omitted_signal_count: number;
  omitted_file_observations: number;
}

const MAX_EVIDENCE = 2000;
const MAX_FEEDBACK = 1000;
const HASH = /^[a-f0-9]{64}$/i;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
function record(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, any>;
}
function text(value: unknown, label: string, limit = 2000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || value.includes('\0')) throw new Error(`${label} must be nonempty text of at most ${limit} characters`);
  return value;
}
function date(value: unknown, label: string): string {
  if (typeof value !== 'string' && !(value instanceof Date)) throw new Error(`${label} must be a valid timestamp`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${label} must be a valid timestamp`);
  return parsed.toISOString();
}
function list(value: unknown, label: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error(`${label} must be an array with at most ${max} entries`);
  return value;
}
function member<T extends string>(value: unknown, choices: readonly T[], label: string): T {
  if (!choices.includes(value as T)) throw new Error(`Invalid ${label}`);
  return value as T;
}
function sha(value: unknown, label: string): string {
  if (typeof value !== 'string' || !HASH.test(value)) throw new Error(`${label} must be a SHA-256 hex digest`);
  return value.toLowerCase();
}
function path(value: unknown): string {
  const raw = text(value, 'Workspace-relative file path', 4096).replaceAll('\\', '/');
  if (isAbsolute(raw) || /^[a-z]:/i.test(raw) || raw.split('/').includes('..')) throw new Error('File paths must stay within the workspace');
  const normalized = posix.normalize(raw);
  if (normalized === '.' || normalized.endsWith('/')) throw new Error('Expected a workspace-relative file path');
  const parts = normalized.toLowerCase().split('/');
  const name = parts.at(-1)!;
  if (parts.some(part => ['.ssh', '.aws', '.git'].includes(part)) || ['auth.json', '.npmrc', '.netrc', '.git-credentials'].includes(name) || name.startsWith('credentials') || (/^\.env(?:\.|$)/.test(name) && !/\.(example|sample|template)$/.test(name))) throw new Error('Credential and control paths are not eligible baseline files');
  return normalized;
}
function unique(values: string[], label: string) {
  if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicate IDs or paths`);
}
function identity(value: Record<string, any>, baseline: DriftBaseline) {
  if ((value.baseline_id !== undefined && value.baseline_id !== baseline.baseline_id) ||
      (value.session_id !== undefined && value.session_id !== baseline.session_id) ||
      (value.workspace !== undefined && value.workspace !== baseline.workspace)) throw new Error('Drift evidence identity does not match baseline/session/workspace');
}

export function validateBaseline(raw: unknown, binding: { sessionId: string; cwd: string; now?: string | Date }): DriftBaseline {
  const value = record(raw, 'Baseline');
  if (value.schema_version !== 1) throw new Error('Unsupported baseline schema_version');
  const source = record(value.source, 'Baseline source');
  if (source.kind !== 'user') throw new Error('Baseline must explicitly reference the supplied user baseline; model inference is not a baseline');
  const session_id = text(binding.sessionId, 'Session ID', 256);
  const workspace = resolve(text(binding.cwd, 'Workspace', 4096));
  if ((value.session_id !== undefined && value.session_id !== session_id) || (value.workspace !== undefined && value.workspace !== workspace)) throw new Error('Baseline session/workspace mismatch');
  const constraints = list(value.constraints ?? [], 'Constraints', 100).map(raw => {
    const rule = record(raw, 'Constraint');
    const kind = member(rule.kind, ['file-unchanged', 'file-exists', 'file-absent', 'manual'] as const, 'constraint kind');
    const constraint: DriftConstraint = { id: text(rule.id, 'Constraint ID', 128), description: text(rule.description, 'Constraint description'), kind };
    if (kind !== 'manual') constraint.path = path(rule.path);
    if (kind === 'file-unchanged') constraint.expected_sha256 = sha(rule.expected_sha256, 'Expected file hash');
    return constraint;
  });
  const acceptance = list(value.acceptance ?? [], 'Acceptance criteria', 100).map(raw => {
    const criterion = record(raw, 'Acceptance criterion');
    const result: DriftCriterion = { id: text(criterion.id, 'Criterion ID', 128), description: text(criterion.description, 'Criterion description') };
    if (criterion.command !== undefined) {
      result.command = list(criterion.command, 'Criterion command argv', 100).map(arg => text(arg, 'Command argument', 4096));
      if (!result.command.length) throw new Error('Criterion command cannot be empty');
    }
    if (criterion.scope_paths !== undefined) result.scope_paths = [...new Set(list(criterion.scope_paths, 'Criterion scope paths', 200).map(path))].sort();
    if (criterion.max_age_seconds !== undefined) {
      if (typeof criterion.max_age_seconds !== 'number' || !Number.isFinite(criterion.max_age_seconds) || criterion.max_age_seconds < 0) throw new Error('Criterion max_age_seconds must be nonnegative');
      result.max_age_seconds = criterion.max_age_seconds;
    }
    return result;
  });
  unique([...constraints.map(item => item.id), ...acceptance.map(item => item.id)], 'Baseline');
  const relevant_files = [...new Set([...list(value.relevant_files ?? [], 'Relevant files', 200).map(path), ...constraints.flatMap(rule => rule.path ? [rule.path] : []), ...acceptance.flatMap(check => check.scope_paths ?? [])])].sort();
  const projected = {
    schema_version: 1 as const, session_id, workspace, source: { kind: 'user' as const, reference: text(source.reference, 'Baseline source reference', 1000) },
    goal: text(value.goal, 'Goal', 8000), constraints, acceptance, next_step: text(value.next_step, 'Next step', 4000), relevant_files,
  };
  const baseline_id = digest(projected);
  if (value.baseline_id !== undefined && value.baseline_id !== baseline_id) throw new Error('Baseline ID does not match its immutable contents');
  return { ...projected, baseline_id, created_at: date(value.created_at ?? binding.now ?? new Date(), 'Baseline creation time') };
}

export function createDriftState(baseline: DriftBaseline): DriftState {
  const checked = validateBaseline(baseline, { sessionId: baseline.session_id, cwd: baseline.workspace });
  return { schema_version: 1, baseline: checked, evidence: [], feedback: [], signal_history: [] };
}

/** Callers must label imported observations as reported. Only the in-process
 * filesystem/check runner is allowed to emit measured provenance in the CLI. */
export function addDriftEvidence(input: DriftState, raw: unknown): DriftState {
  const value = record(raw, 'Evidence');
  identity(value, input.baseline);
  const originalSource = record(value.source, 'Evidence source');
  const source: DriftSource = {
    kind: member(originalSource.kind, ['user', 'filesystem', 'codex-rollout', 'check', 'tool_runner', 'reported'] as const, 'evidence source'),
    reference: text(originalSource.reference, 'Evidence source reference', 1000),
    ...(originalSource.epoch === undefined ? {} : { epoch: text(originalSource.epoch, 'Source epoch', 256) }),
  };
  const base = { observed_at: date(value.observed_at, 'Measurement observation time'), source };
  let normalized: DriftEvidenceInput;
  if (value.kind === 'file_snapshot') {
    const files = list(value.files, 'File observations', 300).map(raw => {
      const file = record(raw, 'File observation');
      const result: FileObservation = { path: path(file.path), status: member(file.status, ['present', 'missing', 'unreadable'] as const, 'file status') };
      if (result.status === 'present') result.sha256 = sha(file.sha256, 'Observed file hash');
      return result;
    });
    unique(files.map(file => file.path), 'File snapshot');
    normalized = { ...base, kind: 'file_snapshot', snapshot_id: text(value.snapshot_id, 'Snapshot ID', 256), files };
  } else if (value.kind === 'verification') {
    const check_id = text(value.check_id, 'Acceptance check ID', 128);
    if (!input.baseline.acceptance.some(check => check.id === check_id)) throw new Error('Verification must reference a baseline acceptance criterion');
    normalized = { ...base, kind: 'verification', check_id, result: member(value.result, ['pass', 'fail', 'unknown'] as const, 'verification result'), snapshot_id: text(value.snapshot_id, 'Snapshot ID', 256), ...(value.command_hash === undefined ? {} : { command_hash: sha(value.command_hash, 'Verification command hash') }), ...(value.summary === undefined ? {} : { summary: text(value.summary, 'Verification summary') }) };
  } else if (value.kind === 'action') {
    if (typeof value.expected_polling !== 'boolean' || typeof value.new_evidence !== 'boolean') throw new Error('Action requires explicit polling and new-evidence flags');
    normalized = { ...base, kind: 'action', action_hash: sha(value.action_hash, 'Action hash'), result_hash: sha(value.result_hash, 'Result hash'), before_snapshot_id: text(value.before_snapshot_id, 'Before snapshot ID', 256), after_snapshot_id: text(value.after_snapshot_id, 'After snapshot ID', 256), evidence_revision: text(value.evidence_revision, 'Evidence revision', 256), outcome: member(value.outcome, ['success', 'failure', 'unknown'] as const, 'action outcome'), expected_polling: value.expected_polling, new_evidence: value.new_evidence };
  } else if (value.kind === 'manual') {
    const constraint_id = value.constraint_id === undefined ? undefined : text(value.constraint_id, 'Constraint ID', 128);
    if (constraint_id && !input.baseline.constraints.some(rule => rule.id === constraint_id)) throw new Error('Manual observation references an unknown constraint');
    normalized = { ...base, kind: 'manual', ...(constraint_id ? { constraint_id } : {}), observation: member(value.observation, ['drift', 'progress', 'phase-complete'] as const, 'manual observation'), note: text(value.note, 'Manual observation note') };
  } else throw new Error('Unsupported drift evidence kind');
  const bound = { ...normalized, baseline_id: input.baseline.baseline_id, session_id: input.baseline.session_id, workspace: input.baseline.workspace };
  const id = value.id === undefined ? digest(bound) : text(value.id, 'Evidence ID', 256);
  const existing = input.evidence.find(event => event.id === id);
  if (existing) {
    if (canonical(existing) !== canonical({ ...bound, id })) throw new Error('Evidence ID was reused with different contents');
    return structuredClone(input);
  }
  const state = structuredClone(input);
  state.evidence.push({ ...bound, id });
  state.evidence = state.evidence.slice(-MAX_EVIDENCE);
  return state;
}

function newest<T extends DriftEvidence>(events: T[]): T | undefined {
  return events.reduce<T | undefined>((best, event) => !best || Date.parse(event.observed_at) >= Date.parse(best.observed_at) ? event : best, undefined);
}
function measured(event: DriftEvidence): boolean { return ['check', 'tool_runner'].includes(event.source.kind); }

function substantiveEvidence(event: DriftEvidence): unknown {
  const provenance = { kind: event.source.kind, epoch: event.source.epoch ?? null };
  if (event.kind === 'file_snapshot') return { provenance, kind: event.kind, snapshot_id: event.snapshot_id, files: [...event.files].sort((a, b) => a.path.localeCompare(b.path)) };
  if (event.kind === 'verification') return { provenance, kind: event.kind, check_id: event.check_id, result: event.result, snapshot_id: event.snapshot_id, command_hash: event.command_hash ?? null };
  if (event.kind === 'action') return { provenance, kind: event.kind, action_hash: event.action_hash, result_hash: event.result_hash, before: event.before_snapshot_id, after: event.after_snapshot_id, revision: event.evidence_revision, outcome: event.outcome, polling: event.expected_polling, new_evidence: event.new_evidence };
  return { provenance, kind: event.kind, constraint_id: event.constraint_id ?? null, observation: event.observation, note: event.note };
}

export function evaluateDrift(state: DriftState, options: DriftOptions = {}): DriftReport {
  const now = date(options.now ?? new Date(), 'Assessment time');
  const staleAfterMs = options.staleAfterMs ?? 900_000;
  const repetitions = options.repetitionCount ?? 3;
  if (!Number.isFinite(staleAfterMs) || staleAfterMs < 0 || !Number.isInteger(repetitions) || repetitions < 2) throw new Error('Invalid drift rule options');
  const fresh = (event: DriftEvidence) => { const age = Date.parse(now) - Date.parse(event.observed_at); return age >= -60_000 && age <= staleAfterMs; };
  const baseline = state.baseline;
  // Never silently evaluate an edited baseline under a previous baseline identity.
  validateBaseline(baseline, { sessionId: baseline.session_id, cwd: baseline.workspace });
  for (const event of state.evidence) identity(event, baseline);
  const snapshots = state.evidence.filter((event): event is DriftEvidence & { kind: 'file_snapshot' } => event.kind === 'file_snapshot' && event.source.kind === 'filesystem');
  const snapshot = newest(snapshots);
  const completeCoverage = (item: DriftEvidence & { kind: 'file_snapshot' }) => baseline.relevant_files.length > 0 && baseline.relevant_files.every(path => item.files.some(file => file.path === path && file.status !== 'unreadable')); 
  const signals: DriftSignal[] = [];
  const checks: DriftReport['checks'] = [];
  const add = (kind: DriftSignal['kind'], severity: DriftSignal['severity'], certainty: DriftSignal['certainty'], summary: string, events: DriftEvidence[], refs: string[]) => {
    const evidence_ids = [...new Set(events.map(event => event.id))];
    const baseline_refs = [...new Set(refs)];
    const substantive_evidence = [...new Set(events.map(event => digest(substantiveEvidence(event))))].sort();
    signals.push({ id: digest({ baseline_id: baseline.baseline_id, session_id: baseline.session_id, workspace: baseline.workspace, kind, substantive_evidence, baseline_refs }), kind, severity, certainty, summary, evidence_ids, baseline_refs });
  };
  for (const rule of baseline.constraints) {
    if (rule.kind === 'manual') {
      add('constraint-unverified', 'check', 'unknown', `Constraint ${rule.id} is declared manual/semantic and has not been established by a deterministic check`, [], [rule.id]);
      continue;
    }
    const file = snapshot?.files.find(file => file.path === rule.path);
    if (!snapshot || !fresh(snapshot) || !file || file.status === 'unreadable') {
      add('constraint-unverified', 'check', 'unknown', `Cannot currently verify ${rule.id}: its exact file is missing from fresh readable snapshot evidence`, snapshot ? [snapshot] : [], [rule.id]);
      continue;
    }
    const violated = rule.kind === 'file-exists' ? file.status === 'missing' : rule.kind === 'file-absent' ? file.status === 'present' : file.status !== 'present' || file.sha256 !== rule.expected_sha256;
    if (violated) add('constraint-violation', 'review', 'observed', `Explicit file constraint ${rule.id} does not match the observed ${rule.path}; this is not a semantic judgment about the model`, [snapshot], [rule.id]);
  }
  for (const criterion of baseline.acceptance) {
    const verification = newest(state.evidence.filter((event): event is DriftEvidence & { kind: 'verification' } => event.kind === 'verification' && event.check_id === criterion.id));
    const reference = verification ? [verification] : [];
    if (!verification) {
      checks.push({ id: criterion.id, status: 'missing', evidence_id: null });
      add('verification-missing', 'check', 'unknown', `No verification evidence was recorded for ${criterion.id}`, [], [criterion.id]);
    } else if (!snapshot || !fresh(snapshot) || !fresh(verification) || Date.parse(now) - Date.parse(verification.observed_at) > (criterion.max_age_seconds === undefined ? staleAfterMs : criterion.max_age_seconds * 1000) || !completeCoverage(snapshot) || verification.snapshot_id !== snapshot.snapshot_id || (verification.source.epoch ?? null) !== (snapshot.source.epoch ?? null)) {
      checks.push({ id: criterion.id, status: 'stale', evidence_id: verification.id });
      add('verification-stale', 'check', 'unknown', `Verification for ${criterion.id} is stale or belongs to another file snapshot/source epoch`, snapshot ? [...reference, snapshot] : reference, [criterion.id]);
    } else if (!measured(verification) || verification.result === 'unknown' || !criterion.command || verification.command_hash !== hashCommand(criterion.command)) {
      checks.push({ id: criterion.id, status: 'unverified', evidence_id: verification.id });
      add('verification-unverified', verification.result === 'fail' ? 'review' : 'check', verification.result === 'fail' ? 'candidate' : 'unknown', `Result for ${criterion.id} is reported, inconclusive, or not bound to the exact registered command; it does not establish measured acceptance`, reference, [criterion.id]);
    } else {
      checks.push({ id: criterion.id, status: verification.result, evidence_id: verification.id });
      if (verification.result === 'fail') add('verification-failed', 'review', 'observed', `The explicit check for ${criterion.id} failed on the current recorded snapshot; failure alone does not identify its cause`, reference, [criterion.id]);
    }
  }
  if (baseline.acceptance.length === 0) add('verification-missing', 'check', 'unknown', 'The baseline has no explicit acceptance checks; goal completion cannot be assessed deterministically', [], []);
  const recent = state.evidence.filter(fresh).sort((a, b) => Date.parse(a.observed_at) - Date.parse(b.observed_at));
  for (const manual of recent.filter((event): event is DriftEvidence & { kind: 'manual' } => event.kind === 'manual' && event.observation === 'drift')) {
    add('manual-drift', 'review', 'candidate', `Explicitly reported drift: ${manual.note}`, [manual], manual.constraint_id ? [manual.constraint_id] : []);
  }
  const actions = recent.filter((event): event is DriftEvidence & { kind: 'action' } => event.kind === 'action');
  const lastAction = actions.at(-1);
  const matchingSnapshot = (action: DriftEvidence & { kind: 'action' }) => snapshots.some(item => item.snapshot_id === action.after_snapshot_id && (item.source.epoch ?? null) === (action.source.epoch ?? null) && fresh(item) && completeCoverage(item));
  const eligible = (action: DriftEvidence & { kind: 'action' }) => measured(action) && action.outcome === 'failure' && !action.expected_polling && !action.new_evidence && action.before_snapshot_id === action.after_snapshot_id && matchingSnapshot(action);
  const run: (DriftEvidence & { kind: 'action' })[] = [];
  if (lastAction && eligible(lastAction) && snapshot && fresh(snapshot) && lastAction.after_snapshot_id === snapshot.snapshot_id) {
    const signature = (event: DriftEvidence & { kind: 'action' }) => canonical([event.action_hash, event.result_hash, event.after_snapshot_id, event.evidence_revision, event.source.epoch ?? null]);
    const target = signature(lastAction);
    for (let index = actions.length - 1; index >= 0; index--) {
      if (!eligible(actions[index]) || signature(actions[index]) !== target) break;
      run.unshift(actions[index]);
    }
    // Any explicit progress or completed measured passing check since the run began invalidates a no-gain claim.
    const firstIndex = run[0] ? recent.findIndex(event => event.id === run[0].id) : -1;
    const interveningGain = firstIndex >= 0 && recent.slice(firstIndex).some(event =>
      (event.kind === 'manual' && event.observation !== 'drift') ||
      (event.kind === 'verification' && checks.some(check => check.status === 'pass' && check.evidence_id === event.id)) ||
      (event.kind === 'file_snapshot' && event.source.kind === 'filesystem' && event.snapshot_id !== lastAction.after_snapshot_id));
    if (run.length >= repetitions && !interveningGain) add('no-gain-loop', 'review', 'candidate', `${run.length} equivalent failing actions have unchanged linked file/result/evidence state; inspect whether retries are intentional before calling this a loop`, run, []);
  }
  const feedback_summary: DriftReport['feedback_summary'] = { 'true-positive': 0, 'false-positive': 0, uncertain: 0, 'missed-anomaly': 0 };
  for (const feedback of state.feedback) feedback_summary[feedback.verdict] += 1;
  return {
    schema_version: 1, rules_version: 'csm-drift-v1', baseline_id: baseline.baseline_id, session_id: baseline.session_id, workspace: baseline.workspace, observed_at: now, shadow: true,
    state: signals.some(signal => signal.severity === 'review') ? 'review' : signals.length > 0 ? 'insufficient_data' : 'continue', signals, checks,
    capabilities: { file_constraints: !snapshot ? 'unknown' : fresh(snapshot) ? 'available' : 'stale', verification: checks.some(check => check.status === 'pass' || check.status === 'fail') ? 'measured' : checks.some(check => check.status === 'unverified') ? 'reported' : checks.some(check => check.status === 'stale') ? 'stale' : 'missing', state_linked_actions: actions.some(action => measured(action) && matchingSnapshot(action)) ? 'available' : 'unknown' },
    feedback_summary,
    limitations: [
      'Shadow/advisory only: no automatic handoff, model call, model self-score, or semantic proof of goal adherence.',
      'A baseline/source label and its hash do not authenticate who authored it; preserve and review the original supplied baseline.',
      'Only declared paths and acceptance criteria are covered; unlisted files, external state and unknown tool semantics may be missed.',
      'Reported verification cannot establish measured acceptance; measured exit status still does not prove a check is sufficient.',
      `Evidence retention is bounded to ${MAX_EVIDENCE}; feedback to ${MAX_FEEDBACK}. Missing historical evidence stays unknown.`,
    ],
  };
}

export function createReviewPacket(state: DriftState, options: DriftOptions = {}): ReviewPacket {
  const report = evaluateDrift(state, options);
  const signals = [...report.signals].sort((a, b) => (a.severity === 'review' ? 0 : 1) - (b.severity === 'review' ? 0 : 1) || (a.certainty === 'observed' ? 0 : a.certainty === 'candidate' ? 1 : 2) - (b.certainty === 'observed' ? 0 : b.certainty === 'candidate' ? 1 : 2)).slice(0, 12);
  const refs = new Set(signals.flatMap(signal => signal.baseline_refs));
  const evidenceIds = new Set(signals.flatMap(signal => signal.evidence_ids));
  const allEvidence = state.evidence.filter(event => evidenceIds.has(event.id));
  const baseline = state.baseline;
  const paths = new Set([
    ...baseline.constraints.filter(rule => refs.has(rule.id)).flatMap(rule => rule.path ? [rule.path] : []),
    ...baseline.acceptance.filter(check => refs.has(check.id)).flatMap(check => check.scope_paths ?? baseline.relevant_files),
  ]);
  let omitted_file_observations = 0;
  const evidence = allEvidence.slice(-20).map(event => {
    if (event.kind !== 'file_snapshot') return structuredClone(event);
    const files = event.files.filter(file => paths.has(file.path)).slice(0, 50);
    omitted_file_observations += event.files.length - files.length;
    return { ...structuredClone(event), files };
  });
  return {
    schema_version: 1, purpose: 'selective-human-review', shadow: true,
    baseline: { baseline_id: baseline.baseline_id, session_id: baseline.session_id, workspace: baseline.workspace, source: baseline.source, goal: baseline.goal, next_step: baseline.next_step, constraints: baseline.constraints.filter(rule => refs.has(rule.id)), acceptance: baseline.acceptance.filter(check => refs.has(check.id)) },
    signals, evidence, feedback: state.feedback.filter(item => item.signal_id && signals.some(signal => signal.id === item.signal_id)).slice(-20),
    questions: [
      'Does the original user baseline still apply, or did the user explicitly change it?',
      'Do these specific observations actually contradict the referenced requirement, or is the apparent deviation intentional?',
      'What targeted verification or next step would resolve the uncertainty without rereading the entire conversation?',
      'Label reviewed alerts true-positive, false-positive, or uncertain; record missed-anomaly for an unflagged issue.',
    ],
    omitted_evidence_count: allEvidence.length - evidence.length,
    omitted_signal_count: report.signals.length - signals.length,
    omitted_file_observations,
  };
}

export function addDriftFeedback(input: DriftState, feedback: { signalId?: string; verdict: FeedbackVerdict; note: string; observedAt?: string; evidenceIds?: string[] }, options: DriftOptions = {}): DriftState {
  const verdict = member(feedback.verdict, ['true-positive', 'false-positive', 'uncertain', 'missed-anomaly'] as const, 'feedback verdict');
  if (input.feedback.length >= MAX_FEEDBACK) throw new Error('Drift feedback store is full; preserve/archive it before adding more');
  const observed_at = date(feedback.observedAt ?? options.now ?? new Date(), 'Feedback observation time');
  const signal_id = feedback.signalId ?? null;
  if (!signal_id && verdict !== 'missed-anomaly') throw new Error('Alert feedback requires an explicit signalId');
  if (signal_id && ![...(input.signal_history ?? []), ...evaluateDrift(input, { ...options, now: observed_at }).signals].some(signal => signal.id === signal_id)) throw new Error('Feedback signal is not present in this baseline assessment; retain the original evidence or record a missed anomaly');
  const evidence_ids = feedback.evidenceIds ?? [];
  if (!Array.isArray(evidence_ids) || evidence_ids.length > 100 || evidence_ids.some(id => !input.evidence.some(event => event.id === id))) throw new Error('Feedback references unknown or excessive evidence IDs');
  const baseline = input.baseline;
  const value = { baseline_id: baseline.baseline_id, session_id: baseline.session_id, workspace: baseline.workspace, signal_id, verdict, note: text(feedback.note, 'Feedback note'), observed_at, evidence_ids: [...new Set(evidence_ids)] };
  const id = digest(value);
  const state = structuredClone(input);
  if (!state.feedback.some(item => item.id === id)) state.feedback.push({ ...value, id });
  return state;
}

/** Canonical argv digest shared with the explicit shell=false verification runner. */
export function hashCommand(argv: string[]): string { return digest(argv); }

/** Record emitted signals before persisting, so feedback remains linked after resolution. */
export function recordDriftAssessment(input: DriftState, options: DriftOptions = {}): { state: DriftState; report: DriftReport } {
  const report = evaluateDrift(input, options);
  const state = structuredClone(input);
  const history = new Map((state.signal_history ?? []).map(signal => [signal.id, signal]));
  for (const signal of report.signals) history.set(signal.id, signal);
  state.signal_history = [...history.values()].slice(-1000);
  return { state, report };
}
