// localStorage-backed persistence.
// Two separate keys: books (potentially large) and word stages (touched on
// every click, so kept small for fast saves).

import { wordKeysInText } from './text.js';

// A word can be in one of the learning stages 0-4, or the special
// "ignore" state. Ignored words (e.g. proper names you don't want to learn)
// are not highlighted and are excluded from progress totals.
export const IGNORE_STAGE = 5;

const BOOKS_KEY = 'verba/books/v1';
const STAGES_KEY = 'verba/stages/v1';
const PAGES_KEY = 'verba/pages/v1';
const SETTINGS_KEY = 'verba/settings/v1';

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

export function savePagePosition(bookId, pageIndex) {
  if (pageIndex > 0) pagePositions[bookId] = pageIndex;
  else delete pagePositions[bookId];
  try {
    localStorage.setItem(PAGES_KEY, JSON.stringify(pagePositions));
  } catch (e) {
    console.error(e);
  }
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

// ---- book stats ----

export function uniqueWords(book) {
  const seen = new Set();
  for (const ch of book.chapters) {
    for (const k of wordKeysInText(ch.text)) seen.add(k);
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
