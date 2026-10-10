import { store, addBook, removeBook, bookStats, LANGS, LANG_NAMES, isAdvancedMode, setAdvancedMode } from '../lib/store.js';
import { parseEpub } from '../lib/epub.js';
import { detectLanguage, toParagraphs } from '../lib/text.js';
import { downloadData, importFromFile, importSummary } from '../lib/transfer.js';

export function renderLibrary(view) {
  view.innerHTML = `
    <section class="library">
      <div class="upload-card">
        <h2>Add a text</h2>
        <p class="muted">Upload a plain text <b>.txt</b> or an <b>.epub</b> book in Italian, Spanish or French.
        Every word starts as <span class="demo-w st0">unknown</span> and you promote it through the stages
        as you learn it.</p>
        <div class="upload-row">
          <label class="file-btn">
            <input type="file" id="file-input" accept=".txt,.epub" />
            <span class="file-label">Choose a .txt or .epub file…</span>
          </label>
          <select id="lang-select" title="Language">
            <option value="auto">Auto-detect language</option>
            <option value="it">Italian</option>
            <option value="es">Spanish</option>
            <option value="fr">French</option>
          </select>
        </div>
        <div id="upload-status" class="muted"></div>
        <div class="samples-row">
          <span class="muted">Or try a sample:</span>
          <button class="btn ghost" data-sample="decameron">Italiano · Decameron (Boccaccio)</button>
          <button class="btn ghost" data-sample="quijote">Español · Don Quijote (Cervantes)</button>
          <button class="btn ghost" data-sample="monte-cristo">Français · Le Comte de Monte-Cristo (Dumas)</button>
        </div>
        <div class="data-row">
          <span class="muted small">Your data:</span>
          <button class="btn ghost" id="export-data" title="Download all books, progress and learned words as a JSON file">⬇ Export data</button>
          <button class="btn ghost" id="import-data" title="Merge a previously exported JSON file into this library">⬆ Import data</button>
          <input type="file" id="import-data-input" accept=".json,application/json" hidden />
        </div>
        <div class="data-row">
          <span class="muted small">Advanced mode:</span>
          ${LANGS.map(
            (l) =>
              `<button class="btn ghost adv-toggle${isAdvancedMode(l) ? ' on' : ''}" data-adv-lang="${l}" type="button" title="All ${LANG_NAMES[l]} words count as known by default; only words you mark unknown are learned">${LANG_NAMES[l]}: ${isAdvancedMode(l) ? 'on' : 'off'}</button>`
          ).join('')}
        </div>
      </div>
      <h2 class="books-title">Your library</h2>
      <div id="book-list" class="book-list"></div>
    </section>`;

  renderBookList(view);

  const fileInput = view.querySelector('#file-input');
  const status = view.querySelector('#upload-status');
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    try {
      status.textContent = 'Importing…';
      const book = await importFile(file, view.querySelector('#lang-select').value);
      location.hash = `#/book/${book.id}`;
    } catch (e) {
      console.error(e);
      status.textContent = `Import failed: ${e.message}`;
    }
  });

  // ---- advanced mode toggles (per language) ----
  const syncAdvRow = () => {
    for (const b of view.querySelectorAll('[data-adv-lang]')) {
      const l = b.dataset.advLang;
      b.textContent = `${LANG_NAMES[l]}: ${isAdvancedMode(l) ? 'on' : 'off'}`;
      b.classList.toggle('on', isAdvancedMode(l));
    }
  };
  for (const b of view.querySelectorAll('[data-adv-lang]')) {
    b.addEventListener('click', () => {
      const l = b.dataset.advLang;
      if (!isAdvancedMode(l)) {
        const ok = confirm(
          `Enable advanced mode for ${LANG_NAMES[l]}?\n\n` +
            'For this language, all words count as known by default: the text ' +
            'shows no highlights, and words are not added to your vocabulary on ' +
            'their own.\n\n' +
            'Tap any word in the reader to mark it "unknown" — from there you ' +
            'learn it through the stages (colors, flashcards) as usual. You ' +
            'can turn advanced mode off again at any time; marked words keep ' +
            'their progress.'
        );
        if (!ok) return;
      }
      setAdvancedMode(l, !isAdvancedMode(l));
      syncAdvRow();
      renderBookList(view); // progress bars change with the mode
    });
  }

  // ---- export / import ----
  view.querySelector('#export-data').addEventListener('click', downloadData);
  const importInput = view.querySelector('#import-data-input');
  view.querySelector('#import-data').addEventListener('click', () => importInput.click());
  importInput.addEventListener('change', async () => {
    const file = importInput.files[0];
    importInput.value = '';
    if (!file) return;
    try {
      status.textContent = 'Importing data…';
      const stats = await importFromFile(file);
      status.textContent = importSummary(stats);
      renderBookList(view);
    } catch (e) {
      console.error(e);
      status.textContent = `Import failed: ${e.message}`;
    }
  });

  for (const btn of view.querySelectorAll('[data-sample]')) {
    btn.addEventListener('click', async () => {
      try {
        status.textContent = 'Loading sample…';
        const res = await fetch(`./samples/${btn.dataset.sample}.txt`);
        if (!res.ok) throw new Error('sample not found');
        const text = await res.text();
        const name = btn.dataset.sample;
        const SAMPLES = {
          decameron: { title: 'Decameron (excerpt)', author: 'Giovanni Boccaccio', lang: 'it' },
          quijote: { title: 'Don Quijote (excerpt)', author: 'Miguel de Cervantes', lang: 'es' },
          'monte-cristo': { title: 'Le Comte de Monte-Cristo (excerpt)', author: 'Alexandre Dumas', lang: 'fr' },
        };
        const s = SAMPLES[name];
        if (!s) throw new Error('unknown sample');
        const book = addBook({
          title: s.title,
          author: s.author,
          language: s.lang,
          chapters: [{ title: 'Text', text: toParagraphs(text).join('\n\n') }],
        });
        location.hash = `#/book/${book.id}`;
      } catch (e) {
        status.textContent = `Sample failed: ${e.message}`;
      }
    });
  }
}

