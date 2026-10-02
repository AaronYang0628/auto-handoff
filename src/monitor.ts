import { createHash, randomUUID } from 'node:crypto';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

/** These adapters describe tested fixture contracts, not all Codex versions. */
export type MonitorAdapter = 'codex-rollout-v1-partial' | 'csm-jsonl-v1';
export type Availability = 'available' | 'estimated' | 'unknown' | 'stale';
export type RecommendationState = 'continue' | 'checkpoint' | 'review' | 'handoff_suggested' | 'insufficient_data';
export type MarkKind = 'constraint-violation' | 'repetition' | 'phase-complete';
export interface Evidence {
  adapter: MonitorAdapter | 'manual';
  path: string | null;
  file_id: string | null;
  generation: number;
  byte_offset: number | null;
  line: number | null;
  record_hash: string;
}
export interface NormalizedEvent {
  schema_version: 1;
  event_id: string;
  observed_at: string;
  recorded_at: string | null;
  session_id: string;
  turn_id: string | null;
  workspace: string;
  source: Evidence;
  kind: 'source_identity' | 'context_usage' | 'compaction' | 'action' | 'manual_mark' | 'model';
  payload: Record<string, unknown>;
}
export interface Metric<T = number> {
  value: T | null;
  unit: string;
  observed_at: string | null;
  source: Evidence | null;
  measurement_method: string;
  availability: Availability;
  missing_reason: string | null;
}
export interface RuleOptions {
  checkpointPercent?: number;
  handoffPercent?: number;
  repetitionCount?: number;
  cooldownMs?: number;
}
export interface MonitorOptions {
  now?: string | Date;
  staleAfterMs?: number;
  rules?: RuleOptions;
}
export interface MonitorStatus {
  schema_version: 1;
  session_id: string;
  workspace: string;
  source_path: string | null;
  adapter: MonitorAdapter;
  source_verified: boolean;
  last_poll_at: string | null;
  pending_bytes: number;
  metrics: {
    context_occupancy_percent: Metric;
    last_context_tokens: Metric;
    context_window_tokens: Metric;
    cumulative_tokens: Metric;
    cumulative_cached_tokens: Metric;
    compactions: Metric;
    requested_model: Metric<string>;
    reported_model: Metric<string>;
  };
  recommendation: {
    state: RecommendationState;
    rules_version: 'csm-rules-v1';
    heuristic: true;
    reasons: string[];
    evidence: Evidence[];
    fingerprint: string;
    notify: boolean;
    suppressed_reason: string | null;
  };
  diagnostics: { code: string; message: string; line?: number }[];
  limitations: string[];
}
export interface MonitorState {
  schema_version: 1;
  binding: { session_id: string; workspace: string; source_path: string | null; adapter: MonitorAdapter };
  cursor: {
    file_id: string | null;
    generation: number;
    offset: number;
    pending_bytes: number;
    line: number;
    anchor_hash: string | null;
    anchor_length: number;
    prefix_hash: string | null;
    prefix_length: number;
  };
  identity_verified: boolean;
  seen_event_ids: string[];
  events: NormalizedEvent[];
  diagnostics: MonitorStatus['diagnostics'];
  last_poll_at: string | null;
  last_notice: { fingerprint: string; at: string } | null;
}
export interface ManualMark {
  kind: MarkKind;
  constraintId?: string;
  note?: string;
  eventId?: string;
  at?: string;
}

