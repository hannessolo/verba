import {
  store,
  setStage,
  srsState,
  parseScopedKey,
  LANGS,
  LANG_NAMES,
  isAdvancedMode,
  reviewState,
  setReviewState,
  saveDecks,
} from '../lib/store.js';
import { loadDict, translate, translatePhrase } from '../lib/dict.js';
import {
  RATINGS,
  formatInterval,
  fromLegacySrs,
  intervalForRating,
  isReviewDue,
  nextReviewState,
  normalizeReviewState,
} from '../lib/srs.js';
import { initVoices, speak, stop as stopSpeech, supported as ttsSupported } from '../lib/tts.js';

const STAGE_NAMES = ['New', 'Saw it', 'Getting it', 'Almost known', 'Known'];
const READING_DECK_ID = (lang) => `reading-${lang}`;
const DIRECTION_KEYS = ['foreign-to-english', 'english-to-foreign'];

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function listWords() {
  const out = [];
  for (const [key, stage] of Object.entries(store.stages)) {
    if (stage < 0 || stage > 4) continue;
    const parsed = parseScopedKey(key);
    const word = parsed ? parsed.key : key;
    out.push({
      key,
      lang: parsed ? parsed.lang : null,
      word,
      stage,
      phrase: word.includes(' '),
      custom: Array.isArray(store.translations[key]) ? store.translations[key] : [],
    });
  }
  return out;
}

function englishFor(entry, dicts) {
  if (entry.custom.length) return entry.custom[0];
  const dict = entry.lang && dicts?.[entry.lang];
  if (!dict) return null;
  const result = entry.phrase ? translatePhrase(dict, entry.word) : translate(dict, entry.word);
  return result?.gloss || null;
}

function readingReviewKey(entry, direction) {
  return `${entry.key}\u001f${direction}`;
}

function readReviewState(entry, direction) {
  return reviewState(readingReviewKey(entry, direction)) || fromLegacySrs(srsState(entry.key));
}

function readingEntryDue(entry, now = Date.now()) {
  return DIRECTION_KEYS.some((direction) => isReviewDue(readReviewState(entry, direction), now));
}

function dueCards(deck) {
  if (deck.kind === 'reading')
    return deck.entries.filter((entry) => entry.english && readingEntryDue(entry)).length;
  return deck.cards.filter((card) => !card.suspended && isReviewDue(normalizeReviewState(card.srs))).length;
}

function readingItems(entries) {
  const now = Date.now();
  return shuffle(entries.filter((entry) => entry.english && readingEntryDue(entry, now)))
    .sort((a, b) => {
      const aStates = DIRECTION_KEYS.map((direction) => readReviewState(a, direction));
      const bStates = DIRECTION_KEYS.map((direction) => readReviewState(b, direction));
      const aNew = aStates.every((state) => !state);
      const bNew = bStates.every((state) => !state);
      if (aNew !== bNew) return aNew ? -1 : 1;
      const aTimes = aStates.filter(Boolean).map((state) => state.due);
      const bTimes = bStates.filter(Boolean).map((state) => state.due);
      const aDue = aTimes.length ? Math.min(...aTimes) : 0;
      const bDue = bTimes.length ? Math.min(...bTimes) : 0;
      return aDue - bDue || a.stage - b.stage;
    })
    .slice(0, 10);
}

function importedItems(deck) {
  return shuffle(deck.cards.filter((card) =>
    !card.suspended && isReviewDue(normalizeReviewState(card.srs))
  ))
    .sort((a, b) => {
      const aState = normalizeReviewState(a.srs);
      const bState = normalizeReviewState(b.srs);
      if (!!aState !== !!bState) return aState ? 1 : -1;
      return (aState?.due ?? 0) - (bState?.due ?? 0);
    })
    .slice(0, 10);
}

