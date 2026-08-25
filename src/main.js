import { getBook } from './lib/store.js';
import { renderLibrary } from './views/library.js';
import { renderReader } from './views/reader.js';
import { renderVocab } from './views/vocab.js';
import './styles.css';

const app = document.getElementById('app');

function headerHtml() {
  return `<header class="app-header">
    <a class="logo" href="#">verba<span class="logo-dot">.</span></a>
    <span class="tagline">learn words while you read</span>
    <a class="header-vocab" href="#/vocab">vocab</a>
    <span class="header-spacer"></span>
  </header>`;
}

let currentCleanup = null;

function render() {
  const m = location.hash.match(/^#\/book\/(.+)$/);
  const book = m ? getBook(decodeURIComponent(m[1])) : null;
  if (currentCleanup) {
    currentCleanup();
    currentCleanup = null;
  }
  app.innerHTML = headerHtml() + '<div id="view"></div>';
  const view = document.getElementById('view');
  if (book) currentCleanup = renderReader(view, book);
  else if (location.hash === '#/vocab') currentCleanup = renderVocab(view);
  else renderLibrary(view);
}

window.addEventListener('hashchange', render);
render();

// PWA: register the service worker for offline use. A relative path so it
// works from any mount point, in particular the GitHub Pages subpath.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((e) => {
      console.warn('service worker registration failed', e);
    });
  });
}

// ---------- "add to home screen" prompt (browser only) ----------
// Shown when the app is opened in a regular browser instead of the
// installed PWA, so users learn it works offline. Dismissal is remembered.
// Chromium fires beforeinstallprompt and lets us trigger the native install
// dialog; iOS Safari has no such event, so we show share-sheet instructions.
const PWA_DISMISSED_KEY = 'verba/pwaPromptDismissed/v1';
let pwaBanner = null;
let deferredInstallPrompt = null;

const isStandalone = () =>
  navigator.standalone === true ||
  matchMedia('(display-mode: standalone)').matches ||
  matchMedia('(display-mode: minimal-ui)').matches;

const isIOS =
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const isCoarsePointer = matchMedia('(hover: none) and (pointer: coarse)').matches;

function pwaDismissed() {
  try {
    return localStorage.getItem(PWA_DISMISSED_KEY) === '1';
  } catch {
    return true;
  }
}
function markPwaDismissed() {
  try {
    localStorage.setItem(PWA_DISMISSED_KEY, '1');
  } catch {}
}
function hidePwaPrompt() {
  if (pwaBanner) {
    pwaBanner.remove();
    pwaBanner = null;
  }
}
function showPwaPrompt() {
  if (pwaBanner || isStandalone() || pwaDismissed()) return;
  const canInstall = !!deferredInstallPrompt;
  const action = isCoarsePointer ? 'Add' : 'Install';
  const msg = canInstall
    ? `Verba works offline. ${isCoarsePointer ? 'Add it to your home screen' : 'Install it as an app'} to keep reading without a connection.`
    : 'Verba works offline. To use it without a connection, add it to your home screen: tap the Share icon, then “Add to Home Screen”.';
  pwaBanner = document.createElement('div');
  pwaBanner.className = 'pwa-prompt';
  pwaBanner.innerHTML = `
    <img class="pwa-prompt-icon" src="./icons/icon-192.png" alt="" width="30" height="30">
    <span class="pwa-prompt-msg">${msg}</span>
    ${canInstall ? `<button class="btn primary" type="button" id="pwa-add">${action}</button>` : ''}
    <button class="pwa-prompt-x" type="button" aria-label="Dismiss">✕</button>`;
  document.body.appendChild(pwaBanner);
  pwaBanner.querySelector('.pwa-prompt-x').addEventListener('click', () => {
    markPwaDismissed();
    hidePwaPrompt();
  });
  const add = pwaBanner.querySelector('#pwa-add');
  if (add)
    add.addEventListener('click', async () => {
      const p = deferredInstallPrompt;
      deferredInstallPrompt = null;
      hidePwaPrompt();
      if (!p || typeof p.prompt !== 'function') return;
      p.prompt();
      try {
        const { outcome } = await p.userChoice;
        if (outcome === 'accepted') markPwaDismissed();
      } catch {}
    });
}
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  showPwaPrompt();
});
window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  markPwaDismissed();
  hidePwaPrompt();
});
window.addEventListener('load', () => {
  // give the browser a moment to fire beforeinstallprompt after load
  setTimeout(showPwaPrompt, 2000);
});