const MAX_READ_BYTES = 8 * 1024 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_EVENTS = 2000;
const MAX_SEEN = 20000;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const object = (value: unknown): Record<string, any> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const string = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
function time(value: unknown): string | null {
  if (typeof value !== 'string' && !(value instanceof Date)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function nowOf(options: MonitorOptions): string {
  const now = time(options.now ?? new Date());
  if (!now) throw new Error('Invalid monitor observation time');
  return now;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value as object).sort().map(key => `${JSON.stringify(key)}:${canonical((value as any)[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
function diagnostic(state: MonitorState, code: string, message: string, line?: number) {
  state.diagnostics.push({ code, message, ...(line === undefined ? {} : { line }) });
  state.diagnostics = state.diagnostics.slice(-100);
}
export class MonitorSourceError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'MonitorSourceError';
    this.code = code;
  }
}

function assertSafeSourcePath(sourcePath: string): void {
  const parts = resolve(sourcePath).split(/[\\/]+/).map(part => part.toLowerCase());
  const name = parts.at(-1) ?? '';
  const environmentFile = /^\.env(?:\.|$)/.test(name) && !/\.(?:example|sample|template)$/.test(name);
  if (parts.includes('.ssh') || parts.includes('.aws') || environmentFile ||
      ['.npmrc', '.netrc', '.git-credentials', 'auth.json'].includes(name) || name.startsWith('credentials')) {
    throw new MonitorSourceError('credential_source', 'Monitoring refuses authentication or credential source paths; select an explicit session event file');
  }
}

export function createMonitorState(input: { sessionId: string; cwd: string; sourcePath?: string; adapter?: MonitorAdapter }): MonitorState {
  if (!string(input.sessionId) || !string(input.cwd)) throw new Error('Monitoring requires explicit sessionId and cwd');
  if (input.sourcePath) assertSafeSourcePath(input.sourcePath);
  const adapter = input.adapter ?? 'codex-rollout-v1-partial';
  if (!['codex-rollout-v1-partial', 'csm-jsonl-v1'].includes(adapter)) throw new Error('Unsupported monitor adapter');
  return {
    schema_version: 1,
    binding: { session_id: input.sessionId, workspace: resolve(input.cwd), source_path: input.sourcePath ? resolve(input.sourcePath) : null, adapter },
    cursor: { file_id: null, generation: 0, offset: 0, pending_bytes: 0, line: 0, anchor_hash: null, anchor_length: 0, prefix_hash: null, prefix_length: 0 },
    identity_verified: false, seen_event_ids: [], events: [], diagnostics: [], last_poll_at: null, last_notice: null,
  };
}

function assertIdentity(state: MonitorState, session: unknown, cwd: unknown, required = false) {
  if (required && (!string(session) || !string(cwd))) throw new MonitorSourceError('missing_identity', 'Source metadata must contain both session ID and absolute cwd');
  if (session !== undefined && session !== state.binding.session_id) throw new MonitorSourceError('session_mismatch', 'Source session ID does not match the explicitly bound session');
  if (cwd !== undefined && (!string(cwd) || !isAbsolute(cwd) || resolve(cwd) !== state.binding.workspace)) throw new MonitorSourceError('workspace_mismatch', 'Source cwd does not match the explicitly bound workspace');
}
function eventFor(state: MonitorState, raw: Record<string, any>, evidence: Evidence, now: string, kind: NormalizedEvent['kind'], payload: Record<string, unknown>): NormalizedEvent {
  return {
    schema_version: 1,
    event_id: hash(`${state.binding.session_id}:${string(raw.event_id) ? `id:${raw.event_id}` : `record:${evidence.record_hash}`}`),
    observed_at: now, recorded_at: time(raw.timestamp ?? raw.observed_at), session_id: state.binding.session_id,
    turn_id: string(raw.turn_id ?? raw.payload?.turn_id) ? raw.turn_id ?? raw.payload.turn_id : null,
    workspace: state.binding.workspace, source: evidence, kind, payload,
  };
}
function normalize(state: MonitorState, raw: Record<string, any>, evidence: Evidence, now: string): NormalizedEvent | null {
  const adapter = state.binding.adapter;
  const payload = object(raw.payload) ?? {};
  if (adapter === 'csm-jsonl-v1' && raw.schema_version !== 1) {
    throw new MonitorSourceError('unsupported_schema', 'csm-jsonl-v1 requires schema_version: 1 on every record');
  }
  const metadata = raw.type === 'session_meta';
  const session = metadata && adapter === 'codex-rollout-v1-partial' ? payload.id : raw.session_id ?? payload.session_id;
  const cwd = metadata && adapter === 'codex-rollout-v1-partial' ? payload.cwd : raw.cwd ?? raw.workspace ?? payload.cwd;
  assertIdentity(state, session, cwd, metadata);
  if (metadata) {
    state.identity_verified = true;
    return eventFor(state, raw, evidence, now, 'source_identity', { session_id: session, workspace: resolve(cwd) });
  }
  if (!state.identity_verified) throw new MonitorSourceError('missing_identity', 'Read-only source must begin with matching session_meta before event records');
  if (adapter === 'codex-rollout-v1-partial') {
    if (raw.type === 'event_msg' && payload.type === 'token_count') {
      const info = object(payload.info) ?? {};
      const last = object(info.last_token_usage) ?? {};
      const total = object(info.total_token_usage) ?? {};
      return eventFor(state, raw, evidence, now, 'context_usage', {
        // A last request's tokens are an estimate, never proof of current live occupancy.
        context_tokens: finite(last.total_tokens) ? last.total_tokens : null,
        context_window_tokens: finite(info.model_context_window) && info.model_context_window > 0 ? info.model_context_window : null,
        cumulative_tokens: finite(total.total_tokens) ? total.total_tokens : null,
        cumulative_cached_tokens: finite(total.cached_input_tokens) ? total.cached_input_tokens : null,
        context_method: 'last_request_tokens_div_model_window', context_availability: 'estimated',
      });
    }
    // These variants are supported by synthetic fixtures only. Unknown variants stay unknown.
    if (raw.type === 'compacted' || (raw.type === 'event_msg' && payload.type === 'context_compacted')) {
      return eventFor(state, raw, evidence, now, 'compaction', { detection_method: 'partial_rollout_fixture_shape' });
    }
    if (raw.type === 'turn_context' && string(payload.model)) return eventFor(state, raw, evidence, now, 'model', { requested_model: payload.model, reported_model: null });
    return null;
  }
  if (raw.type === 'context_usage') {
    const verified = payload.measurement_method === 'runtime_reported_context';
    return eventFor(state, raw, evidence, now, 'context_usage', {
      context_tokens: finite(payload.context_tokens) ? payload.context_tokens : null,
      context_window_tokens: finite(payload.context_window_tokens) && payload.context_window_tokens > 0 ? payload.context_window_tokens : null,
      cumulative_tokens: finite(payload.cumulative_tokens) ? payload.cumulative_tokens : null,
      cumulative_cached_tokens: finite(payload.cumulative_cached_tokens) ? payload.cumulative_cached_tokens : null,
      context_method: verified ? 'explicit_adapter_runtime_reported_context' : 'unverified_context_semantics',
      context_availability: verified ? 'available' : 'unknown',
    });
  }
  if (raw.type === 'compaction') return eventFor(state, raw, evidence, now, 'compaction', { detection_method: 'explicit_adapter_event' });
  if (raw.type === 'model') return eventFor(state, raw, evidence, now, 'model', {
    requested_model: string(payload.requested_model) ? payload.requested_model : null,
    reported_model: string(payload.reported_model) ? payload.reported_model : null,
  });
  if (raw.type === 'action') {
    // This contract requires caller-provided state/evidence. Raw tool calls are insufficient.
    const complete = string(payload.action) && payload.arguments !== undefined && payload.result !== undefined && string(payload.file_snapshot) && string(payload.evidence_revision);
    return eventFor(state, raw, evidence, now, 'action', {
      action: string(payload.action) ? payload.action.slice(0, 256) : null,
      signature: complete ? hash(canonical({ action: payload.action, arguments: payload.arguments, result: payload.result, file_snapshot: payload.file_snapshot, evidence_revision: payload.evidence_revision })) : null,
      file_snapshot: string(payload.file_snapshot) ? hash(payload.file_snapshot) : null,
      expected_polling: payload.expected_polling === true,
      new_evidence: payload.new_evidence === true,
      eligible: Boolean(complete && payload.expected_polling === false && payload.new_evidence === false),
    });
  }
  return null;
}

function appendEvent(state: MonitorState, event: NormalizedEvent): boolean {
  if (state.seen_event_ids.includes(event.event_id)) return false;
  state.seen_event_ids.push(event.event_id);
  state.seen_event_ids = state.seen_event_ids.slice(-MAX_SEEN);
  state.events.push(event);
  state.events = state.events.slice(-MAX_EVENTS);
  return true;
}

/** Reads only the explicitly supplied file. No filesystem discovery and no writes to source. */
export async function pollMonitor(input: MonitorState, options: MonitorOptions = {}): Promise<{ state: MonitorState; events: NormalizedEvent[]; status: MonitorStatus }> {
  const state: MonitorState = structuredClone(input);
  const now = nowOf(options);
  const events: NormalizedEvent[] = [];
  if (!state.binding.source_path) return finishPoll(state, events, now, options);
  assertSafeSourcePath(state.binding.source_path);
  assertSafeSourcePath(await realpath(state.binding.source_path));
  const handle = await open(state.binding.source_path, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new MonitorSourceError('not_regular_file', 'Monitoring source must be an explicitly selected regular file');
    const fileId = `${stat.dev}:${stat.ino}`;
    let reset = state.cursor.file_id !== fileId || stat.size < state.cursor.offset;
    if (!reset && state.cursor.prefix_hash && state.cursor.prefix_length > 0) {
      const prefix = Buffer.alloc(state.cursor.prefix_length);
      const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
      reset = bytesRead !== prefix.length || hash(prefix) !== state.cursor.prefix_hash;
    }
    if (!reset && state.cursor.anchor_hash && state.cursor.anchor_length > 0) {
      const anchor = Buffer.alloc(state.cursor.anchor_length);
      const { bytesRead } = await handle.read(anchor, 0, anchor.length, state.cursor.offset - anchor.length);
      reset = bytesRead !== anchor.length || hash(anchor) !== state.cursor.anchor_hash;
    }
    if (reset) {
      if (state.cursor.file_id !== null) diagnostic(state, 'source_rotated', 'Source was replaced, truncated, or rewritten; identity must be verified again');
      state.cursor = { file_id: fileId, generation: state.cursor.generation + 1, offset: 0, pending_bytes: 0, line: 0, anchor_hash: null, anchor_length: 0, prefix_hash: null, prefix_length: 0 };
      state.identity_verified = false;
    }
    const length = Math.min(Math.max(0, stat.size - state.cursor.offset), MAX_READ_BYTES);
    const chunk = Buffer.alloc(length);
    const { bytesRead } = await handle.read(chunk, 0, length, state.cursor.offset);
    // Persist only the committed byte offset, never raw partial log contents.
    // Incomplete bytes are reread from this explicit file on the next poll.
    const baseOffset = state.cursor.offset;
    const data = chunk.subarray(0, bytesRead);
    let start = 0;
    let newline: number;
    while ((newline = data.indexOf(10, start)) !== -1) {
      state.cursor.line += 1;
      let line = data.subarray(start, newline);
      const byteOffset = baseOffset + start;
      start = newline + 1;
      if (line.at(-1) === 13) line = line.subarray(0, -1);
      if (!line.length) continue;
      if (line.length > MAX_LINE_BYTES) throw new MonitorSourceError('oversized_record', 'Source contains a record larger than 1 MiB');
      let raw: Record<string, any> | null;
      try { raw = object(JSON.parse(line.toString('utf8'))); }
      catch {
        diagnostic(state, 'malformed_record', 'Skipped malformed complete JSONL record; raw contents were not retained', state.cursor.line);
        continue;
      }
      if (!raw) { diagnostic(state, 'unsupported_record', 'Skipped non-object JSONL record', state.cursor.line); continue; }
      const evidence: Evidence = { adapter: state.binding.adapter, path: state.binding.source_path, file_id: fileId, generation: state.cursor.generation, byte_offset: byteOffset, line: state.cursor.line, record_hash: hash(canonical(raw)) };
      const event = normalize(state, raw, evidence, now);
      if (event && appendEvent(state, event)) events.push(event);
    }
    const remainder = data.subarray(start);
    if (remainder.length > MAX_LINE_BYTES) throw new MonitorSourceError('oversized_record', 'Unterminated source record exceeds 1 MiB');
    state.cursor.offset = baseOffset + start;
    state.cursor.pending_bytes = remainder.length;
    state.cursor.anchor_length = Math.min(256, state.cursor.offset);
    const anchor = Buffer.alloc(state.cursor.anchor_length);
    await handle.read(anchor, 0, anchor.length, state.cursor.offset - anchor.length);
    state.cursor.anchor_hash = hash(anchor);
    state.cursor.prefix_length = Math.min(4096, state.cursor.offset);
    const prefix = Buffer.alloc(state.cursor.prefix_length);
    await handle.read(prefix, 0, prefix.length, 0);
    state.cursor.prefix_hash = hash(prefix);
    if (stat.size > baseOffset + bytesRead) diagnostic(state, 'source_backlog', 'Read batch capped at 8 MiB; subsequent polls continue from the saved byte offset');
  } finally { await handle.close(); }
  return finishPoll(state, events, now, options);
}

function finishPoll(state: MonitorState, events: NormalizedEvent[], now: string, options: MonitorOptions) {
  state.last_poll_at = now;
  const status = getMonitorStatus(state, { ...options, now });
  if (status.recommendation.notify) state.last_notice = { fingerprint: status.recommendation.fingerprint, at: now };
  return { state, events, status };
}

export function addManualMark(input: MonitorState, mark: ManualMark, options: MonitorOptions = {}): { state: MonitorState; event: NormalizedEvent; status: MonitorStatus } {
  if (!['constraint-violation', 'repetition', 'phase-complete'].includes(mark.kind)) throw new Error('Unknown manual mark kind');
  if (mark.kind === 'constraint-violation' && !string(mark.constraintId)) throw new Error('Constraint violation requires constraintId');
  const state: MonitorState = structuredClone(input);
  const now = nowOf(options);
  const at = time(mark.at ?? now);
  if (!at) throw new Error('Manual mark requires a valid observation time');
  const id = mark.eventId ?? randomUUID();
  const evidence: Evidence = { adapter: 'manual', path: null, file_id: null, generation: 0, byte_offset: null, line: null, record_hash: hash(id) };
  const event = eventFor(state, { event_id: id, timestamp: at }, evidence, now, 'manual_mark', {
    kind: mark.kind, constraint_id: mark.constraintId ?? null, note: mark.note?.slice(0, 2000) ?? null,
    detection_method: 'explicit_manual_mark',
  });
  appendEvent(state, event);
  const status = getMonitorStatus(state, { ...options, now });
  if (status.recommendation.notify) state.last_notice = { fingerprint: status.recommendation.fingerprint, at: now };
  return { state, event, status };
}

function metric<T>(value: T | null, unit: string, event: NormalizedEvent | undefined, method: string, availability: Availability, now: string, staleAfterMs: number, missing: string): Metric<T> {
  if (value === null || !event || availability === 'unknown') return { value: null, unit, observed_at: event?.recorded_at ?? null, source: event?.source ?? null, measurement_method: method, availability: 'unknown', missing_reason: missing };
  if (!event.recorded_at) return { value: null, unit, observed_at: null, source: event.source, measurement_method: method, availability: 'unknown', missing_reason: 'Source measurement timestamp is missing or invalid' };
  const age = Date.parse(now) - Date.parse(event.recorded_at);
  if (age < -60_000) return { value: null, unit, observed_at: event.recorded_at, source: event.source, measurement_method: method, availability: 'unknown', missing_reason: 'Source measurement timestamp is in the future' };
  return { value, unit, observed_at: event.recorded_at, source: event.source, measurement_method: method, availability: age > staleAfterMs ? 'stale' : availability, missing_reason: age > staleAfterMs ? 'Last observation is older than the configured freshness window' : null };
}

export function getMonitorStatus(state: MonitorState, options: MonitorOptions = {}): MonitorStatus {
  const now = nowOf(options);
  const staleAfterMs = options.staleAfterMs ?? 15 * 60_000;
  if (!Number.isFinite(staleAfterMs) || staleAfterMs < 0) throw new Error('staleAfterMs must be a nonnegative finite number');
  const checkpoint = options.rules?.checkpointPercent ?? 70;
  const handoff = options.rules?.handoffPercent ?? 85;
  const repetitions = options.rules?.repetitionCount ?? 3;
  const cooldown = options.rules?.cooldownMs ?? 5 * 60_000;
  if (!finite(checkpoint) || !finite(handoff) || checkpoint >= handoff || handoff > 100 || !Number.isInteger(repetitions) || repetitions < 2 || !finite(cooldown)) throw new Error('Invalid monitor rule thresholds');
  const last = (kind: NormalizedEvent['kind']) => state.events.findLast(event => event.kind === kind);
  const usage = state.identity_verified ? last('context_usage') : undefined;
  const payload = usage?.payload ?? {};
  const contextValue = finite(payload.context_tokens) ? payload.context_tokens : null;
  const windowValue = finite(payload.context_window_tokens) && payload.context_window_tokens > 0 ? payload.context_window_tokens : null;
  const usageIndex = usage ? state.events.indexOf(usage) : -1;
  const latestCompactionIndex = state.events.findLastIndex(event => event.kind === 'compaction');
  const supersededByCompaction = latestCompactionIndex > usageIndex;
  const contextAvailability = (supersededByCompaction ? 'unknown' : payload.context_availability ?? 'unknown') as Availability;
  const supersededReason = 'Latest context observation predates an observed compaction; wait for a new usage record';
  const contextMethod = String(payload.context_method ?? 'unavailable');
  const context = metric(contextValue, 'tokens', usage, contextMethod, contextAvailability, now, staleAfterMs, supersededByCompaction ? supersededReason : 'Verified context measurement is unavailable; cumulative tokens are not context occupancy');
  const occupancy = metric(contextValue !== null && windowValue !== null ? contextValue / windowValue * 100 : null, 'percent', usage, contextMethod, contextAvailability, now, staleAfterMs, supersededByCompaction ? supersededReason : 'Context amount or model window is missing or its semantics are unverified');
  const compactionEvents = state.identity_verified ? state.events.filter(event => event.kind === 'compaction') : [];
  const compaction = compactionEvents.at(-1);
  const model = state.identity_verified ? last('model') : undefined;
  const metrics: MonitorStatus['metrics'] = {
    context_occupancy_percent: occupancy,
    last_context_tokens: context,
    context_window_tokens: metric(windowValue, 'tokens', usage, 'source_reported_model_window', 'available', now, staleAfterMs, 'Source did not report a valid model context window'),
    cumulative_tokens: metric(finite(payload.cumulative_tokens) ? payload.cumulative_tokens : null, 'tokens', usage, 'source_reported_cumulative_tokens', 'available', now, staleAfterMs, 'Cumulative usage was not reported'),
    cumulative_cached_tokens: metric(finite(payload.cumulative_cached_tokens) ? payload.cumulative_cached_tokens : null, 'tokens', usage, 'source_reported_cumulative_cached_input_tokens', 'available', now, staleAfterMs, 'Cumulative cached usage was not reported; this is not billing data'),
    compactions: metric(compaction ? compactionEvents.length : null, 'observed_events_retained', compaction, 'deduplicated_observed_compaction_events', 'available', now, staleAfterMs, 'No verified compaction event was observed; absence is not proof of zero'),
    requested_model: metric<string>(string(model?.payload.requested_model) ? model!.payload.requested_model as string : null, 'model', model, 'source_reported_requested_model', 'available', now, staleAfterMs, 'Requested model was not reported'),
    reported_model: metric<string>(string(model?.payload.reported_model) ? model!.payload.reported_model as string : null, 'model', model, 'source_reported_actual_model', 'available', now, staleAfterMs, 'Actual model was not reported; requested model is not substituted'),
  };
  const fresh = (event: NormalizedEvent) => event.recorded_at !== null && Date.parse(now) - Date.parse(event.recorded_at) <= staleAfterMs && Date.parse(now) - Date.parse(event.recorded_at) >= -60_000;
  const recent = state.events.filter(event => fresh(event) && (event.source.adapter === 'manual' || state.identity_verified));
  const marks = recent.filter(event => event.kind === 'manual_mark');
  const violation = marks.findLast(event => event.payload.kind === 'constraint-violation');
  const manualRepetition = marks.findLast(event => event.payload.kind === 'repetition');
  const phase = marks.findLast(event => event.payload.kind === 'phase-complete');
  const actions = recent.filter(event => event.kind === 'action');
  const lastAction = actions.at(-1);
  const repeated: NormalizedEvent[] = [];
  if (lastAction?.payload.eligible && lastAction.payload.signature) {
    // A change of snapshot/evidence, expected polling, or new evidence breaks the run.
    for (let index = actions.length - 1; index >= 0; index--) {
      const action = actions[index];
      if (!action.payload.eligible || action.payload.signature !== lastAction.payload.signature) break;
      repeated.unshift(action);
    }
  }
  let recommendation: RecommendationState = 'insufficient_data';
  const reasons: string[] = [];
  const evidence: Evidence[] = [];
  if (violation || manualRepetition || repeated.length >= repetitions) {
    recommendation = 'review';
    if (violation) { reasons.push(`Explicit manual constraint violation: ${violation.payload.constraint_id}`); evidence.push(violation.source); }
    if (manualRepetition) { reasons.push('Explicit manual repetition mark needs review'); evidence.push(manualRepetition.source); }
    if (repeated.length >= repetitions) { reasons.push(`${repeated.length} equivalent actions with unchanged declared file/evidence state form a repetition candidate; no semantic failure is inferred`); evidence.push(...repeated.map(event => event.source)); }
  } else if (occupancy.value !== null && ['available', 'estimated'].includes(occupancy.availability)) {
    const label = occupancy.availability === 'estimated' ? 'Estimated last-request context occupancy' : 'Last reported context occupancy';
    recommendation = occupancy.value >= handoff ? 'handoff_suggested' : occupancy.value >= checkpoint || phase ? 'checkpoint' : 'continue';
    reasons.push(`${label} is ${occupancy.value.toFixed(1)}%; ${checkpoint}%/${handoff}% thresholds are configurable heuristics`);
    if (occupancy.source) evidence.push(occupancy.source);
  } else if (phase) {
    recommendation = 'checkpoint';
    reasons.push('A manually marked phase boundary is an opportunity to checkpoint; it is not evidence of quality decline');
    evidence.push(phase.source);
  }
  if (compaction && supersededByCompaction && fresh(compaction) && recommendation !== 'review') {
    if (recommendation === 'continue' || recommendation === 'insufficient_data') recommendation = 'review';
    reasons.push('A supported compaction-shaped event was observed; verify important state rather than infer degradation');
    evidence.push(compaction.source);
  }
  if (recommendation === 'insufficient_data') reasons.push(occupancy.availability === 'stale' ? 'Context observation is stale; no fresh usable signal supports a recommendation' : 'Current context occupancy is unknown; cumulative token use cannot substitute for it');
  if (phase && !evidence.includes(phase.source)) {
    reasons.push('A manual phase-complete marker identifies a possible checkpoint boundary');
    evidence.push(phase.source);
  }
  // Evidence for the decision is returned, but tiny metric changes do not cause new alerts.
  const fingerprint = hash(canonical({ recommendation, rule: 'csm-rules-v1', checkpoint, handoff, manual: marks.map(event => event.event_id), repetition: repeated.length >= repetitions ? lastAction?.payload.signature : null, compaction: compaction && supersededByCompaction && fresh(compaction) ? compaction.event_id : null }));
  const same = state.last_notice?.fingerprint === fingerprint;
  const cooling = state.last_notice !== null && Date.parse(now) - Date.parse(state.last_notice.at) < cooldown;
  const actionable = ['checkpoint', 'review', 'handoff_suggested'].includes(recommendation);
  return {
    schema_version: 1, session_id: state.binding.session_id, workspace: state.binding.workspace,
    source_path: state.binding.source_path, adapter: state.binding.adapter, source_verified: state.identity_verified,
    last_poll_at: state.last_poll_at, pending_bytes: state.cursor.pending_bytes, metrics,
    recommendation: { state: recommendation, rules_version: 'csm-rules-v1', heuristic: true, reasons, evidence, fingerprint, notify: actionable && !same && !cooling, suppressed_reason: same ? 'duplicate_recommendation' : cooling && actionable ? 'cooldown' : !actionable ? 'not_actionable' : null },
    diagnostics: [...state.diagnostics],
    limitations: [
      'Fixture-tested partial adapters; no promise of compatibility with every Codex version or live TUI.',
      'Last-request token/window ratio is an estimate of the last observed request, not verified current occupancy.',
      'No model intelligence, quality score, semantic constraint detection, billing calculation, or automatic handoff.',
      `Retains at most ${MAX_EVENTS} normalized events and ${MAX_SEEN} deduplication IDs; very old replay beyond that bound can be seen again.`,
      'Manual notes and normalized source evidence are local state; original message and tool payload text is not retained.',
    ],
  };
}
