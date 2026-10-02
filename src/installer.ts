import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { atomicWrite, digest, directory, readFile, readJson, UserError } from './storage.ts';

const bundle = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills');
const marker = '.auto-handoff-install.json';
function target(scope: string, cwd: string): string {
  if (scope === 'user') return path.join(os.homedir(), '.agents', 'skills');
  if (scope === 'project') return path.join(directory(cwd), '.agents', 'skills');
  throw new UserError('Install scope must be user or project.');
}
function checkAncestors(file: string) {
  let current = file;
  while (true) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new UserError('Refusing to install through a symbolic-link directory.');
    if (current === path.dirname(current)) break;
    current = path.dirname(current);
  }
}
function bundledFiles(dir: string, prefix = ''): Record<string, Buffer> {
  const result: Record<string, Buffer> = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new UserError('Bundled skill contains an unsupported symbolic link.');
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(result, bundledFiles(path.join(dir, entry.name), relative));
    else if (entry.isFile()) result[relative] = readFile(path.join(dir, entry.name));
  }
  return result;
}
export function installSkill(scope: string, cwd: string, legacyAlias = false) {
  const root = target(scope, cwd); checkAncestors(root);
  const names = legacyAlias ? ['auto-handoff', 'auto-handooff'] : ['auto-handoff'];
  const plans = names.map(name => ({ name, dir: path.join(root, name), files: bundledFiles(path.join(bundle, name)) }));
  for (const plan of plans) {
    checkAncestors(plan.dir);
    if (!fs.existsSync(plan.dir)) continue;
    if (!fs.existsSync(path.join(plan.dir, marker))) throw new UserError(`Skill directory already exists and is not managed by this installer: ${plan.dir}`);
    const installed = readJson(path.join(plan.dir, marker));
    const hashes = Object.fromEntries(Object.entries(plan.files).map(([file, data]) => [file, digest(data)]));
    if (JSON.stringify(installed.files) !== JSON.stringify(hashes)) throw new UserError(`Installed skill differs from this bundle; review and uninstall before updating: ${plan.dir}`);
    for (const [file, hash] of Object.entries(hashes)) if (digest(readFile(path.join(plan.dir, file))) !== hash) throw new UserError(`Existing skill contains user edits; refusing to overwrite: ${plan.dir}`);
  }
  fs.mkdirSync(root, { recursive: true });
  const installed: string[] = [];
  for (const plan of plans) {
    if (fs.existsSync(plan.dir)) { installed.push(plan.dir); continue; }
    const staging = path.join(root, `.auto-handoff-install-${crypto.randomUUID()}`);
    fs.mkdirSync(staging);
    try {
      const hashes: Record<string, string> = {};
      for (const [file, data] of Object.entries(plan.files)) {
        const destination = path.join(staging, file);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, data, { flag: 'wx', mode: 0o644 }); hashes[file] = digest(data);
      }
      atomicWrite(path.join(staging, marker), { schema_version: 1, name: plan.name, files: hashes });
      fs.renameSync(staging, plan.dir); installed.push(plan.dir);
    } finally { if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true }); }
  }
  return { installed, note: 'Reload Codex skill discovery or start a new session. Invoke $auto-handoff; a bare /auto-handoff is not a registered Codex command.' };
}
export function uninstallSkill(scope: string, cwd: string, legacyAlias = false) {
  const root = target(scope, cwd); checkAncestors(root);
  const removed: string[] = [], preserved: string[] = [];
  for (const name of legacyAlias ? ['auto-handoff', 'auto-handooff'] : ['auto-handoff']) {
    const dir = path.join(root, name); checkAncestors(dir); const manifestFile = path.join(dir, marker);
    if (!fs.existsSync(dir)) continue;
    if (!fs.existsSync(manifestFile)) { preserved.push(dir); continue; }
    const manifest = readJson(manifestFile);
    if (manifest.schema_version !== 1 || manifest.name !== name || !manifest.files || typeof manifest.files !== 'object') throw new UserError('Invalid installation manifest.');
    let modified = false;
    for (const [file, hash] of Object.entries(manifest.files)) {
      const destination = path.resolve(dir, file), relative = path.relative(dir, destination);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new UserError('Invalid path in installation manifest.');
      if (!fs.existsSync(destination)) continue;
      checkAncestors(path.dirname(destination));
      if (fs.lstatSync(destination).isSymbolicLink() || digest(readFile(destination)) !== hash) { preserved.push(destination); modified = true; }
      else { fs.unlinkSync(destination); removed.push(destination); }
    }
    if (!modified) { fs.unlinkSync(manifestFile); removed.push(manifestFile); }
    const directories = [...new Set(Object.keys(manifest.files).map(file => path.dirname(path.resolve(dir, file))))].sort((a, b) => b.length - a.length);
    for (let folder of directories) {
      while (folder.startsWith(dir) && fs.existsSync(folder) && fs.readdirSync(folder).length === 0) {
        fs.rmdirSync(folder); if (folder === dir) break; folder = path.dirname(folder);
      }
    }
    if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  }
  return { removed, preserved, note: 'User edits, unmanaged files, runtime packets, and Codex configuration are preserved.' };
}
