import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import JSZip from 'jszip';
import initSqlJs from 'sql.js';
import { nextReviewState } from '../src/lib/srs.js';

const BASE = process.argv[2] || 'http://127.0.0.1:4173';
const now = Date.now();

function report(name, ok, extra = '') {
  console.log(`${ok ? '  ok' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) process.exitCode = 1;
}

async function fixtureDeck() {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  const today = Math.floor(now / 86400000) * 86400000;
  const model = {
    id: 40,
    name: 'Basic',
    type: 0,
    flds: [{ name: 'Front' }, { name: 'Back' }],
    tmpls: [{ qfmt: '{{Front}}' }],
  };
  db.run(`
    CREATE TABLE col (crt integer, decks text, models text);
    CREATE TABLE notes (id integer, mid integer, flds text);
    CREATE TABLE cards (id integer, nid integer, did integer, ord integer, queue integer, due integer, ivl integer, factor integer, reps integer, lapses integer);
    CREATE TABLE revlog (id integer, cid integer);
  `);
  const add = (sql, values) => {
    const stmt = db.prepare(sql);
    try { stmt.run(values); } finally { stmt.free(); }
  };
  add('INSERT INTO col VALUES (?, ?, ?)', [
    Math.floor(today / 1000),
    JSON.stringify({ 30: { id: 30, name: 'Sample::Basics' } }),
    JSON.stringify({ 40: model }),
  ]);
  add('INSERT INTO notes VALUES (?, ?, ?)', [20, 40, 'perro\x1fdog']);
  add('INSERT INTO cards VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
    10, 20, 30, 0, 2, 0, 3, 2600, 4, 1,
  ]);
  add('INSERT INTO revlog VALUES (?, ?)', [now - 3 * 86400000, 10]);
  const zip = new JSZip();
  zip.file('collection.anki2', db.export());
  zip.file('media', '{}');
  db.close();
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function inspectPackage(bytes) {
  const zip = await JSZip.loadAsync(bytes);
  const collection = zip.file('collection.anki2');
  assert.ok(collection, 'Anki package contains collection.anki2');
  const SQL = await initSqlJs();
  const db = new SQL.Database(await collection.async('uint8array'));
  try {
    return {
      cards: db.exec('SELECT queue, due, ivl, factor, reps, lapses FROM cards ORDER BY id')[0]?.values || [],
      notes: db.exec('SELECT flds FROM notes ORDER BY id')[0]?.values || [],
      models: JSON.parse(db.exec('SELECT models FROM col')[0].values[0][0]),
    };
  } finally {
    db.close();
  }
}

assert.equal(nextReviewState(null, 'again', now).interval, 10);
assert.equal(nextReviewState(null, 'hard', now).interval, 60);
assert.equal(nextReviewState(null, 'good', now).interval, 1440);
assert.equal(nextReviewState(null, 'easy', now).interval, 5760);
assert.equal(new Set(['again', 'hard', 'good', 'easy'].map((rating) => nextReviewState(null, rating, now).interval)).size, 4);
report('Again/Hard/Good/Easy produce distinct first-review intervals', true);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
await page.addInitScript(() => {
  const voices = [
    { name: 'Local Spanish', lang: 'es-ES', localService: true },
    { name: 'Local English', lang: 'en-US', localService: true },
  ];
  const synthesis = {
    utterances: [],
    speaking: false,
    pending: false,
    paused: false,
    getVoices: () => voices,
    addEventListener: () => {},
    speak(utterance) {
      this.utterances.push({ text: utterance.text, lang: utterance.lang });
      this.speaking = true;
    },
    cancel() { this.speaking = false; },
    resume() {},
  };
  window.__ankiTts = synthesis;
  window.SpeechSynthesisUtterance = class {
    constructor(text) { this.text = text; this.lang = ''; this.voice = null; this.rate = 1; }
  };
  Object.defineProperty(window, 'speechSynthesis', { value: synthesis, configurable: true });
});

try {
  await page.goto(BASE);
  await page.evaluate(() => {
    localStorage.setItem('verba/stages/v1', JSON.stringify({ 'es:hola': 1 }));
    localStorage.setItem('verba/translations/v1', JSON.stringify({ 'es:hola': ['hello'] }));
    localStorage.setItem('verba/settings/v1', JSON.stringify({
      pageSize: 400,
      flashcardLang: 'all',
      advanced: { it: false, es: false, fr: false },
    }));
    location.hash = '/vocab';
  });
  await page.reload();
  await page.waitForSelector('.deck-card[data-deck-id="reading-es"]');
  await page.waitForFunction(() =>
    document.querySelector('.deck-card[data-deck-id="reading-es"] .deck-card-count')?.textContent.includes('1 word')
  );
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => !!navigator.serviceWorker?.controller);
  const ankiCached = await page.evaluate(async () => {
    const cacheNames = await caches.keys();
    for (const name of cacheNames) {
      const cache = await caches.open(name);
      const requests = await cache.keys();
      if (requests.some((request) => request.url.includes('/assets/anki-') ) &&
          requests.some((request) => request.url.endsWith('.wasm'))) return true;
    }
    return false;
  });
  report('PWA precaches the Anki module and SQLite WASM for offline use', ankiCached);

  const deckNames = await page.locator('.deck-card h3').allTextContents();
  report('shows one From reading deck for each supported language',
    ['From reading (Italian)', 'From reading (Spanish)', 'From reading (French)'].every((name) => deckNames.includes(name)));

  await page.context().setOffline(true);
  await page.locator('#anki-file').setInputFiles({
    name: 'sample.apkg',
    mimeType: 'application/zip',
    buffer: await fixtureDeck(),
  });
  await page.waitForFunction(() => document.querySelector('#deck-status')?.textContent.includes('Imported 1 deck'));
  await page.context().setOffline(false);
  const imported = page.locator('.deck-card[data-deck-id^="anki-"]');
  await imported.waitFor();
  report('imports an Anki package as a separate deck',
    (await imported.locator('h3').textContent()) === 'Sample::Basics');

  const importedState = await page.evaluate(() => JSON.parse(localStorage.getItem('verba/ankiDecks/v1'))[0]);
  const importedCard = importedState.cards[0];
  report('preserves imported ease, interval, repetitions, and lapses',
    importedCard.srs.ease === 2.6 &&
    importedCard.srs.interval === 4320 &&
    importedCard.srs.reps === 4 &&
    importedCard.srs.lapses === 1);

  await imported.locator('[data-deck-action="details"]').click();
  report('details show imported front and back', (await page.locator('.anki-card-list').innerText()).includes('perro') &&
    (await page.locator('.anki-card-list').innerText()).includes('dog'));
  await page.locator('#deck-revise').click();
  await page.locator('#fc-show').click();
  report('revision offers all four SRS ratings',
    await page.locator('[data-rating="again"]').count() === 1 &&
    await page.locator('[data-rating="hard"]').count() === 1 &&
    await page.locator('[data-rating="good"]').count() === 1 &&
    await page.locator('[data-rating="easy"]').count() === 1);
  await page.locator('[data-rating="again"]').click();
  await page.waitForSelector('#fc-back');
  const failedState = await page.evaluate(() => JSON.parse(localStorage.getItem('verba/ankiDecks/v1'))[0].cards[0].srs);
  report('Again reschedules an imported card and records a lapse',
    failedState.interval === 10 && failedState.reps === 5 && failedState.lapses === 2);
  await page.locator('#fc-back').click();

  const importedDownload = page.waitForEvent('download');
  await page.locator('#deck-export').click();
  const importedFile = await importedDownload;
  const importedPackage = await inspectPackage(await readFile(await importedFile.path()));
  report('exports imported decks as readable .apkg files',
    importedPackage.cards.length === 1 &&
    importedPackage.cards[0][0] === 1 &&
    importedPackage.cards[0][2] === -10 &&
    importedPackage.cards[0][4] === 5 &&
    importedPackage.cards[0][5] === 2);

  await page.evaluate(() => {
    localStorage.setItem('verba/review/v1', '{}');
    location.hash = '/vocab';
  });
  await page.reload();
  await page.waitForSelector('.deck-card[data-deck-id="reading-es"]');
  await page.waitForFunction(() =>
    document.querySelector('.deck-card[data-deck-id="reading-es"] .deck-card-count')?.textContent.includes('1 word')
  );
  await page.locator('.deck-card[data-deck-id="reading-es"] [data-deck-action="details"]').click();
  report('reading deck details show the learned word and translation',
    (await page.locator('.vocab-details-list').innerText()).includes('hola') &&
    (await page.locator('.vocab-details-list').innerText()).includes('hello'));
  await page.locator('#deck-revise').click();
  await page.locator('#fc-show').click();
  await page.locator('[data-rating="good"]').click();
  await page.locator('#fc-show').click();
  await page.locator('[data-rating="again"]').click();
  await page.waitForSelector('#fc-back');
  const stageAfterMiss = await page.evaluate(() => JSON.parse(localStorage.getItem('verba/stages/v1'))['es:hola']);
  report('reading vocabulary does not advance unless both directions are known', stageAfterMiss === 1);

  await page.evaluate(() => {
    localStorage.setItem('verba/review/v1', '{}');
    location.hash = '/vocab';
  });
  await page.reload();
  await page.waitForSelector('.deck-card[data-deck-id="reading-es"]');
  await page.waitForFunction(() =>
    document.querySelector('.deck-card[data-deck-id="reading-es"] .deck-card-count')?.textContent.includes('1 word')
  );
  await page.locator('.deck-card[data-deck-id="reading-es"] [data-deck-action="revise"]').click();
  const foreignPrompt = (await page.locator('.fc-prompt').textContent()).trim();
  await page.locator('#fc-tts-prompt').click();
  const spokenPrompt = await page.evaluate(() => window.__ankiTts.utterances.at(-1));
  report('reading flashcards speak the prompt in the correct language',
    spokenPrompt.text === foreignPrompt &&
    spokenPrompt.lang.startsWith(foreignPrompt === 'hola' ? 'es' : 'en'));
  await page.locator('#fc-show').click();
  await page.locator('#fc-tts-answer').click();
  const answerText = (await page.locator('.fc-answer').textContent()).trim();
  await page.waitForFunction((text) => window.__ankiTts.utterances.at(-1)?.text === text, answerText);
  const spokenAnswer = await page.evaluate(() => window.__ankiTts.utterances.at(-1));
  report('reading flashcards speak the answer in the correct language',
    spokenAnswer.text === answerText &&
    spokenAnswer.lang.startsWith(answerText === 'hola' ? 'es' : 'en'));
  await page.locator('[data-rating="good"]').click();
  await page.locator('#fc-show').click();
  await page.locator('[data-rating="easy"]').click();
  await page.waitForSelector('#fc-back');
  const readingSnapshot = await page.evaluate(() => ({
    stage: JSON.parse(localStorage.getItem('verba/stages/v1'))['es:hola'],
    review: JSON.parse(localStorage.getItem('verba/review/v1')),
  }));
  report('reading vocabulary advances after both directions are recalled',
    readingSnapshot.stage === 2 && Object.keys(readingSnapshot.review).length === 2);

  await page.locator('#fc-back').click();
  const readingExport = page.waitForEvent('download');
  await page.locator('#deck-export').click();
  const readingFile = await readingExport;
  const readingPackage = await inspectPackage(await readFile(await readingFile.path()));
  report('exports reading vocabulary with two Anki directions',
    readingPackage.cards.length === 2 &&
    readingPackage.notes.length === 1 &&
    Object.keys(readingPackage.models).some((key) => readingPackage.models[key].tmpls.length === 2));

  await page.locator('#deck-back').click();
  await page.locator('#anki-file').setInputFiles({
    name: 'reading-export.apkg',
    mimeType: 'application/zip',
    buffer: await readFile(await readingFile.path()),
  });
  await page.waitForFunction(() => document.querySelector('#deck-status')?.textContent.includes('Imported 1 deck'));
  const roundTripCards = await page.evaluate(() => {
    const deck = JSON.parse(localStorage.getItem('verba/ankiDecks/v1')).at(-1);
    return deck.cards.map(({ front, back }) => [front, back]);
  });
  report('reading .apkg round-trip imports both word directions',
    roundTripCards.some(([front, back]) => front === 'hola' && back === 'hello') &&
    roundTripCards.some(([front, back]) => front === 'hello' && back === 'hola'));

  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('.deck-card[data-deck-id^="anki-"]').last().locator('[data-deck-action="remove"]').click();
  const remainingDecks = await page.evaluate(() => JSON.parse(localStorage.getItem('verba/ankiDecks/v1')).length);
  report('imported decks can be removed from the library', remainingDecks === 1);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForSelector('.deck-grid');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  report('deck cards fit a mobile viewport without horizontal overflow', !overflow);
  report('no uncaught browser errors', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
}

if (process.exitCode) process.exit(process.exitCode);
