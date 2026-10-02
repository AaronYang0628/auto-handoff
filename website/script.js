'use strict';

const root = document.documentElement;
const languageButton = document.querySelector('#language-toggle');
const status = document.querySelector('#copy-status');
let statusTimer;
let language = 'en';

function setLanguage(next) {
  language = next === 'zh' ? 'zh' : 'en';
  root.dataset.language = language;
  root.lang = language === 'zh' ? 'zh-Hans' : 'en';
  languageButton.textContent = language === 'zh' ? 'EN' : '中文';
  languageButton.setAttribute('aria-label', language === 'zh' ? 'Read in English' : '阅读中文版');
  document.querySelector('[data-nav]').setAttribute('aria-label', language === 'zh' ? '主导航' : 'Main navigation');
  document.querySelector('[data-visual]').setAttribute('aria-label', language === 'zh' ? '交接流程示意' : 'Illustrative handoff workflow');
  try { localStorage.setItem('auto-handoff-language', language); } catch { /* The page works with storage blocked. */ }
}

try { language = localStorage.getItem('auto-handoff-language') === 'zh' ? 'zh' : 'en'; } catch { /* Keep English as the default. */ }
setLanguage(language);
languageButton.hidden = false;
languageButton.addEventListener('click', () => setLanguage(language === 'en' ? 'zh' : 'en'));

function announce(message) {
  clearTimeout(statusTimer);
  status.textContent = message;
  status.classList.add('visible');
  statusTimer = setTimeout(() => { status.classList.remove('visible'); status.textContent = ''; }, 4000);
}

for (const button of document.querySelectorAll('[data-copy]')) {
  button.hidden = false;
  button.addEventListener('click', async () => {
    const code = document.getElementById(button.dataset.copy);
    if (!code) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(code.textContent);
      announce(language === 'zh' ? '命令已复制' : 'Command copied');
    } catch {
      const range = document.createRange();
      range.selectNodeContents(code);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      announce(language === 'zh' ? '无法访问剪贴板。命令已选中，请手动复制。' : 'Clipboard unavailable. Command selected; copy it manually.');
    }
  });
}
