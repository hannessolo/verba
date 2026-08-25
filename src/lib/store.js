// localStorage-backed persistence.
// Two separate keys: books (potentially large) and word stages (touched on
// every click, so kept small for fast saves).

import { wordKeysInText, phraseOccurrences } from './text.js';

// A word can be in one of the learning stages 0-4, or the special
// "ignore" state. Ignored words (e.g. proper names you don't want to learn)
// are not highlighted and are excluded from progress totals.
export const IGNORE_STAGE = 5;

const BOOKS_KEY = 'verba/books/v1';
const STAGES_KEY = 'verba/stages/v1';
const PAGES_KEY = 'verba/pages/v1';
const SETTINGS_KEY = 'verba/settings/v1';
const TRANS_KEY = 'verba/translations/v1';

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return JSON.parse(raw);
  } catch (e) {
    console.warn('failed to read', key, e);
  }
  return fallback;
}

export const store = {
  books: read(BOOKS_KEY, []),
  stages: read(STAGES_KEY, {}),
  // word key -> array of user-added translation strings
  translations: read(TRANS_KEY, {}),
};

export const settings = read(SETTINGS_KEY, { pageSize: 400 });
const pagePositions = read(PAGES_KEY, {});

export function saveBooks() {
  try {
    localStorage.setItem(BOOKS_KEY, JSON.stringify(store.books));
  } catch (e) {
    alert('Local storage is full — this book is too large to save. ' +
      'Try a shorter text or remove a book.');
    console.error(e);
  }
}

export function saveStages() {
  try {
    localStorage.setItem(STAGES_KEY, JSON.stringify(store.stages));
  } catch (e) {
    console.error(e);
  }
}

// ---- books ----

export function addBook(book) {
  book.id = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now());
  book.addedAt = Date.now();
  store.books.unshift(book);
  saveBooks();
  return book;
}

export function removeBook(id) {
  store.books = store.books.filter((b) => b.id !== id);
  saveBooks();
}

export function getBook(id) {
  return store.books.find((b) => b.id === id) || null;
}

// ---- settings & reading position ----

export function saveSettings(patch) {
  Object.assign(settings, patch);
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (e) {
    console.error(e);
  }
}

function savePages() {
  try {
    localStorage.setItem(PAGES_KEY, JSON.stringify(pagePositions));
  } catch (e) {
    console.error(e);
  }
}

export function savePagePosition(bookId, pageIndex) {
  if (pageIndex > 0) pagePositions[bookId] = pageIndex;
  else delete pagePositions[bookId];
  savePages();
}

export function getPagePosition(bookId) {
  return pagePositions[bookId] ?? 0;
}

// ---- word stages (global word list) ----

export function getStage(word) {
  return store.stages[word] ?? 0;
}

export function setStage(word, stage) {
  // valid values: learning stages 0-4 and IGNORE_STAGE (5)
  stage = Math.round(stage);
  if (stage < 0 || stage > IGNORE_STAGE) stage = 0;
  store.stages[word] = stage;
  saveStages();
}

/**
 * Stage keys that contain a space and have stage > 0 — i.e. phrases the user
 * has marked seen (or ignored: IGNORE_STAGE also merges, just without
 * highlight). Stage 0 = not saved / un-merged. Sorted by word count
 * descending (longest first) so "a través de" beats "a través".
 * Sentences marked seen are included too: they merge on exact re-occurrence.
 */
export function activePhrases() {
  const out = [];
  for (const [key, s] of Object.entries(store.stages)) {
    if (key.includes(' ') && s > 0) out.push(key);
  }
  out.sort((a, b) => b.split(' ').length - a.split(' ').length);
  return out;
}

// ---- custom translations (user-added meanings, global per word) ----

export function saveTranslations() {
  try {
    localStorage.setItem(TRANS_KEY, JSON.stringify(store.translations));
  } catch (e) {
    console.error(e);
  }
}

export function getCustomTranslations(word) {
  const t = store.translations[word];
  return Array.isArray(t) ? t : [];
}

// Adds a translation unless it's empty or a duplicate (case-insensitive).
// Returns true when a translation was actually added.
export function addCustomTranslation(word, text) {
  text = String(text || '').trim().replace(/\s+/g, ' ');
  if (!text) return false;
  const list = store.translations[word] || (store.translations[word] = []);
  if (list.some((t) => t.toLowerCase() === text.toLowerCase())) return false;
  list.push(text);
  saveTranslations();
  return true;
}

