#!/usr/bin/env node
// A deliberately small, dependency-free GitHub Pages build. Only public website
// assets are copied; repository files and runtime handoff state are never bundled.
import { copyFile, mkdir, writeFile, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(root, 'website');
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== '--out-dir')) {
  console.error('Usage: node scripts/build-site.mjs [--out-dir DIRECTORY]');
  process.exit(1);
}
const output = path.resolve(args[1] || path.join(root, 'site-dist'));
if (output === source || output === root || source.startsWith(`${output}${path.sep}`)) {
  console.error('Refusing to write the website into its source or repository root.');
  process.exit(1);
}
const assets = ['index.html', 'styles.css', 'script.js', 'favicon.svg'];
await mkdir(output, { recursive: true });
if ((await lstat(output)).isSymbolicLink()) throw new Error('The output directory cannot be a symbolic link.');
for (const entry of await readdir(output)) {
  if (![...assets, '.nojekyll'].includes(entry) || !(await lstat(path.join(output, entry))).isFile()) {
    throw new Error(`Unexpected entry in website output: ${entry}. Choose a clean output directory.`);
  }
}
for (const asset of assets) {
  await copyFile(path.join(source, asset), path.join(output, asset));
}
await writeFile(path.join(output, '.nojekyll'), '');
console.log(`Built GitHub Pages website: ${output}`);
