import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const VERSION = '0.2.0';
export class UserError extends Error {}
export const digest = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex');
export const now = () => new Date().toISOString();
export function requireText(value: unknown, name: string, max = 16000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) {
    throw new UserError(`${name} must be nonempty text, at most ${max} characters, without NUL.`);
  }
  return value;
}
export function profileName(value: unknown): string {
  const text = requireText(value, 'Profile', 64);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(text)) throw new UserError('Profile must start with a letter or digit and contain only letters, digits, dot, underscore, or hyphen.');
  return text;
}
export function sessionId(value: unknown): string {
  const text = requireText(value, 'Session ID', 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(text)) throw new UserError('Invalid session ID.');
  return text;
}
export function directory(value: string): string {
  try {
    const result = fs.realpathSync(path.resolve(value));
    if (!fs.statSync(result).isDirectory()) throw new Error();
    return result;
  } catch { throw new UserError('Working directory must exist and be a directory.'); }
}
export function assertNoSymlinks(file: string): void {
  const absolute = path.resolve(file);
  let current = path.parse(absolute).root;
  for (const component of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new UserError('Refusing a symbolic-link path component.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
export function readFile(file: string, max = 256 * 1024): Buffer {
  assertNoSymlinks(file);
  let fd: number | undefined;
  try {
    if (fs.lstatSync(file).isSymbolicLink()) throw new UserError(`Refusing a symbolic-link input: ${path.basename(file)}`);
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new UserError('Input must be a regular file.');
    if (stat.size > max) throw new UserError(`Input exceeds the ${max}-byte limit.`);
    const data = Buffer.alloc(max + 1);
    const size = fs.readSync(fd, data, 0, max + 1, 0);
    if (size > max) throw new UserError(`Input exceeds the ${max}-byte limit.`);
    return data.subarray(0, size);
  } catch (error) {
    if (error instanceof UserError) throw error;
    throw new UserError(`Cannot read ${path.basename(file)}.`);
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
export function readJson(file: string, max = 256 * 1024): any {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readFile(file, max))); }
  catch (error) { if (error instanceof UserError) throw error; throw new UserError(`Invalid UTF-8 JSON: ${path.basename(file)}.`); }
}
export function privateDir(dir: string): void {
  assertNoSymlinks(dir);
  if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) throw new UserError('State directory must not be a symbolic link.');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  assertNoSymlinks(dir);
  // This applies only to tool-owned directories, never a user's working directory.
  if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
}
export function atomicWrite(file: string, value: unknown): void {
  assertNoSymlinks(file);
  const content = Buffer.isBuffer(value) ? value : typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n';
  const tmp = path.join(path.dirname(file), `.tmp-${crypto.randomUUID()}`);
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try { fs.writeFileSync(fd, content, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}
export function stateRoot(explicit?: string): string {
  const xdg = process.env.XDG_STATE_HOME;
  const root = explicit ?? path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), '.local', 'state'), 'auto-handoff');
  return path.resolve(root);
}
export function sessionDir(root: string, session: string, cwd: string): string {
  sessionId(session);
  return path.join(root, 'sessions', digest(`${session}\0${cwd}`));
}
export function codexHome(): string { return path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex')); }
export async function withLock<T>(dir: string, fn: () => Promise<T>, name = 'handoff.lock', waitMs = 0): Promise<T> {
  privateDir(dir);
  const file = path.join(dir, name);
  let fd: number;
  const deadline = Date.now() + waitMs;
  while (true) {
    try { fd = fs.openSync(file, 'wx', 0o600); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST' && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 25)); continue; }
      throw new UserError('A tool operation lock already exists or cannot be created. Inspect recorded operations before removing a stale lock; never retry an uncertain launch blindly.');
    }
  }
  fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, created_at: now() }));
  fs.closeSync(fd);
  return fn().finally(() => fs.unlinkSync(file));
}
