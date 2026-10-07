// localStorage-backed persistence.
// Two separate keys: books (potentially large) and word stages (touched on
// every click, so kept small for fast saves).

import { wordKeysInText, phraseOccurrences } from './text.js';

// Supported language codes. Word/phrase keys are scoped by the source
// language ("es:le" vs "fr:le") so that learning a word in one language never
// leaks into another — a bare word can be a different (or unknown) word in a
// different language.
export const LANGS = ['it', 'es', 'fr'];
export const LANG_NAMES = { it: 'Italian', es: 'Spanish', fr: 'French' };

/** Scope a bare word/phrase key to a language: "le" + "es" -> "es:le". */
export function scopeKey(lang, key) {
  return `${lang}:${key}`;
}

/**
 * Split a scoped key back into { lang, key }. Returns null when the key is not
 * scoped (a legacy bare key), so callers can tell the two formats apart.
 */
export function parseScopedKey(k) {
  const i = k.indexOf(':');
  if (i <= 0) return null;
  const lang = k.slice(0, i);
  if (!LANGS.includes(lang)) return null;
  return { lang, key: k.slice(i + 1) };
}

// A word can be in one of the learning stages 0-4, or the special
// "ignore" state. Ignored words (e.g. proper names you don't want to learn)
// are not highlighted and are excluded from progress totals.
export const IGNORE_STAGE = 5;

const BOOKS_KEY = 'verba/books/v1';
const STAGES_KEY = 'verba/stages/v1';
const PAGES_KEY = 'verba/pages/v1';
const SETTINGS_KEY = 'verba/settings/v1';
const TRANS_KEY = 'verba/translations/v1';
const SRS_KEY = 'verba/srs/v1';

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
  // word key -> spaced-repetition state { step: 0-6, last: epochMs }
  srs: read(SRS_KEY, {}),
};

// One-time migration of the legacy (un-scoped) word keys to language-scoped
// keys, using the user's books to work out each word's language. Idempotent:
// keys that already carry a valid "lang:" prefix are left untouched.
//
// Attribution rules for a legacy bare key:
//   - appears in exactly one language's books  -> that language.
//   - appears in several languages' books      -> all of them. The old data
//     never recorded which language a word was learned in, and a word spelled
//     identically across your languages ("le", "la", "de", …) is genuinely
//     ambiguous, so we keep it known in every language it occurs in. That is
//     lossless; going forward, learning is strictly per-language so the
//     cross-language leak can't recur, and a user who wants a fresh start on
//     e.g. French "le" can now reset it per-language without touching Spanish.
//   - appears in no book (its book was removed) -> every supported language,
//     which always includes the true one (lossless) and can't leak into a
//     live book (a word only renders in a book of its own language, where the
//     book-based entry already exists). The only cost is extra rows in the
//     vocab list for words whose book was deleted — rare and recoverable.
//
// The same helper re-scopes bare keys found in older exported files on import.
function booksLangMap(books) {
  const map = new Map(); // bareKey -> Set<lang>
  const add = (key, lang) => {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(lang);
  };
  // multi-word keys from any word map are candidate phrases to match against
  // book text (a phrase may have a custom translation or srs state without
  // ever having its stage set)
  const phraseSet = new Set();
  for (const m of [store.stages, store.translations, store.srs]) {
    for (const k of Object.keys(m)) {
      if (k.includes(' ')) {
        const p = parseScopedKey(k);
        phraseSet.add(p ? p.key : k);
      }
    }
  }
  const phraseKeys = [...phraseSet];
  for (const b of books) {
    for (const ch of b.chapters) {
      for (const k of wordKeysInText(ch.text)) add(k, b.language);
      if (phraseKeys.length)
        for (const k of phraseOccurrences(ch.text, phraseKeys)) add(k, b.language);
    }
  }
  return map;
}

function scopedKeysFor(map, langMap) {
  const out = {};
  for (const [k, v] of Object.entries(map)) {
    const p = parseScopedKey(k);
    if (p) out[k] = v; // already scoped
    else {
      // Words that appear in one or more books are attributed to exactly those
      // languages. Words in no book (their book was removed) have no language
      // signal left, so scope them to every supported language: that always
      // includes the true one (lossless) and can't leak into a live book, since
      // a word only renders in a book of its own language where the book-based
      // entry already exists. The only cost is extra rows in the vocab list for
      // words whose book was deleted — a rare, recoverable edge case.
      const langs = langMap.get(k) && langMap.get(k).size ? [...langMap.get(k)] : LANGS;
      for (const l of langs) out[scopeKey(l, k)] = v;
    }
  }
  return out;
}

