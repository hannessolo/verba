import { getBook } from './lib/store.js';
import { renderLibrary } from './views/library.js';
import { renderReader } from './views/reader.js';
import './styles.css';

const app = document.getElementById('app');

function headerHtml() {
  return `<header class="app-header">
    <a class="logo" href="#">verba<span class="logo-dot">.</span></a>
    <span class="tagline">learn words while you read</span>
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