async function importFile(file, langChoice) {
  const isEpub = /\.epub$/i.test(file.name);
  let title, author = '', chapters;
  if (isEpub) {
    const parsed = await parseEpub(file);
    title = parsed.title;
    author = parsed.author;
    chapters = parsed.chapters;
  } else {
    const text = await file.text();
    title = file.name.replace(/\.txt$/i, '');
    chapters = [{ title: 'Text', text: toParagraphs(text).join('\n\n') }];
  }
  if (!chapters.length) throw new Error('No text found in file.');
  const allText = chapters.map((c) => c.text).join(' ');
  let language =
    langChoice !== 'auto' ? langChoice : detectLanguage(allText);
  if (!language) {
    // ask the user when detection is inconclusive
    const answer = prompt(
      'Could not auto-detect the language.\n1 = Italian, 2 = Spanish, 3 = French'
    );
    if (answer === '1') language = 'it';
    else if (answer === '2') language = 'es';
    else if (answer === '3') language = 'fr';
    else throw new Error('Language not set — re-import and pick a language.');
  }
  return addBook({ title, author, language, chapters });
}

function renderBookList(view) {
  const list = view.querySelector('#book-list');
  if (!store.books.length) {
    list.innerHTML = '<p class="muted">No books yet — upload one above.</p>';
    return;
  }
  list.innerHTML = store.books
    .map((b) => {
      const stats = bookStats(b);
      return `
      <a class="book-card" href="#/book/${encodeURIComponent(b.id)}">
        <div class="book-head">
          <div class="book-title">${esc(b.title)}</div>
          <button class="btn icon del" title="Remove book">✕</button>
        </div>
        ${b.author ? `<div class="book-author">${esc(b.author)}</div>` : ''}
        <div class="book-meta">
          <span class="badge lang">${LANG_NAMES[b.language] || b.language}</span>
          <span>${b.chapters.length} chapter${b.chapters.length === 1 ? '' : 's'}</span>
          <span>${stats.total.toLocaleString()} words</span>
        </div>
        <div class="progress-row">
          <div class="progress-bar"><div class="progress-fill" style="width:${stats.knownPct}%"></div></div>
          <span class="progress-label">${stats.knownPct}% known</span>
        </div>
      </a>`;
    })
    .join('');
  for (const del of list.querySelectorAll('.del')) {
    del.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const card = del.closest('.book-card');
      const id = decodeURIComponent(new URL(card.getAttribute('href'), location.href).hash.slice(7));
      if (confirm('Remove this book from your library? (Your word list is kept.)')) {
        removeBook(id);
        renderBookList(view);
      }
    });
  }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