// Run the migration before anything reads word state. Only touches storage
// when there is at least one legacy (bare) key, so returning users pay nothing.
// The books→language map is computed once and shared across all three word
// maps (stages/translations/srs) to avoid scanning every book three times.
(function migrateLegacyKeys() {
  const hasLegacy = (m) => Object.keys(m).some((k) => !parseScopedKey(k));
  if (!hasLegacy(store.stages) && !hasLegacy(store.translations) && !hasLegacy(store.srs)) return;
  const langMap = booksLangMap(store.books);
  store.stages = scopedKeysFor(store.stages, langMap);
  store.translations = scopedKeysFor(store.translations, langMap);
  store.srs = scopedKeysFor(store.srs, langMap);
  saveStages();
  saveTranslations();
  saveSrs();
})();

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
 * Bare (language-stripped) phrase keys the user has marked seen (stage > 0):
 * keys that contain a space and are not at stage 0. Phrases the user marked
 * ignored (IGNORE_STAGE) are included too — they merge on re-occurrence, just
 * without a highlight. Stage 0 = not saved / un-merged. Sentences marked seen
 * are included too: they merge on exact re-occurrence. Sorted by word count
 * descending (longest first) so "a través de" beats "a través". Bare keys are
 * what the text-scan helpers (phraseOccurrences) and tokenizeWithPhrases
 * expect; the reader scopes them to the book's language when rendering.
 */
export function activePhrases() {
  const out = [];
  for (const [key, s] of Object.entries(store.stages)) {
    if (s <= 0) continue;
    const p = parseScopedKey(key);
    if (p && p.key.includes(' ')) out.push(p.key);
    else if (key.includes(' ')) out.push(key); // safety: legacy bare phrase
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

// ---- srs (spaced repetition for flashcards) ----

export function saveSrs() {
  try {
    localStorage.setItem(SRS_KEY, JSON.stringify(store.srs));
  } catch (e) {
    console.error(e);
  }
}

export function srsState(key) {
  const s = store.srs[key];
  return s && Number.isInteger(s.step) && s.step >= 0 && s.step <= 6 && Number.isFinite(s.last)
    ? s
    : null;
}

export function setSrs(key, step, last) {
  store.srs[key] = {
    step: Math.max(0, Math.min(6, Math.round(Number(step) || 0))),
    last: Number(last),
  };
  saveSrs();
}

// ---- export / import ----

// Serialize everything: books, word stages, reading positions, settings.
export function exportSnapshot() {
  return {
    app: 'verba',
    version: 2,
    exportedAt: new Date().toISOString(),
    books: store.books,
    stages: store.stages,
    translations: store.translations,
    srs: store.srs,
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
  const stats = { booksAdded: 0, pagesMerged: 0, wordsAdvanced: 0, translationsAdded: 0, srsUpdated: 0 };

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

  // Older exports key words as bare words (no "lang:" prefix). Re-scope them
  // against the current books — the imported books were merged above, so a
  // freshly imported book can attribute its own words. Modern exports carry
  // already-scoped keys and merge directly.
  const importLangMap = booksLangMap(store.books);
  const scopedKeys = (key) => {
    if (parseScopedKey(key)) return [key];
    const set = importLangMap.get(key);
    return [...(set && set.size ? set : LANGS)].map((l) => scopeKey(l, key));
  };

  if (data.stages && typeof data.stages === 'object') {
    for (const [word, stage] of Object.entries(data.stages)) {
      const s = Math.round(Number(stage));
      if (Number.isNaN(s) || s < 0 || s > IGNORE_STAGE) continue;
      for (const k of scopedKeys(word)) {
        const local = store.stages[k] ?? 0;
        if (s > local) {
          store.stages[k] = s;
          stats.wordsAdvanced++;
        }
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
      for (const k of scopedKeys(word)) {
        const local = store.translations[k] || [];
        // union, case-insensitive: import order first, then local-only entries
        const seen = new Set();
        const merged = [];
        for (const t of [...clean, ...local]) {
          const key = t.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          merged.push(t);
        }
        if (merged.length !== local.length) {
          store.translations[k] = merged;
          stats.translationsAdded += merged.length - local.length;
          transChanged = true;
        }
      }
    }
    if (transChanged) saveTranslations();
  }

  // srs: per-key merge — the higher step wins; on a tie the later `last`.
  // Old snapshots without an srs block simply skip this.
  if (data.srs && typeof data.srs === 'object' && !Array.isArray(data.srs)) {
    let srsChanged = false;
    for (const [word, entry] of Object.entries(data.srs)) {
      if (!entry || typeof entry !== 'object') continue;
      const step = Number(entry.step);
      const last = Number(entry.last);
      if (!Number.isInteger(step) || step < 0 || step > 6 || !Number.isFinite(last)) continue;
      for (const k of scopedKeys(word)) {
        const local = store.srs[k];
        const better =
          !local ||
          !Number.isInteger(local.step) ||
          step > local.step ||
          (step === local.step && last > local.last);
        if (better) {
          store.srs[k] = { step, last };
          stats.srsUpdated++;
          srsChanged = true;
        }
      }
    }
    if (srsChanged) saveSrs();
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
    for (const k of wordKeysInText(ch.text)) seen.add(scopeKey(book.language, k));
    if (phrases.length)
      for (const k of phraseOccurrences(ch.text, phrases)) seen.add(scopeKey(book.language, k));
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
    // uniqueWords already returns language-scoped keys
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
