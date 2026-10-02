import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';

const root = fileURLToPath(new URL('../', import.meta.url));
const website = path.join(root, 'website');
const html = fs.readFileSync(path.join(website, 'index.html'), 'utf8');
const script = fs.readFileSync(path.join(website, 'script.js'), 'utf8');
const css = fs.readFileSync(path.join(website, 'styles.css'), 'utf8');
const publicAssets = ['.nojekyll', 'favicon.svg', 'index.html', 'script.js', 'styles.css'];
const build = (output: string) => spawnSync(process.execPath, ['scripts/build-site.mjs', '--out-dir', output], { cwd: root, encoding: 'utf8' });

function temporary(t: any) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-handoff-site-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('Pages build contains only public assets, repeats safely, and supports a project subpath', t => {
  const output = path.join(temporary(t), 'output');
  assert.equal(build(output).status, 0);
  assert.deepEqual(fs.readdirSync(output).sort(), publicAssets);
  for (const file of publicAssets.filter(file => file !== '.nojekyll')) {
    assert.equal(fs.readFileSync(path.join(output, file), 'utf8'), fs.readFileSync(path.join(website, file), 'utf8'));
  }
  assert.equal(build(output).status, 0);
  for (const [, reference] of html.matchAll(/(?:href|src)="(\.\/[^"#]+)"/g)) {
    const resolved = new URL(reference, 'https://example.github.io/auto-handoff/');
    assert(resolved.pathname.startsWith('/auto-handoff/'));
    assert(fs.existsSync(path.join(output, reference)));
  }
});

test('Pages build refuses repository/source outputs and unexpected output files', t => {
  for (const output of [root, website, path.dirname(root)]) assert.notEqual(build(output).status, 0);
  const output = path.join(temporary(t), 'output');
  fs.mkdirSync(output);
  fs.writeFileSync(path.join(output, 'private-state.json'), '{"private":true}');
  const result = build(output);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unexpected entry/);
  assert.equal(fs.readFileSync(path.join(output, 'private-state.json'), 'utf8'), '{"private":true}');
});

test('Pages build refuses symlink outputs without touching their target', t => {
  if (process.platform === 'win32') return t.skip('Symlink privileges differ on Windows.');
  const directory = temporary(t);
  const target = path.join(directory, 'target');
  const output = path.join(directory, 'linked-output');
  fs.mkdirSync(target);
  fs.symlinkSync(target, output, 'dir');
  assert.notEqual(build(output).status, 0);
  assert.deepEqual(fs.readdirSync(target), []);
});

test('page anchors, assets, and linked repository documents resolve', () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  for (const [, reference] of html.matchAll(/\bhref="([^"]+)"/g)) {
    if (reference.startsWith('#') && reference !== '#') assert(ids.includes(reference.slice(1)), reference);
    if (reference.includes('/blob/main/')) {
      const relative = reference.split('/blob/main/')[1].split('#')[0];
      assert(fs.statSync(path.join(root, relative)).isFile(), reference);
    }
  }
  for (const [, target] of html.matchAll(/\bdata-copy="([^"]+)"/g)) assert(ids.includes(target));
  assert(!/(?:src|href)="\/(?!\/)/.test(html), 'Asset paths must work under /auto-handoff/.');
});