export function renderVocab(view) {
  let dicts = null;
  let entries = null;
  let detailsFilter = 'all';
  let onKey = null;
  let status = '';
  let ankiModule = null;
  const ttsOk = ttsSupported();
  if (ttsOk) initVoices();

  function setKeyHandler(fn) {
    if (onKey) document.removeEventListener('keydown', onKey);
    if (fn) document.addEventListener('keydown', fn);
    onKey = fn || null;
  }

  async function loadDicts() {
    if (dicts) return dicts;
    const loaded = await Promise.all(
      LANGS.map((lang) => loadDict(lang).catch((error) => {
        console.warn(`${lang} dictionary failed to load`, error);
        return null;
      }))
    );
    dicts = Object.fromEntries(LANGS.map((lang, index) => [lang, loaded[index]]));
    entries = listWords().map((word) => ({
      ...word,
      english: englishFor(word, dicts),
    }));
    renderDecks();
    return dicts;
  }

  function readingDeck(lang) {
    return {
      id: READING_DECK_ID(lang),
      kind: 'reading',
      language: lang,
      name: `From reading (${LANG_NAMES[lang]})`,
      entries: (entries || []).filter((entry) => entry.lang === lang),
    };
  }

  function decks() {
    return [
      ...LANGS.map(readingDeck),
      ...store.decks.map((deck) => ({ ...deck, kind: 'anki' })),
    ];
  }

  function currentDeck(id) {
    return decks().find((deck) => deck.id === id);
  }

  async function loadAnki() {
    if (!ankiModule) ankiModule = await import('../lib/anki.js');
    return ankiModule;
  }

  function cardCount(deck) {
    return deck.kind === 'reading' ? deck.entries.length : deck.cards.length;
  }

  function deckCardHtml(deck) {
    const count = cardCount(deck);
    const noun = deck.kind === 'reading' ? 'word' : 'card';
    const due = dueCards(deck);
    const loading = deck.kind === 'reading' && entries === null;
    return `
      <article class="deck-card" data-deck-id="${esc(deck.id)}">
        <div class="deck-card-head">
          <div>
            <span class="deck-kind">${deck.kind === 'reading' ? 'Reading deck' : 'Anki deck'}</span>
            <h3>${esc(deck.name)}</h3>
          </div>
          ${deck.kind === 'reading' ? `<span class="vocab-lang">${esc(deck.language)}</span>` : ''}
        </div>
        <p class="deck-card-count">${loading ? 'Preparing cards…' : `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'} · ${due.toLocaleString()} due`}</p>
        <div class="deck-card-actions">
          <button class="btn primary" data-deck-action="revise" type="button" ${loading || due === 0 ? 'disabled' : ''}>Revise${!loading ? ` (${due})` : ''}</button>
          <button class="btn ghost" data-deck-action="details" type="button" ${loading ? 'disabled' : ''}>View details</button>
          <button class="btn ghost" data-deck-action="export" type="button" ${loading || count === 0 ? 'disabled' : ''}>Export .apkg</button>
          ${deck.kind === 'anki' ? '<button class="btn ghost" data-deck-action="remove" type="button">Remove</button>' : ''}
        </div>
      </article>`;
  }

  function renderDecks() {
    stopSpeech();
    setKeyHandler(null);
    const items = decks();
    const ready = entries !== null;
    const loading = ready ? '' : '<p class="muted">Loading your reading vocabulary…</p>';
    view.innerHTML = `
      <section class="vocab deck-overview">
        <div class="deck-overview-head">
          <div>
            <h2 class="vocab-title">Your decks</h2>
            <p class="muted small">Revise words from your reading or import an Anki package.</p>
          </div>
          <div>
            <button class="btn primary" id="anki-import" type="button">Import Anki deck</button>
            <input id="anki-file" type="file" accept=".apkg,application/zip,application/octet-stream" hidden />
          </div>
        </div>
        <div class="deck-grid">
          ${items.map(deckCardHtml).join('')}
        </div>
        ${loading}
        <p class="deck-status muted small" id="deck-status" role="status">${esc(status)}</p>
      </section>`;

    view.querySelector('#anki-import').addEventListener('click', () => view.querySelector('#anki-file').click());
    view.querySelector('#anki-file').addEventListener('change', async (event) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;
      status = `Importing ${file.name}…`;
      renderDecks();
      try {
        const { importAnkiPackage } = await loadAnki();
        const { decks: imported, skipped } = await importAnkiPackage(file);
        const original = store.decks.length;
        store.decks.push(...imported);
        if (!saveDecks()) {
          store.decks.splice(original);
          status = 'Could not save the imported deck.';
        } else {
          const cards = imported.reduce((sum, deck) => sum + deck.cards.length, 0);
          status = `Imported ${imported.length} deck${imported.length === 1 ? '' : 's'} with ${cards.toLocaleString()} cards.${skipped ? ` Skipped ${skipped} unsupported card${skipped === 1 ? '' : 's'}.` : ''}`;
        }
      } catch (error) {
        console.error('Anki import failed', error);
        status = `Import failed: ${error.message}`;
      }
      renderDecks();
    });

    for (const button of view.querySelectorAll('[data-deck-action]')) {
      button.addEventListener('click', async () => {
        const card = button.closest('.deck-card');
        const deck = currentDeck(card.dataset.deckId);
        if (!deck) return;
        const action = button.dataset.deckAction;
        if (action === 'details') {
          detailsFilter = 'all';
          renderDetails(deck);
        } else if (action === 'revise') {
          startSession(deck);
        } else if (action === 'remove') {
          if (!window.confirm(`Remove “${deck.name}” from Verba?`)) return;
          const index = store.decks.findIndex((item) => item.id === deck.id);
          if (index < 0) return;
          const [removed] = store.decks.splice(index, 1);
          if (!saveDecks()) {
            store.decks.splice(index, 0, removed);
            return;
          }
          status = `Removed ${deck.name}.`;
          renderDecks();
        } else if (action === 'export') {
          try {
            await exportDeck(deck);
            status = `${deck.name}.apkg downloaded.`;
            renderDecks();
          } catch (error) {
            console.error('Anki export failed', error);
            status = `Export failed: ${error.message}`;
            renderDecks();
          }
        }
      });
    }
  }

  async function exportDeck(deck) {
    const { downloadAnkiPackage } = await loadAnki();
    if (deck.kind === 'reading') {
      const cards = deck.entries.map((entry) => ({
        front: entry.word,
        back: entry.english || '',
        srsPair: DIRECTION_KEYS.map((direction) => readReviewState(entry, direction)),
      }));
      await downloadAnkiPackage(deck.name, cards, { reversed: true });
      return;
    }
    await downloadAnkiPackage(deck.name, deck.cards);
  }

  function detailsHeader(deck, count, due) {
    return `
      <div class="deck-details-head">
        <button class="btn ghost" id="deck-back" type="button">← All decks</button>
        <div class="deck-details-title">
          <span class="deck-kind">${deck.kind === 'reading' ? 'Reading deck' : 'Anki deck'}</span>
          <h2 class="vocab-title">${esc(deck.name)}</h2>
          <span class="muted small">${count.toLocaleString()} cards · ${due.toLocaleString()} due</span>
        </div>
        <div class="deck-card-actions">
          <button class="btn primary" id="deck-revise" type="button" ${due === 0 ? 'disabled' : ''}>Revise (${due})</button>
          <button class="btn ghost" id="deck-export" type="button" ${count === 0 ? 'disabled' : ''}>Export .apkg</button>
        </div>
      </div>`;
  }

  function renderDetails(deck) {
    stopSpeech();
    setKeyHandler(null);
    const count = cardCount(deck);
    const due = dueCards(deck);
    if (deck.kind === 'reading') {
      const filters = [
        ['all', 'All'],
        ['learning', 'Learning (0–3)'],
        ['known', 'Known (4)'],
        ['phrases', 'Phrases'],
      ];
      const shown = deck.entries.filter((entry) => {
        if (detailsFilter === 'learning') return entry.stage <= 3;
        if (detailsFilter === 'known') return entry.stage === 4;
        if (detailsFilter === 'phrases') return entry.phrase;
        return true;
      });
      const groups = [];
      for (const stage of [4, 3, 2, 1, 0]) {
        const group = shown
          .filter((entry) => entry.stage === stage)
          .sort((a, b) => a.word.localeCompare(b.word, undefined, { sensitivity: 'base' }));
        if (!group.length) continue;
        groups.push(`<h3 class="vocab-group">${STAGE_NAMES[stage]} <span class="vocab-group-count">· ${group.length}</span></h3>`);
        for (const entry of group) {
          const custom = entry.custom.length
            ? `<span class="vocab-custom">${entry.custom.map((text) => `<span class="plus">＋</span> ${esc(text)}`).join('  ')}</span>`
            : '';
          groups.push(`
            <div class="vocab-row">
              <span class="vocab-word${entry.phrase ? ' phrase' : ''}">${esc(entry.word)}</span>
              <span class="dot st${entry.stage}"></span>
              <span class="vocab-gloss">${entry.english ? esc(entry.english) : '<span class="muted">No translation — add one from the reader.</span>'}</span>
              ${custom}
            </div>`);
        }
      }
      view.innerHTML = `
        <section class="vocab deck-details">
          ${detailsHeader(deck, count, due)}
          ${isAdvancedMode(deck.language) ? `<p class="vocab-adv muted small">Advanced mode is on for ${LANG_NAMES[deck.language]} — only words you mark unknown appear in this deck.</p>` : ''}
          <div class="vocab-filters deck-detail-filters">
            ${filters.map(([filter, label]) => `<button class="vocab-filter${detailsFilter === filter ? ' active' : ''}" data-filter="${filter}" type="button">${label}</button>`).join('')}
          </div>
          <div class="vocab-details-list">${groups.join('') || '<p class="muted">No words in this deck yet.</p>'}</div>
        </section>`;
      for (const button of view.querySelectorAll('[data-filter]')) {
        button.addEventListener('click', () => {
          detailsFilter = button.dataset.filter;
          renderDetails(deck);
        });
      }
    } else {
      view.innerHTML = `
        <section class="vocab deck-details">
          ${detailsHeader(deck, count, due)}
          <div class="anki-card-list">
            ${deck.cards.length ? deck.cards.map((card) => `
              <article class="anki-card-row">
                <div class="anki-card-fields">
                  <div><span class="anki-field-label">Front</span><span>${esc(card.front) || '<span class="muted">—</span>'}</span></div>
                  <div><span class="anki-field-label">Back</span><span>${esc(card.back) || '<span class="muted">—</span>'}</span></div>
                </div>
                <div class="anki-card-meta">
                  ${card.suspended ? '<span class="muted small">Suspended in Anki</span><button class="btn ghost anki-unsuspend" data-card-id="' + esc(card.id) + '" type="button">Unsuspend</button>' : `<span class="muted small">${isReviewDue(normalizeReviewState(card.srs)) ? 'Due' : 'Scheduled'}</span>`}
                </div>
              </article>`).join('') : '<p class="muted">This deck has no cards.</p>'}
          </div>
        </section>`;
      for (const button of view.querySelectorAll('.anki-unsuspend')) {
        button.addEventListener('click', () => {
          const card = deck.cards.find((item) => item.id === button.dataset.cardId);
          if (!card) return;
          card.suspended = false;
          if (!saveDecks()) {
            card.suspended = true;
            return;
          }
          renderDetails(deck);
        });
      }
    }

    view.querySelector('#deck-back').addEventListener('click', renderDecks);
    view.querySelector('#deck-revise').addEventListener('click', () => startSession(deck));
    view.querySelector('#deck-export').addEventListener('click', async () => {
      try {
        await exportDeck(deck);
      } catch (error) {
        console.error('Anki export failed', error);
        window.alert(`Export failed: ${error.message}`);
      }
    });
  }

  function setReadReview(entry, direction, rating) {
    const key = readingReviewKey(entry, direction);
    const previous = readReviewState(entry, direction);
    return setReviewState(key, nextReviewState(previous, rating));
  }

  function setImportedReview(card, rating) {
    const previous = card.srs;
    card.srs = nextReviewState(normalizeReviewState(previous), rating);
    if (saveDecks()) return true;
    card.srs = previous;
    return false;
  }

  function startSession(deck) {
    const picked = deck.kind === 'reading' ? readingItems(deck.entries) : importedItems(deck);
    if (!picked.length) return;
    const session = {
      over: false,
      cards: [],
      idx: 0,
      revealed: false,
      answers: {},
      advanced: [],
      reviewed: 0,
    };
    const words = new Map();

    if (deck.kind === 'reading') {
      for (const entry of picked) {
        words.set(entry.key, entry);
        session.answers[entry.key] = { 'foreign-to-english': null, 'english-to-foreign': null };
        session.cards.push(
          {
            kind: 'reading',
            wordKey: entry.key,
            direction: 'foreign-to-english',
            prompt: entry.word,
            answer: entry.english,
            entry,
          },
          {
            kind: 'reading',
            wordKey: entry.key,
            direction: 'english-to-foreign',
            prompt: entry.english,
            answer: entry.word,
            entry,
          }
        );
      }
      shuffle(session.cards);
      for (let index = 1; index < session.cards.length; index++) {
        if (session.cards[index].wordKey === session.cards[index - 1].wordKey) {
          let swap = index + 1;
          while (swap < session.cards.length && session.cards[swap].wordKey === session.cards[index - 1].wordKey) swap++;
          if (swap < session.cards.length) [session.cards[index], session.cards[swap]] = [session.cards[swap], session.cards[index]];
        }
      }
    } else {
      session.cards = shuffle(picked.map((card) => ({
        kind: 'anki',
        id: card.id,
        prompt: card.front,
        answer: card.back,
        source: card,
      })));
    }

    const promptLanguage = (card) => {
      if (card.kind !== 'reading') return 'en';
      return card.direction === 'foreign-to-english' ? deck.language : 'en';
    };
    const answerLanguage = (card) => {
      if (card.kind !== 'reading') return 'en';
      return card.direction === 'foreign-to-english' ? 'en' : deck.language;
    };
    const stateFor = (card) =>
      card.kind === 'reading'
        ? readReviewState(card.entry, card.direction)
        : normalizeReviewState(card.source.srs);

    const review = (rating) => {
      if (session.over || !session.revealed) return;
      const card = session.cards[session.idx];
      if (card.kind === 'reading') {
        if (!setReadReview(card.entry, card.direction, rating)) return;
        session.answers[card.wordKey][card.direction] = rating !== 'again';
        const result = session.answers[card.wordKey];
        if (result['foreign-to-english'] !== null && result['english-to-foreign'] !== null) {
          if (result['foreign-to-english'] && result['english-to-foreign']) {
            const entry = words.get(card.wordKey);
            const stage = Math.min(4, entry.stage + 1);
            if (stage > entry.stage) {
              setStage(entry.key, stage);
              session.advanced.push({ word: entry.word, stage });
            }
          }
          session.reviewed++;
        }
      } else if (!setImportedReview(card.source, rating)) {
        return;
      } else {
        session.reviewed++;
      }
      session.idx++;
      if (session.idx >= session.cards.length) showSummary();
      else showCard();
    };

    const showCard = () => {
      stopSpeech();
      session.revealed = false;
      const card = session.cards[session.idx];
      const count = session.cards.length;
      view.innerHTML = `
        <section class="flashcards">
          <div class="fc-top">
            <button class="btn ghost" id="fc-exit" type="button">← Deck details</button>
            <span class="fc-progress">${session.idx + 1} / ${count}</span>
            <span class="fc-lang-badge">${esc(deck.name)}</span>
            <div class="progress-bar"><div class="progress-fill" style="width:${Math.round((session.idx / count) * 100)}%"></div></div>
          </div>
          <div class="fc-card">
            <div class="fc-prompt">${esc(card.prompt)}</div>
            ${ttsOk && card.kind === 'reading' ? '<button class="btn ghost fc-tts" id="fc-tts-prompt" type="button">🔊 Hear it</button>' : ''}
            <button class="btn primary fc-show" id="fc-show" type="button">Show answer</button>
          </div>
        </section>`;
      view.querySelector('#fc-exit').addEventListener('click', () => renderDetails(deck));
      view.querySelector('#fc-show').addEventListener('click', reveal);
      const ttsButton = view.querySelector('#fc-tts-prompt');
      if (ttsButton) ttsButton.addEventListener('click', () => speak(card.prompt, promptLanguage(card)));
    };

    const reveal = () => {
      if (session.over || session.revealed) return;
      session.revealed = true;
      const card = session.cards[session.idx];
      const cardEl = view.querySelector('.fc-card');
      const schedule = stateFor(card);
      cardEl.innerHTML = `
        <div class="fc-prompt">${esc(card.prompt)}</div>
        ${ttsOk && card.kind === 'reading' ? '<button class="btn ghost fc-tts" id="fc-tts-prompt" type="button">🔊 Hear it</button>' : ''}
        <div class="fc-answer">${esc(card.answer)}</div>
        ${ttsOk && card.kind === 'reading' ? '<button class="btn ghost fc-tts" id="fc-tts-answer" type="button">🔊 Hear it</button>' : ''}
        <div class="fc-ratings">
          ${RATINGS.map((rating) => {
            const interval = formatInterval(intervalForRating(schedule, rating.id));
            return `<button class="btn ${rating.id === 'good' ? 'primary' : 'ghost'}" data-rating="${rating.id}" type="button" title="${rating.label} · ${interval}">
              <span>${rating.label}</span><small>${interval}</small>
            </button>`;
          }).join('')}
        </div>`;
      for (const button of view.querySelectorAll('[data-rating]')) {
        button.addEventListener('click', () => review(button.dataset.rating));
      }
      const ttsPrompt = view.querySelector('#fc-tts-prompt');
      if (ttsPrompt) ttsPrompt.addEventListener('click', () => speak(card.prompt, promptLanguage(card)));
      const ttsAnswer = view.querySelector('#fc-tts-answer');
      if (ttsAnswer) ttsAnswer.addEventListener('click', () => speak(card.answer, answerLanguage(card)));
    };

    const showSummary = () => {
      stopSpeech();
      session.over = true;
      setKeyHandler(null);
      const advanced = session.advanced
        .map((item) => `<li>${esc(item.word)} <span class="muted">→ ${STAGE_NAMES[item.stage]}</span></li>`)
        .join('');
      const reviewedWords = deck.kind === 'reading'
        ? `${session.reviewed} of ${picked.length} words reviewed in both directions`
        : `${session.reviewed} cards reviewed`;
      view.innerHTML = `
        <section class="flashcards fc-summary">
          <h2>Revision complete</h2>
          <p class="muted">${reviewedWords}.</p>
          ${advanced ? `<h3>Vocabulary advanced</h3><ul class="fc-advanced">${advanced}</ul>` : ''}
          <button class="btn primary" id="fc-back" type="button">Back to deck</button>
        </section>`;
      view.querySelector('#fc-back').addEventListener('click', () => {
        entries = listWords().map((word) => ({ ...word, english: englishFor(word, dicts) }));
        renderDetails(currentDeck(deck.id));
      });
    };

    const abandon = () => {
      if (session.over) return;
      stopSpeech();
      session.over = true;
      setKeyHandler(null);
      renderDetails(deck);
    };

    setKeyHandler((event) => {
      if (session.over) return;
      const key = event.key;
      const target = event.target;
      const onControl = target && (
        target.tagName === 'BUTTON' ||
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT'
      );
      if (key === 'Escape') {
        event.preventDefault();
        abandon();
      } else if (session.revealed) {
        const ratingByKey = { '1': 'again', '2': 'hard', '3': 'good', '4': 'easy' };
        if (ratingByKey[key]) {
          event.preventDefault();
          review(ratingByKey[key]);
        } else if (key === 'f' || key === 'n' || key === 'F' || key === 'N' || key === 'Backspace') {
          event.preventDefault();
          review('again');
        } else if (key === 'k' || key === 'y' || key === 'K' || key === 'Y') {
          event.preventDefault();
          review('good');
        }
      } else if (key === ' ' || key === 'Enter') {
        if (onControl && key === 'Enter') return;
        event.preventDefault();
        reveal();
      }
    });

    showCard();
  }

  view.innerHTML = '<section class="vocab"><p class="muted">Loading your decks…</p></section>';
  renderDecks();
  loadDicts();

  return () => {
    stopSpeech();
    setKeyHandler(null);
  };
}
