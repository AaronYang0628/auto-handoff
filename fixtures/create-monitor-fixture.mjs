#!/usr/bin/env node
// Synthetic data only. Creates a new file; never overwrites a supplied path.
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const [output, workspace] = process.argv.slice(2);
if (!output || !workspace || process.argv.length !== 4) {
  console.error('Usage: node fixtures/create-monitor-fixture.mjs OUTPUT_JSONL WORKSPACE');
  process.exit(2);
}
const cwd = resolve(workspace);
const session = 'synthetic-monitor-session';
const timestamp = new Date().toISOString();
const records = [
  { timestamp, type: 'session_meta', payload: { id: session, cwd } },
  { timestamp, type: 'turn_context', payload: { cwd, model: 'synthetic-requested-model' } },
  { timestamp, type: 'event_msg', payload: { type: 'token_count', info: {
    total_token_usage: { total_tokens: 9_000_000, cached_input_tokens: 1_000_000 },
    last_token_usage: { total_tokens: 75_000 },
    model_context_window: 100_000,
  } } },
];
await writeFile(resolve(output), `${records.map(record => JSON.stringify(record)).join('\n')}\n`, { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ fixture: resolve(output), session_id: session, cwd, synthetic: true }, null, 2));