test('static page keeps runtime private and essential content usable without JavaScript', () => {
  assert(!/<script[^>]+src="https?:/i.test(html));
  assert(!/<link[^>]+(?:stylesheet|preconnect)[^>]+https?:/i.test(html));
  assert(!/\b(?:fetch|XMLHttpRequest|sendBeacon|WebSocket)\b/.test(script));
  assert.match(html, /<html lang="en"/);
  assert.match(html, /class="skip-link"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /id="language-toggle"[^>]* hidden/);
  assert.match(css, /prefers-reduced-motion:reduce/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /@media\(max-width:410px\)/);
  assert.equal((html.match(/data-locale="en"/g) || []).length, (html.match(/data-locale="zh"/g) || []).length);
  for (const text of ['npm ci', 'npm link', 'csm install --scope user', 'csm doctor', '$auto-handoff', 'YOUR_PROFILE', 'read-only', 'unknown', 'estimated', 'stale', 'remains unverified', 'have not been tested', 'may incur usage']) assert(html.includes(text), text);
  assert.match(html, /Illustrative flow/);
  assert(!html.includes('npm install -g auto-handoff'), 'No unpublished registry installation instructions.');
});

function browserHarness(options: { language?: string; storageBlocked?: boolean; clipboardUnavailable?: boolean; clipboardReject?: boolean } = {}) {
  const copied: string[] = [];
  const selected: string[] = [];
  const storage = new Map<string, string>([['auto-handoff-language', options.language || 'en']]);
  const timers = new Map<number, () => void>();
  let timerId = 0;
  const element = (text = '') => ({
    textContent: text, hidden: true, dataset: {} as Record<string, string>,
    attributes: {} as Record<string, string>, listeners: {} as Record<string, (...args: any[]) => any>, classes: new Set<string>(),
    setAttribute(name: string, value: string) { this.attributes[name] = value; },
    addEventListener(name: string, callback: (...args: any[]) => any) { this.listeners[name] = callback; },
    classList: { add(_name: string) {}, remove(_name: string) {} },
  });
  const languageButton = element('中文');
  const status = element();
  status.classList = { add(name: string) { status.classes.add(name); }, remove(name: string) { status.classes.delete(name); } };
  const nav = element();
  const visual = element();
  const code = new Map([...html.matchAll(/<code id="([^"]+)">([\s\S]*?)<\/code>/g)].map(match => [match[1], element(match[2])]));
  const buttons = [...code.keys()].map(id => { const button = element(); button.dataset.copy = id; return button; });
  const documentElement = { dataset: {} as Record<string, string>, lang: '' };
  const document = {
    documentElement,
    querySelector(selector: string) { return ({ '#language-toggle': languageButton, '#copy-status': status, '[data-nav]': nav, '[data-visual]': visual } as Record<string, any>)[selector]; },
    querySelectorAll(selector: string) { assert.equal(selector, '[data-copy]'); return buttons; },
    getElementById(id: string) { return code.get(id); },
    createRange() { return { selectNodeContents(node: { textContent: string }) { selected.push(node.textContent); } }; },
  };
  const clipboard = options.clipboardUnavailable ? undefined : { async writeText(text: string) { if (options.clipboardReject) throw new Error('Permission denied'); copied.push(text); } };
  vm.runInNewContext(script, {
    document, navigator: { clipboard },
    localStorage: { getItem(key: string) { if (options.storageBlocked) throw new Error('Blocked'); return storage.get(key); }, setItem(key: string, value: string) { if (options.storageBlocked) throw new Error('Blocked'); storage.set(key, value); } },
    window: { getSelection() { return { removeAllRanges() {}, addRange() {} }; } },
    setTimeout(callback: () => void) { timers.set(++timerId, callback); return timerId; },
    clearTimeout(id: number) { timers.delete(id); },
  });
  return { languageButton, status, documentElement, nav, visual, buttons, copied, selected, storage, timers };
}

test('language switch updates language, accessible labels, and persisted preference repeatedly', () => {
  const page = browserHarness();
  assert.equal(page.languageButton.hidden, false);
  assert.equal(page.documentElement.lang, 'en');
  page.languageButton.listeners.click();
  assert.equal(page.documentElement.lang, 'zh-Hans');
  assert.equal(page.documentElement.dataset.language, 'zh');
  assert.equal(page.languageButton.textContent, 'EN');
  assert.equal(page.nav.attributes['aria-label'], '主导航');
  assert.equal(page.storage.get('auto-handoff-language'), 'zh');
  page.languageButton.listeners.click();
  assert.equal(page.documentElement.lang, 'en');
  assert.equal(page.languageButton.textContent, '中文');
  assert.equal(browserHarness({ language: 'zh' }).documentElement.lang, 'zh-Hans');
  assert.equal(browserHarness({ language: 'unrecognized' }).documentElement.lang, 'en');
});

test('language and command controls work when browser storage is blocked', async () => {
  const page = browserHarness({ storageBlocked: true });
  page.languageButton.listeners.click();
  assert.equal(page.documentElement.lang, 'zh-Hans');
  await page.buttons[0].listeners.click();
  assert.equal(page.copied.length, 1);
  assert.equal(page.status.textContent, '命令已复制');
});

test('copy buttons copy exact commands and announce success, including repeated clicks', async () => {
  const page = browserHarness();
  for (const button of page.buttons) {
    assert.equal(button.hidden, false);
    await button.listeners.click();
  }
  assert.equal(page.copied[0], 'git clone https://github.com/AaronYang0628/auto-handoff.git\ncd auto-handoff\nnpm ci\nnpm link\ncsm install --scope user\ncsm doctor');
  assert.equal(page.copied[1], '$auto-handoff Hand off this task using profile=YOUR_PROFILE');
  await page.buttons[0].listeners.click();
  assert.equal(page.copied.length, 3);
  assert.equal(page.status.textContent, 'Command copied');
  assert.equal(page.timers.size, 1, 'Repeated clicks reset the announcement timer.');
  assert(page.status.classes.has('visible'));
  for (const callback of page.timers.values()) callback();
  assert.equal(page.status.textContent, '');
  assert(!page.status.classes.has('visible'));
});

test('unavailable or rejected clipboard selects the command and gives manual-copy instructions', async () => {
  for (const options of [{ clipboardUnavailable: true }, { clipboardReject: true }]) {
    const page = browserHarness(options);
    await page.buttons[1].listeners.click();
    assert.equal(page.copied.length, 0);
    assert.deepEqual(page.selected, ['$auto-handoff Hand off this task using profile=YOUR_PROFILE']);
    assert.match(page.status.textContent, /copy it manually/);
    page.languageButton.listeners.click();
    await page.buttons[0].listeners.click();
    assert.match(page.status.textContent, /请手动复制/);
  }
});
