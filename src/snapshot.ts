import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertNoSymlinks, digest, directory, readFile, UserError } from './storage.ts';

export function git(cwd: string, args: string[]): { code: number; text: string; unavailable: boolean } {
  const result = spawnSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-C', cwd, ...args], {
    encoding: 'utf8', shell: false, timeout: 10000, maxBuffer: 256 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
  });
  return { code: result.status ?? -1, text: result.stdout || '', unavailable: !!result.error };
}
export function validateStateLocation(root: string): void {
  assertNoSymlinks(root);
  if (path.resolve(root).split(path.sep).some(part => ['.git', '.codex', '.ssh', '.aws'].includes(part))) throw new UserError('Runtime state must not be stored in repository, session, or credential internals.');
  let ancestor = root;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const repoResult = git(ancestor, ['rev-parse', '--show-toplevel']);
  if (repoResult.code === 0) {
    const repo = repoResult.text.replace(/\r?\n$/, '');
    const fromRepo = path.relative(repo, root);
    if (!fromRepo) throw new UserError('State directory must not be the Git repository root.');
    const relative = fromRepo + path.sep;
    if (fromRepo !== '..' && !fromRepo.startsWith(`..${path.sep}`) && !path.isAbsolute(fromRepo)) {
      if (git(repo, ['check-ignore', '-q', '--', relative]).code !== 0) {
        throw new UserError('State is inside a Git repository but not ignored. Choose an external state directory or explicitly ignore it first.');
      }
    }
  }
}
export function safeFile(cwd: string, name: string): string {
  if (path.isAbsolute(name) || name.includes('\0')) throw new UserError('Important file paths must be relative to the working directory.');
  const file = path.resolve(cwd, name);
  const relative = path.relative(cwd, file);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new UserError('Important file is outside the working directory.');
  const pieces = relative.split(path.sep);
  if (pieces.some(piece => ['.git', '.codex', '.aws', '.ssh', '.gnupg', '.kube'].includes(piece)) || pieces.some(piece => /^\.env(?:\.|$)/i.test(piece) && !['.env.example', '.env.sample', '.env.template'].includes(piece)) || pieces.some(piece => /^(\.npmrc|\.netrc|_netrc|\.pypirc|\.git-credentials|auth\.json|credentials(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:pem|p12|pfx|key))$/i.test(piece))) throw new UserError('Important files must not reference authentication, credential, private-key, Git, or Codex storage paths.');
  assertNoSymlinks(file);
  if (fs.existsSync(file)) {
    const actual = fs.realpathSync(file);
    const actualRelative = path.relative(cwd, actual);
    if (actualRelative === '..' || actualRelative.startsWith(`..${path.sep}`) || actualRelative !== relative) throw new UserError('Important file must not traverse symbolic links.');
  }
  return file;
}
export function snapshot(cwd: string, importantFiles: string[]) {
  cwd = directory(cwd);
  const metadata: Record<string, unknown> = {};
  const commands: Record<string, string[]> = {
    branch: ['symbolic-ref', '--short', '-q', 'HEAD'],
    head: ['rev-parse', '--verify', 'HEAD'],
    status: ['status', '--short', '--branch', '--untracked-files=normal'],
    unstaged_stat: ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--stat'],
    staged_stat: ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--no-renames', '--stat'],
  };
  for (const [key, args] of Object.entries(commands)) {
    const result = git(cwd, args);
    // No full diffs, file contents, remote URLs, or arbitrary Git config are saved.
    metadata[key] = { available: result.code === 0 && !result.unavailable, value: result.text.slice(0, 16000), truncated: result.text.length > 16000 };
  }
  const files: Record<string, unknown> = Object.create(null);
  for (const name of importantFiles) {
    const file = safeFile(cwd, name);
    if (!fs.existsSync(file)) files[name] = { exists: false };
    else {
      const data = readFile(file, 10 * 1024 * 1024);
      files[name] = { exists: true, bytes: data.length, sha256: digest(data) };
    }
  }
  const value = { cwd, git: metadata, files };
  return { ...value, fingerprint: digest(JSON.stringify(value)) };
}
