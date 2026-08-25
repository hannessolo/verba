import { store, setStage, setSrs, srsState, IGNORE_STAGE } from '../lib/store.js';
import { loadDict, translate, translatePhrase } from '../lib/dict.js';

const STAGE_NAMES = ['New', 'Saw it', 'Getting it', 'Almost known', 'Known'];

// SRS review intervals in minutes, one per step 0-6.
const INTERVAL_MIN = [10, 60, 1440, 4320, 10080, 20160, 43200];

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Fisher-Yates shuffle (in place).
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// All stage-0-4 words (phrases included; ignored words excluded).
function listWords() {
  const out = [];
  for (const [key, s] of Object.entries(store.stages)) {
    if (s >= 0 && s <= 4) out.push({ key, stage: s, phrase: key.includes(' ') });
  }
  return out;
}

// English side: first custom translation, else the dictionary (es, then it).
// Returns the full gloss or null.
function englishFor(entry, dicts) {
  const custom = store.translations[entry.key];
  if (Array.isArray(custom) && custom.length) return custom[0];
  if (!dicts) return null; // dictionaries still loading
  for (const d of [dicts.es, dicts.it]) {
    if (!d) continue;
    const r = entry.phrase ? translatePhrase(d, entry.key) : translate(d, entry.key);
    if (r) return r.gloss;
  }
  return null;
}

// Compact gloss for list rows: first segment before "; " (POS prefix kept).
function compact(gloss) {
  return String(gloss || '').split('; ')[0].trim();
}