export function removeCustomTranslation(word, index) {
  const list = store.translations[word];
  if (!Array.isArray(list) || !Number.isInteger(index) || index < 0 || index >= list.length) return;
  list.splice(index, 1);
  if (list.length) store.translations[word] = list;
  else delete store.translations[word];
  saveTranslations();
}

// ---- export / import ----

// Serialize everything: books, word stages, reading positions, settings.
export function exportSnapshot() {
  return {
    app: 'verba',
    version: 1,
    exportedAt: new Date().toISOString(),
    books: store.books,
    stages: store.stages,
    translations: store.translations,
    pages: pagePositions,
    settings: { ...settings },
  };
}

// Merge an exported snapshot into the local data. Rules:
//  - books: unknown ids are added (their id is preserved so page positions
//    line up); existing ids keep the local book.
//  - page positions: the later page wins (local vs import).
//  - word stages: the later stage wins via Math.max; since IGNORE_STAGE is
//    5 (higher than any learning stage), a word ignored on either side stays
//    ignored, otherwise the more advanced learning stage wins.
//  - custom translations: union of both lists (case-insensitive dedupe),
//    import order first, then any local-only translations.
// Settings are exported but not applied on import (they are a local UI
// preference, not learning progress).
export function mergeImport(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Not a valid data file.');
  }
  const pages = data.pages && typeof data.pages === 'object' ? data.pages : {};
  const stats = { booksAdded: 0, pagesMerged: 0, wordsAdvanced: 0, translationsAdded: 0 };

  if (Array.isArray(data.books)) {
    let booksChanged = false;
    for (const b of data.books) {
      if (!b || !b.id || !Array.isArray(b.chapters) || !b.chapters.length) continue;
      if (!store.books.some((x) => x.id === b.id)) {
        store.books.push({ ...b, addedAt: b.addedAt || Date.now() });
        stats.booksAdded++;
        booksChanged = true;
      }
      const importedPage = Math.max(0, Math.round(Number(pages[b.id]) || 0));
      const localPage = Math.max(0, Math.round(Number(pagePositions[b.id]) || 0));
      if (importedPage > localPage) {
        pagePositions[b.id] = importedPage;
        stats.pagesMerged++;
      }
    }
    if (booksChanged) saveBooks();
    if (stats.pagesMerged) savePages();
  }

  if (data.stages && typeof data.stages === 'object') {
    for (const [word, stage] of Object.entries(data.stages)) {
      const s = Math.round(Number(stage));
      if (Number.isNaN(s) || s < 0 || s > IGNORE_STAGE) continue;
      const local = store.stages[word] ?? 0;
      if (s > local) {
        store.stages[word] = s;
        stats.wordsAdvanced++;
      }
    }
    if (stats.wordsAdvanced) saveStages();
  }

  if (data.translations && typeof data.translations === 'object' && !Array.isArray(data.translations)) {
    let transChanged = false;
    for (const [word, list] of Object.entries(data.translations)) {
      if (!Array.isArray(list)) continue;
      const clean = list
        .filter((t) => typeof t === 'string' && t.trim())
        .map((t) => t.trim().replace(/\s+/g, ' '));
      const local = store.translations[word] || [];
      // union, case-insensitive: import order first, then local-only entries
      const seen = new Set();
      const merged = [];
      for (const t of [...clean, ...local]) {
        const k = t.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        merged.push(t);
      }
      if (merged.length !== local.length) {
        store.translations[word] = merged;
        stats.translationsAdded += merged.length - local.length;
        transChanged = true;
      }
    }
    if (transChanged) saveTranslations();
  }

  return stats;
}

// ---- book stats ----

export function uniqueWords(book) {
  const seen = new Set();
  // active phrases are learned units too; only scan when any exist so the
  // common path (no phrases saved yet) stays fast
  const phrases = activePhrases();
  for (const ch of book.chapters) {
    for (const k of wordKeysInText(ch.text)) seen.add(k);
    if (phrases.length)
      for (const k of phraseOccurrences(ch.text, phrases)) seen.add(k);
  }
  return [...seen];
}

export function wordKey(token) {
  return token.toLowerCase().replace(/[’‘`]/g, "'");
}

export function bookStats(book) {
  const counts = [0, 0, 0, 0, 0]; // learning stages 0-4, unique words
  const ignored = new Set();
  const unique = uniqueWords(book);
  for (const w of unique) {
    const s = getStage(w);
    if (s === IGNORE_STAGE) ignored.add(w);
    else counts[s]++;
  }
  const total = unique.length - ignored.size; // ignored words don't count
  return {
    total,
    counts,
    ignored: ignored.size,
    known: counts[4],
    knownPct: total ? Math.round((counts[4] / total) * 100) : 0,
  };
}
