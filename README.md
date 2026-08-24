# verba

A small reading app: read Italian or Spanish texts, and learn
vocabulary one word at a time. Built with vanilla JavaScript + Vite, no
frameworks. All data (books + word stages) lives in `localStorage` — no
server, no accounts.

## Features

- **Import texts** as plain `.txt` or `.epub` (chapters are extracted and
  read in order). Language is auto-detected, or you can force Italian/Spanish.
  Two public-domain samples ship with the app (Boccaccio, Cervantes).
- **Word stages 0–4.** Every word starts at stage 0
  (highlighted red = "unknown"). Click a word to see its English translation
  and move it through the stages:
  - 0 New (red) → 1 Saw it (orange) → 2 Getting it (yellow) → 3 Almost known
    (light green) → 4 Known (no highlight)
- **Offline translations.** Full Italian→English and Spanish→English
  dictionaries (headwords derived from Wiktionary, incl. many inflected
  forms, ~1M / ~1.4M entries) ship as gzip-compressed data and are
  decompressed in the browser. A light suffix-stripping fallback resolves
  inflected forms not in the dictionary (the popup shows the base form,
  e.g. `girando ← girare`). Glosses keep **all** parts of speech and senses
  (`adj: …; noun: …`), each POS on its own line; glosses too long for the
  popup are clipped with a fade and a show-more/show-less toggle.
- **Progress tracking.** Per-book counts per stage and % of unique words
  known. Word stages form a global word list shared across books.
  Everything persists in `localStorage` across sessions.
- **Ignore words.** Words you don't want to learn (e.g. proper names) can be
  ignored from the word popup. Ignored words are not highlighted (they keep a
  faint dotted underline), are excluded from progress totals, and can be
  un-ignored later.
- **Pagination.** Long EPUBs are paginated by word count (200/400/600/1000
  or continuous), with prev/next buttons, ←/→ arrow-key navigation, chapter
  headings starting a fresh page, and the reading position remembered per
  book.
- **Keyboard navigation.** Press <b>⏎</b> to open the next word to learn
  (lowest stage, reading order). With a word open: <b>0–4</b> sets the stage
  directly, <b>⏎</b>/<b>→</b> advances it, <b>u</b> steps it back,
  <b>n</b> jumps to the next word, <b>i</b> toggles ignore, <b>esc</b>
  closes.

## Getting started

```sh
npm install
npm run dev        # dev server
npm run build      # production build -> dist/
```

The dictionary modules under `src/dict/` are pre-built and committed, so the
app works out of the box. To regenerate them from the raw TSVs in `dicts/`:

```sh
npm run build-dicts
```

### Dictionary sources

- Raw data: [Vuizur/Wiktionary-Dictionaries](https://github.com/Vuizur/Wiktionary-Dictionaries)
  (Italian/Spanish English TSVs) — extracted from
  [en.wiktionary.org](https://en.wiktionary.org), **CC-BY-SA 4.0**.
  The raw TSVs are gitignored (~41 MB); download them if you need to rebuild:

  ```sh
  mkdir -p dicts && cd dicts
  curl -LO 'https://raw.githubusercontent.com/Vuizur/Wiktionary-Dictionaries/master/Italian-English%20Wiktionary%20dictionary.tsv'
  curl -LO 'https://raw.githubusercontent.com/Vuizur/Wiktionary-Dictionaries/master/Spanish-English%20Wiktionary%20dictionary.tsv'
  mv 'Italian-English Wiktionary dictionary.tsv' it_en.tsv
  mv 'Spanish-English Wiktionary dictionary.tsv' es_en.tsv
  cd .. && npm run build-dicts
  ```

- `scripts/build-dicts.mjs` parses the TSVs (`headword1|headword2 | <pos> + senses`),
  keeps all headwords (including inflected forms/alternates) and **all** parts of
  speech and senses of each entry, then stores the data as
  `base64( gzip( keys \x00-joined + values \x01-joined ) )`. The runtime
  (`src/lib/dict.js`) inflates once per language and serves lookups by
  binary search — the bundle stays ~7 MB base64 per language while covering
  ~1M+ words each.

## Project layout

```
dicts/            raw TSV dictionaries (Wiktionary-derived)
scripts/          build-dicts.mjs (TSV -> src/dict/*.js)
public/samples/   sample texts (Decameron, Don Quijote)
src/
  main.js         app shell + hash routing (library / reader)
  styles.css
  lib/
    store.js      localStorage persistence (books + global word stages)
    dict.js       dictionary loader (pako inflate) + translate() w/ stemming
    text.js       tokenization, language detection, HTML->paragraphs
    epub.js       minimal EPUB reader (JSZip + OPF spine walk)
  dict/           generated dictionary data (it-en.js, es-en.js)
  views/
    library.js    bookshelf + upload UI
    reader.js     reading view, word popups, stage controls, progress
```

## Notes / limitations

- No lemmatization — words are tracked in their surface form.
- The EPUB reader is minimal: it reads the spine's XHTML items and drops
  images/nav; fixed-layout/complex EPUBs may extract imperfectly.
- `localStorage` is limited to ~5 MB, so very large EPUBs (whole novels
  with long text) may not fit; the app warns on overflow.
- The language detector is a stopword heuristic; on short or unusual texts
  it asks you to pick the language.