export function renderVocab(view) {
  let dicts = null; // { es, it } once settled (either may be null on failure)
  let entries = null; // listWords + english/custom, recomputed on each list render
  let filter = 'all';
  let onKey = null;

  // Attach the document-level keydown listener (installed when a flashcard
  // session starts); renderVocab's returned cleanup removes it.
  function setKeyHandler(fn) {
    if (onKey) document.removeEventListener('keydown', onKey);
    if (fn) document.addEventListener('keydown', fn);
    onKey = fn || null;
  }

  async function loadDicts() {
    if (dicts) return dicts;
    const [es, it] = await Promise.all([
      loadDict('es').catch((e) => { console.warn('es dict failed', e); return null; }),
      loadDict('it').catch((e) => { console.warn('it dict failed', e); return null; }),
    ]);
    dicts = { es, it };
    return dicts;
  }

  // ---- vocab list ----

  function renderList() {
    setKeyHandler(null);
    const words = listWords();
    const ignored = Object.values(store.stages).filter((s) => s === IGNORE_STAGE).length;

    view.innerHTML = `
    <section class="vocab">
      <div class="vocab-head">
        <h2 class="vocab-title">Your vocabulary</h2>
        <span class="vocab-counts muted">${words.length} words · ${words.filter((w) => w.stage === 4).length} known · ${words.filter((w) => w.phrase).length} phrases · ${ignored} ignored</span>
      </div>
      <div class="vocab-filters">
        <button class="vocab-filter active" data-f="all">All</button>
        <button class="vocab-filter" data-f="learning">Learning (0-3)</button>
        <button class="vocab-filter" data-f="known">Known (4)</button>
        <button class="vocab-filter" data-f="phrases">Phrases</button>
        <span class="header-spacer"></span>
        <button class="btn primary" id="start-fc" disabled>Start flashcards (0)</button>
      </div>
      <div id="vocab-body"><p class="muted">Loading dictionaries…</p></div>
    </section>`;

    const updateList = () => {
      const body = view.querySelector('#vocab-body');
      const fcBtn = view.querySelector('#start-fc');
      if (!body || !fcBtn) return; // navigated away mid-load
      const eligible = entries.filter((e) => e.english);
      fcBtn.textContent = `Start flashcards (${Math.min(10, eligible.length)})`;
      fcBtn.disabled = !eligible.length;
      fcBtn.onclick = () => startSession(eligible);

      if (!entries.length) {
        body.innerHTML = '<p class="muted">No words yet — read a book and tap the words you don\'t know.</p>';
        return;
      }
      const shown = entries.filter((e) => {
        if (filter === 'learning') return e.stage <= 3;
        if (filter === 'known') return e.stage === 4;
        if (filter === 'phrases') return e.phrase;
        return true;
      });
      const parts = [];
      for (const g of [4, 3, 2, 1, 0]) {
        const group = shown
          .filter((e) => e.stage === g)
          .sort((a, b) => a.key.localeCompare(b.key, undefined, { sensitivity: 'base' }));
        if (!group.length) continue;
        parts.push(`<h3 class="vocab-group">${STAGE_NAMES[g]} <span class="vocab-group-count">· ${group.length}</span></h3>`);
        for (const e of group) {
          const gloss = e.english ? `<span class="vocab-gloss">${esc(compact(e.english))}</span>` : '';
          const customs = e.custom.length
            ? `<span class="vocab-custom">${e.custom.map((c) => `<span class="plus">＋</span> ${esc(c)}`).join('  ')}</span>`
            : '';
          parts.push(
            `<div class="vocab-row">
              <span class="vocab-word${e.phrase ? ' phrase' : ''}">${esc(e.key)}</span>
              <span class="dot st${e.stage}"></span>
              ${gloss}
              ${customs}
            </div>`
          );
        }
      }
      body.innerHTML = parts.join('');
    };

    for (const btn of view.querySelectorAll('.vocab-filter')) {
      btn.addEventListener('click', () => {
        filter = btn.dataset.f;
        for (const b of view.querySelectorAll('.vocab-filter')) b.classList.toggle('active', b === btn);
        updateList();
      });
    }

    entries = words.map((w) => ({
      ...w,
      english: englishFor(w, dicts),
      custom: Array.isArray(store.translations[w.key]) ? store.translations[w.key] : [],
    }));
    updateList();
    // refresh once dictionaries have settled (immediate if already cached)
    loadDicts().then(() => {
      entries = words.map((w) => ({
        ...w,
        english: englishFor(w, dicts),
        custom: Array.isArray(store.translations[w.key]) ? store.translations[w.key] : [],
      }));
      updateList();
    });
  }

  // ---- flashcard session ----

  function pickWords(eligible, n) {
    const now = Date.now();
    const due = (s) => now - s.last > INTERVAL_MIN[s.step] * 60000;
    const never = eligible.filter((w) => !srsState(w.key));
    const dueWords = eligible.filter((w) => { const s = srsState(w.key); return s && due(s); });
    const notDue = eligible.filter((w) => { const s = srsState(w.key); return s && !due(s); });
    const byStage = (a) => a.sort((x, y) => x.stage - y.stage); // stable: random order inside a stage
    const tiers = [
      byStage(shuffle(never.slice())),
      shuffle(dueWords.slice()).sort((x, y) => x.stage - y.stage).sort((x, y) => srsState(x.key).last - srsState(y.key).last),
      byStage(shuffle(notDue.slice())),
    ];
    const out = [];
    for (const tier of tiers) {
      for (const w of tier) {
        if (out.length >= n) break;
        out.push(w);
      }
      if (out.length >= n) break;
    }
    return out;
  }

  function startSession(eligible) {
    const picked = pickWords(eligible, 10);
    if (!picked.length) return;
    const cards = [];
    for (const w of picked) {
      cards.push({ word: w.key, prompt: w.key, answer: w.english });
      cards.push({ word: w.key, prompt: w.english, answer: w.key });
    }
    shuffle(cards);
    // never let the two directions of one word sit side by side
    for (let i = 1; i < cards.length; i++) {
      if (cards[i].word === cards[i - 1].word) {
        let j = i + 1;
        while (j < cards.length && cards[j].word === cards[i - 1].word) j++;
        if (j < cards.length) [cards[i], cards[j]] = [cards[j], cards[i]];
      }
    }

    const session = {
      over: false,
      cards,
      idx: 0,
      revealed: false,
      // per word: { a: bool|null, b: bool|null }
      answers: {},
      advanced: [], // { word, newStage }
    };
    const words = new Map(picked.map((w) => [w.key, w]));

    const commit = (key) => {
      const rec = session.answers[key];
      if (rec.a && rec.b) {
        const w = words.get(key);
        const newStage = Math.min(4, w.stage + 1);
        setStage(key, newStage);
        const st = srsState(key);
        setSrs(key, Math.min(6, (st ? st.step : 0) + 1), Date.now());
        session.advanced.push({ word: key, newStage });
      } else {
        setSrs(key, 0, Date.now());
      }
    };

    const answer = (knew) => {
      if (session.over || !session.revealed) return;
      const card = session.cards[session.idx];
      const rec = session.answers[card.word] || (session.answers[card.word] = { a: null, b: null });
      // direction: a = foreign→english, b = english→foreign
      rec[card.prompt === words.get(card.word).key ? 'a' : 'b'] = knew;
      if (rec.a !== null && rec.b !== null) commit(card.word);
      session.idx++;
      if (session.idx >= session.cards.length) showSummary();
      else showCard();
    };

    const showCard = () => {
      session.revealed = false;
      const card = session.cards[session.idx];
      const n = session.cards.length;
      view.innerHTML = `
      <section class="flashcards">
        <div class="fc-top">
          <span class="fc-progress">${session.idx + 1} / ${n}</span>
          <div class="progress-bar"><div class="progress-fill" style="width:${Math.round((session.idx / n) * 100)}%"></div></div>
        </div>
        <div class="fc-card">
          <div class="fc-prompt">${esc(card.prompt)}</div>
          <button class="btn primary fc-show" id="fc-show">Show answer</button>
        </div>
      </section>`;
      view.querySelector('#fc-show').addEventListener('click', () => reveal());
    };

    const reveal = () => {
      if (session.over || session.revealed) return;
      session.revealed = true;
      const card = session.cards[session.idx];
      const cardEl = view.querySelector('.fc-card');
      cardEl.innerHTML = `
        <div class="fc-prompt">${esc(card.prompt)}</div>
        <div class="fc-answer">${esc(card.answer)}</div>
        <div class="fc-word muted small">${esc(words.get(card.word).key)}</div>
        <div class="fc-buttons">
          <button class="btn ghost" id="fc-miss">✗ Didn't know</button>
          <button class="btn primary" id="fc-hit">✓ Knew it</button>
        </div>`;
      view.querySelector('#fc-miss').addEventListener('click', () => answer(false));
      view.querySelector('#fc-hit').addEventListener('click', () => answer(true));
    };

    const showSummary = () => {
      session.over = true;
      setKeyHandler(null);
      const wordsInSession = words.size;
      const fullyKnown = Object.values(session.answers).filter((r) => r.a && r.b).length;
      const adv = session.advanced
        .map((a) => `<li>${esc(a.word)} <span class="muted">→ ${STAGE_NAMES[a.newStage]}</span></li>`)
        .join('');
      view.innerHTML = `
      <section class="flashcards fc-summary">
        <h2>${fullyKnown} of ${wordsInSession} words fully known · ${session.advanced.length} advanced</h2>
        ${adv ? `<ul class="fc-advanced">${adv}</ul>` : ''}
        <button class="btn primary" id="fc-back">Back to vocabulary</button>
      </section>`;
      view.querySelector('#fc-back').addEventListener('click', renderList);
    };

    // words whose pair is already complete were committed the moment their
    // second card was answered, so abandoning just returns to the list.
    const abandon = () => {
      if (session.over) return;
      session.over = true;
      renderList();
    };

    setKeyHandler((e) => {
      if (session.over) return;
      const k = e.key;
      const t = e.target;
      const onCtl = t && (t.tagName === 'BUTTON' || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
      if (k === 'Escape') { e.preventDefault(); abandon(); return; }
      if (session.revealed) {
        if (k === 'k' || k === 'y' || k === 'K' || k === 'Y' || k === 'Enter') { e.preventDefault(); answer(true); }
        else if (k === 'f' || k === 'n' || k === 'F' || k === 'N' || k === 'Backspace') { e.preventDefault(); answer(false); }
      } else if (k === ' ' || k === 'Enter') {
        if (onCtl && k === 'Enter') return; // let a focused button handle it
        e.preventDefault();
        reveal();
      }
    });

    showCard();
  }

  renderList();

  return () => {
    setKeyHandler(null);
  };
}
