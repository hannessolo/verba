import {
  getStage,
  setStage,
  settings,
  saveSettings,
  getPagePosition,
  savePagePosition,
  getCustomTranslations,
  addCustomTranslation,
  removeCustomTranslation,
  IGNORE_STAGE,
} from '../lib/store.js';
import { loadDict, translate } from '../lib/dict.js';
import { tokenize, wordKeysInText } from '../lib/text.js';
import { downloadData, importFromFile, importSummary } from '../lib/transfer.js';

const STAGE_NAMES = ['New', 'Saw it', 'Getting it', 'Almost known', 'Known'];
const IGNORE_LABEL = 'Ignored';

// part-of-speech labels that can appear in dictionary glosses
const POS_LABELS =
  'noun|verb|adj|name|adv|phrase|intj|proverb|prep|prep_phrase|num|pron|conj|character|det|abbrev|particle|article|symbol|punct';

/**
 * Inner HTML for a dictionary gloss with each part of speech on its own
 * line, e.g. "adj: sweet; gentle\nnoun: sweetness; dessert".
 */
function glossLines(gloss) {
  const parts = gloss.split(new RegExp('; (?=(?:' + POS_LABELS + '):)'));
  const re = new RegExp('^(' + POS_LABELS + '): (.*)$', 's');
  return parts
    .map((p) => {
      const m = p.match(re);
      return m
        ? `<span class="wp-pos">${esc(m[1].replace('_', ' '))}</span> ${esc(m[2])}`
        : esc(p);
    })
    .join('<br>');
}

/**
 * Dictionary gloss block for the popup (clippable when long).
 */
function glossBlockHtml(result, dictLoaded) {
  const missingClass = !result ? ' missing' : '';
  const inner = result
    ? glossLines(result.gloss)
    : dictLoaded
      ? 'Not in the offline dictionary'
      : 'Dictionary not loaded yet';
  return `<div class="wp-gloss${missingClass}" id="wp-gloss">${inner}</div>`;
}

/**
 * User-added translations block. Kept separate from the dictionary gloss so
 * it is always fully visible (never clipped), each entry removable.
 */
function customsBlockHtml(key) {
  const customs = getCustomTranslations(key);
  if (!customs.length) return `<div class="wp-customs" id="wp-customs" hidden></div>`;
  let inner = `<div class="wp-custom-head">＋ your translations</div>`;
  customs.forEach((t, i) => {
    inner += `<div class="wp-custom-row"><span>${esc(t)}</span><button class="wp-custom-del" data-i="${i}" type="button" title="Remove this translation">✕</button></div>`;
  });
  return `<div class="wp-customs" id="wp-customs">${inner}</div>`;
}
const LANG_NAMES = { it: 'Italian', es: 'Spanish' };

let uniqueWordsCache = new Map(); // bookId -> [wordKeys]

function uniqueWordsOf(book) {
  if (uniqueWordsCache.has(book.id)) return uniqueWordsCache.get(book.id);
  const seen = new Set();
  for (const ch of book.chapters) {
    for (const k of wordKeysInText(ch.text)) seen.add(k);
  }
  const words = [...seen];
  uniqueWordsCache.set(book.id, words);
  return words;
}

// counts[0..4] are the learning stages; counts[5] is the number of ignored
// words (excluded from the progress total, but shown in the legend).
function stageCounts(book) {
  const counts = [0, 0, 0, 0, 0, 0];
  for (const w of uniqueWordsOf(book)) {
    const s = getStage(w);
    if (s >= 0 && s <= IGNORE_STAGE) counts[s]++;
  }
  return counts;
}

export function renderReader(view, book) {
  // touch devices (phones/tablets): popup becomes a bottom sheet and stage
  // actions close it, so learning a word is a fast tap-tap loop
  const isTouch = matchMedia('(hover: none) and (pointer: coarse)').matches;
  const dictPromise = loadDict(book.language);
  view.innerHTML = `
    <div class="reader-layout">
      <aside class="sidebar">
        <div class="side-card">
          <a class="back-link" href="#">← library</a>
          <h2 class="side-title">${esc(book.title)}</h2>
          ${book.author ? `<div class="side-author">${esc(book.author)}</div>` : ''}
          <div class="badge lang">${LANG_NAMES[book.language] || book.language} → English</div>
          <div id="dict-status" class="muted small">Loading offline dictionary…</div>
        </div>
        <div class="side-card">
          <h3>Progress</h3>
          <div class="big-pct"><span id="pct">0</span>%</div>
          <div class="progress-bar"><div class="progress-fill" id="pct-bar" style="width:0%"></div></div>
          <div class="muted small">of unique words known</div>
          <ul id="stage-legend" class="stage-legend"></ul>
        </div>
        <div class="side-card side-help">
          <h3>How it works</h3>
          <p class="muted small">
            Click any highlighted word to see its translation and set its stage.
            Words fade out of the highlight as you learn them; at stage&nbsp;4 they
            disappear from the highlight entirely. Don't want to learn a word
            (e.g. a name)? Click <b>Ignore word</b> — it stops counting toward
            your progress and can be un-ignored later.
          </p>
          <p class="muted small">
            The dictionary is a starting point — if it's wrong or missing a
            meaning you need, use <b>＋ Add translation</b> to attach your own.
            It's saved with the word everywhere it appears.
          </p>
          <p class="muted small">
            <b>Keyboard:</b> <b>⏎</b> opens the next word to learn. With a word
            open: <b>0–4</b> sets the stage, <b>⏎</b> advances, <b>u</b> goes
            back, <b>n</b> jumps to the next word, <b>i</b> ignores,
            <b>t</b> opens Google Translate, <b>a</b> adds a translation,
            <b>esc</b> closes.
          </p>
        </div>
      </aside>
      <main class="text-col">
        <p class="mobile-hint">Tap a highlighted word to see its translation and set its stage.</p>
        <div class="pager">
          <button class="btn ghost" id="page-prev">← Prev</button>
          <span id="page-label" class="muted small">…</span>
          <button class="btn ghost" id="page-next">Next →</button>
          <span class="header-spacer"></span>
          <label class="muted small" for="page-size">Words per page</label>
          <select id="page-size">
            <option value="200">200</option>
            <option value="400">400</option>
            <option value="600">600</option>
            <option value="1000">1000</option>
            <option value="0">Continuous</option>
          </select>
          <button class="btn ghost" id="reader-export" title="Download all books, progress and learned words as a JSON file">⬇ Export</button>
          <button class="btn ghost" id="reader-import" title="Merge a previously exported JSON file into this library">⬆ Import</button>
          <input type="file" id="reader-import-input" accept=".json,application/json" hidden />
        </div>
        <div id="reading" class="reading"></div>
        <div class="pager-bottom" id="pager-bottom">
          <button class="btn primary" id="page-next-bottom">Next page ↓</button>
        </div>
      </main>
    </div>`;

  const reading = view.querySelector('#reading');
  const pageLabel = view.querySelector('#page-label');
  const prevBtn = view.querySelector('#page-prev');
  const nextBtn = view.querySelector('#page-next');
  const pagerBottom = view.querySelector('#pager-bottom');
  const nextBottomBtn = view.querySelector('#page-next-bottom');
  const sizeSelect = view.querySelector('#page-size');
  let dict = null;

  dictPromise
    .then((d) => {
      dict = d;
      view.querySelector('#dict-status').textContent =
        `Offline dictionary: ${d.size.toLocaleString()} entries.`;
    })
    .catch((e) => {
      console.error(e);
      view.querySelector('#dict-status').textContent =
        'Dictionary failed to load — translations unavailable.';
    });

  // ---- pagination ----
  let pageSize = settings.pageSize ?? 400;
  sizeSelect.value = String(pageSize);
  let pages = [];
  let pageIndex = 0;

  function wordCount(t) {
    return (t.match(/[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ'’\-]*/g) || []).length;
  }

  // group the book's paragraphs into pages of ~pageSize words; a chapter
  // heading always starts a new page; paragraphs are never split
  function buildPages() {
    const result = [];
    let cur = null;
    for (const ch of book.chapters) {
      if (cur && cur.blocks.length) result.push(cur);
      cur = { chapter: ch.title, blocks: [{ type: 'chapter', title: ch.title }], words: 0 };
      for (const para of ch.text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)) {
        const words = wordCount(para);
        const wouldOverflow =
          pageSize > 0 && cur.words > 0 && cur.blocks.length > 1 && cur.words + words > pageSize;
        if (wouldOverflow) {
          result.push(cur);
          cur = { chapter: ch.title, blocks: [], words: 0 };
        }
        cur.blocks.push({ type: 'para', text: para });
        cur.words += words;
      }
    }
    if (cur && cur.blocks.length) result.push(cur);
    return result;
  }

  function renderCurrentPage() {
    if (!pages.length) return;
    if (pageIndex < 0) pageIndex = 0;
    if (pageIndex >= pages.length) pageIndex = pages.length - 1;
    const page = pages[pageIndex];
    let html = '';
    for (const b of page.blocks) {
      html +=
        b.type === 'chapter'
          ? `<h2 class="chapter-title">${esc(b.title)}</h2>`
          : `<p class="para">${paraToHtml(b.text)}</p>`;
    }
    reading.innerHTML = html;
    pageLabel.textContent =
      pageSize === 0
        ? `1 page · continuous`
        : `Page ${pageIndex + 1} of ${pages.length}`;
    prevBtn.disabled = pageIndex === 0;
    const isLastPage = pageIndex === pages.length - 1;
    nextBtn.disabled = isLastPage;
    // bottom "next page" button (mobile only): shown while a next page exists
    pagerBottom.classList.toggle('hidden', pageSize === 0 || isLastPage);
  }

  // scroll so the top of the reading text is in view, i.e. just below the
  // sticky app header — on mobile this also scrolls past the sidebar cards.
  // Desktop keeps the old scroll-to-window-top behaviour (pager row stays
  // visible just below the header there).
  function scrollToText(smooth) {
    const behavior = smooth ? 'smooth' : 'auto';
    if (!matchMedia('(max-width: 820px)').matches) {
      window.scrollTo({ top: 0, behavior });
      return;
    }
    const header = document.querySelector('.app-header');
    const y =
      reading.getBoundingClientRect().top +
      window.scrollY -
      (header ? header.offsetHeight : 0) -
      10;
    window.scrollTo({ top: Math.max(0, y), behavior });
  }

  // rebuild pages, keeping roughly the same relative position
  function rebuildPages() {
    const oldFrac = pages.length > 1 ? pageIndex / (pages.length - 1) : 0;
    pages = buildPages();
    pageIndex = Math.round(oldFrac * Math.max(0, pages.length - 1));
    renderCurrentPage();
  }

  function gotoPage(i, smooth = false, scroll = true) {
    pageIndex = i;
    renderCurrentPage();
    closePopup();
    savePagePosition(book.id, pageIndex);
    if (scroll) scrollToText(smooth);
  }

  // restore last position for this book
  const saved = getPagePosition(book.id);
  rebuildPages();
  if (saved > 0) {
    pageIndex = Math.min(saved, pages.length - 1);
    renderCurrentPage();
  }
  updateProgress(view, book);

  // ---- export / import ----
  view.querySelector('#reader-export').addEventListener('click', downloadData);
  const importInput = view.querySelector('#reader-import-input');
  view.querySelector('#reader-import').addEventListener('click', () => importInput.click());
  importInput.addEventListener('change', async () => {
    const file = importInput.files[0];
    importInput.value = '';
    if (!file) return;
    try {
      const stats = await importFromFile(file);
      // stages/positions may have changed: refresh text, page and progress
      pages = buildPages();
      pageIndex = Math.min(pageIndex, Math.max(0, pages.length - 1));
      renderCurrentPage();
      closePopup();
      updateProgress(view, book);
      alert(importSummary(stats));
    } catch (e) {
      console.error(e);
      alert(`Import failed: ${e.message}`);
    }
  });

  prevBtn.addEventListener('click', () => gotoPage(pageIndex - 1, false, false));
  nextBtn.addEventListener('click', () => gotoPage(pageIndex + 1, false, false));
  // bottom button: advance and scroll the top of the text back into view, so
  // on mobile you never have to scroll past the whole sidebar again
  nextBottomBtn.addEventListener('click', () => gotoPage(pageIndex + 1, true));
  sizeSelect.addEventListener('change', () => {
    pageSize = Number(sizeSelect.value);
    saveSettings({ pageSize });
    rebuildPages(); // keep roughly the same relative position
    closePopup();
    savePagePosition(book.id, pageIndex);
    scrollToText();
  });

  // ---- word popup ----
  let popup = null;
  let current = null; // the .w element the popup is showing
  function closePopup() {
    if (popup) {
      popup.remove();
      popup = null;
    }
    current = null;
  }

  // set the stage of the currently selected word (updates popup, text, progress)
  function applyStage(s) {
    if (!current) return;
    setStage(current.dataset.w, s);
    refreshWordClasses(reading, current.dataset.w);
    updateProgress(view, book);
    if (popup) syncPopupUI(s);
  }

  // update the open popup's dynamic bits (stage name, buttons) in place
  function syncPopupUI(s) {
    if (!popup) return;
    const ignored = s === IGNORE_STAGE;
    popup.querySelectorAll('.wp-stage').forEach((b) =>
      b.classList.toggle('active', !ignored && +b.dataset.s === s)
    );
    popup.querySelector('#wp-stage-name').textContent = ignored ? IGNORE_LABEL : STAGE_NAMES[s];
    const adv = popup.querySelector('#wp-advance');
    const ig = popup.querySelector('#wp-ignore');
    if (ignored) {
      adv.textContent = 'Un-ignore';
      adv.disabled = false;
      ig.style.display = 'none';
    } else {
      adv.textContent = s < 4 ? `Learn → stage ${s + 1}` : 'Known ✓';
      adv.disabled = s === 4;
      ig.style.display = '';
    }
  }

  // first word on the current page that still needs learning: lowest stage
  // among 0–3, in reading order (ignored/known words are skipped)
  function nextWordToLearn() {
    let best = null;
    let bestStage = 4;
    for (const el of reading.querySelectorAll('.w')) {
      const m = el.className.match(/st([0-5])/);
      const s = m ? +m[1] : 0;
      if (s >= 4) continue;
      if (s < bestStage) {
        bestStage = s;
        best = el;
        if (s === 0) break;
      }
    }
    return best;
  }

  // open the popup on a word element, positioned near it
  function openWordAt(el) {
    const r = el.getBoundingClientRect();
    openPopup(el, r.left + r.width / 2, r.bottom);
  }

  // one global click handler: a word opens its popup, anything else closes it
  // (works with taps on mobile too, including taps on the sidebar/header)
  const onDocClick = (e) => {
    const t = e.target instanceof Element ? e.target : null;
    // the click's target can be detached mid-dispatch when our own handlers
    // re-render its ancestors (deleting a custom translation re-renders the
    // gloss block, which contains the delete button) — closest() walks the
    // live tree and would miss the popup then, so also check the composed
    // path, which is fixed at dispatch time
    const inPopup =
      !!popup && !!t && (t.closest('.word-popup') || e.composedPath().includes(popup));
    if (inPopup) return; // popup handles its own clicks
    const w = t && t.closest('.w');
    if (w) openPopup(w, e.clientX, e.clientY);
    else closePopup();
  };
  document.addEventListener('click', onDocClick);

  function openPopup(el, x, y) {
    closePopup();
    current = el;
    const key = el.dataset.w;
    const stage = getStage(key);
    const result = dict ? translate(dict, el.textContent) : null;
    const gtUrl = `https://translate.google.com/?sl=${encodeURIComponent(book.language)}&tl=en&text=${encodeURIComponent(el.textContent)}&op=translate`;

    popup = document.createElement('div');
    popup.className = 'word-popup';
    popup.innerHTML = `
      <div class="wp-word">
        <span>${esc(el.textContent)}
          ${result && result.stem ? `<span class="wp-stem">← ${esc(result.stem)}</span>` : ''}
        </span>
        <a class="wp-gt" id="wp-gt" href="${gtUrl}" target="_blank" rel="noopener" title="Open in Google Translate">translate ↗</a>
      </div>
      ${glossBlockHtml(result, !!dict)}
      <button class="wp-more" id="wp-more" type="button" hidden>Show more…</button>
      ${customsBlockHtml(key)}
      <form class="wp-trans-form" id="wp-trans-form" hidden>
        <input type="text" id="wp-trans-input" placeholder="Add your own translation…" autocomplete="off" />
        <button class="btn primary" type="submit">Add</button>
      </form>
      <div class="wp-stages">
        ${[0, 1, 2, 3, 4]
          .map(
            (s) => `<button class="wp-stage st${s}${s === stage ? ' active' : ''}" data-s="${s}" title="${STAGE_NAMES[s]}"></button>`
          )
          .join('')}
      </div>
      <div class="wp-stage-label muted small">Stage: <b id="wp-stage-name">${stage === IGNORE_STAGE ? IGNORE_LABEL : STAGE_NAMES[stage]}</b></div>
      <div class="wp-actions">
        <button class="btn primary" id="wp-advance">${stage === IGNORE_STAGE ? 'Un-ignore' : stage < 4 ? `Learn → stage ${stage + 1}` : 'Known ✓'}</button>
        <button class="btn ghost" id="wp-ignore"${stage === IGNORE_STAGE ? ' style="display:none"' : ''}>${stage === IGNORE_STAGE ? '' : 'Ignore word'}</button>
        <button class="btn ghost" id="wp-add-trans">＋ Add translation</button>
        <button class="btn ghost" id="wp-close">Close (Esc)</button>
      </div>
      <div class="wp-keys">0–4 stage · ⏎ advance · u back · n next · i ignore · t translate · a add trans · esc close</div>`;
    document.body.appendChild(popup);
    popupOpenWidth = innerWidth;

    // narrow screens: render as a bottom sheet anchored to the screen bottom
    const sheet = matchMedia('(max-width: 700px)').matches;
    popup.classList.toggle('wp-sheet', sheet);
    if (sheet) {
      // if the tapped word ends up behind the sheet, scroll it into view
      const wr = el.getBoundingClientRect();
      const sheetTop = innerHeight - Math.min(innerHeight * 0.75, 540);
      if (wr.bottom > sheetTop + 16) window.scrollBy(0, wr.bottom - sheetTop + 16);
    } else {
      // position near click, clamped to viewport
      const r = popup.getBoundingClientRect();
      let px = x + 12;
      let py = y + 12;
      if (px + r.width > innerWidth - 12) px = x - r.width - 12;
      if (py + r.height > innerHeight - 12) py = innerHeight - r.height - 12;
      if (px < 12) px = 12;
      if (py < 12) py = 12;
      popup.style.left = px + 'px';
      popup.style.top = py + 'px';
    }

    // clip long glosses with a show-more toggle (matches .wp-gloss.clipped max-height)
    function applyGlossClipping() {
      const g = popup.querySelector('#wp-gloss');
      const more = popup.querySelector('#wp-more');
      const tooTall = !g.classList.contains('missing') && g.scrollHeight > 86;
      g.classList.toggle('clipped', tooTall);
      more.hidden = !tooTall;
      more.textContent = tooTall ? 'Show more…' : 'Show less';
    }
    popup.querySelector('#wp-more').addEventListener('click', () => {
      const g = popup.querySelector('#wp-gloss');
      const clipped = g.classList.toggle('clipped');
      popup.querySelector('#wp-more').textContent = clipped ? 'Show more…' : 'Show less';
    });

    // re-render the gloss + custom-translation blocks. Called on open (to
    // bind the delete handlers) and after a translation is added/removed.
    function refreshGlossArea() {
      if (!popup || !current) return;
      const wrap = document.createElement('div');
      wrap.innerHTML =
        glossBlockHtml(dict ? translate(dict, current.textContent) : null, !!dict) +
        customsBlockHtml(current.dataset.w);
      const old = popup.querySelector('#wp-gloss');
      const oldCustoms = popup.querySelector('#wp-customs');
      if (old) old.replaceWith(wrap.children[0], wrap.children[1]);
      if (oldCustoms) oldCustoms.remove(); // stale block from a previous render
      for (const b of popup.querySelectorAll('#wp-customs .wp-custom-del')) {
        b.addEventListener('click', () => {
          removeCustomTranslation(current.dataset.w, +b.dataset.i);
          refreshGlossArea();
        });
      }
      applyGlossClipping();
    }
    refreshGlossArea();

    // "add translation": inline form; on touch it closes after adding (fast tap loop)
    const transForm = popup.querySelector('#wp-trans-form');
    const transInput = popup.querySelector('#wp-trans-input');
    popup.querySelector('#wp-add-trans').addEventListener('click', () => {
      transForm.hidden = !transForm.hidden;
      if (!transForm.hidden) transInput.focus();
    });
    transForm.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!current) return;
      if (addCustomTranslation(current.dataset.w, transInput.value)) {
        transInput.value = '';
        refreshGlossArea();
        if (isTouch) {
          transForm.hidden = true;
          transInput.blur();
        } else {
          transInput.focus(); // keep the form open for adding several
        }
      } else {
        transInput.select(); // empty or duplicate: keep focus for a retry
      }
    });

    for (const b of popup.querySelectorAll('.wp-stage')) {
      b.addEventListener('click', () => applyStage(+b.dataset.s));
    }
    popup.querySelector('#wp-advance').addEventListener('click', () => {
      const s = getStage(current.dataset.w);
      applyStage(s === IGNORE_STAGE ? 0 : Math.min(4, s + 1));
      if (isTouch) closePopup(); // fast tap loop: advance, then tap the next word
    });
    popup.querySelector('#wp-ignore').addEventListener('click', () => {
      applyStage(IGNORE_STAGE);
      if (isTouch) closePopup();
    });
    popup.querySelector('#wp-close').addEventListener('click', closePopup);
    syncPopupUI(stage);
  }

  const onKey = (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return; // don't hijack browser shortcuts
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    // let a focused button handle its own Enter (e.g. after clicking it)
    const onButton = e.target.closest && e.target.closest('button');
    if (e.key === 'Escape') {
      closePopup();
      return;
    }
    if (popup && current) {
      if (/^[0-4]$/.test(e.key)) {
        applyStage(+e.key); // 0 resets to New, 1–4 set the stage (also un-ignores)
        return;
      }
      if ((e.key === 'Enter' || e.key === 'ArrowRight') && !onButton) {
        const s = getStage(current.dataset.w);
        if (s === IGNORE_STAGE) applyStage(0);
        else if (s < 4) applyStage(s + 1);
        return;
      }
      if (e.key === 'u' || e.key === 'U') {
        const s = getStage(current.dataset.w);
        if (s > 0 && s !== IGNORE_STAGE) applyStage(s - 1);
        return;
      }
      if ((e.key === 'n' || e.key === 'N') && !onButton) {
        const nx = nextWordToLearn();
        if (nx && nx !== current) openWordAt(nx);
        return;
      }
      if (e.key === 't' || e.key === 'T') {
        popup.querySelector('#wp-gt').click(); // opens Google Translate in a new tab
        return;
      }
      if (e.key === 'a' || e.key === 'A') {
        const f = popup.querySelector('#wp-trans-form');
        f.hidden = false;
        popup.querySelector('#wp-trans-input').focus();
        return;
      }
      if (e.key === 'i' || e.key === 'I') {
        const s = getStage(current.dataset.w);
        applyStage(s === IGNORE_STAGE ? 0 : IGNORE_STAGE);
        return;
      }
      return;
    }
    // no popup open
    if ((e.key === 'Enter' || e.key === 'n' || e.key === 'N') && !onButton) {
      const nx = nextWordToLearn();
      if (nx) openWordAt(nx);
      return;
    }
    if (e.key === 'ArrowRight' && pageIndex < pages.length - 1) gotoPage(pageIndex + 1);
    else if (e.key === 'ArrowLeft' && pageIndex > 0) gotoPage(pageIndex - 1);
  };
  document.addEventListener('keydown', onKey);
  // close the floating popup on real width changes (orientation), but not on
  // mobile browser address-bar show/hide, which only changes the height
  let popupOpenWidth = 0;
  const onResize = () => {
    if (popup && Math.abs(innerWidth - popupOpenWidth) > 2) closePopup();
  };
  window.addEventListener('resize', onResize);

  return () => {
    closePopup();
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('click', onDocClick);
    window.removeEventListener('resize', onResize);
  };

  // ---- helpers ----

  function paraToHtml(para) {
    const frags = tokenize(para);
    let html = '';
    for (const f of frags) {
      if (f.type === 'text') html += esc(f.value);
      else html += `<span class="w st${getStage(f.key)}" data-w="${esc(f.key)}">${esc(f.value)}</span>`;
    }
    return html;
  }

  function refreshWordClasses(container, key) {
    const s = getStage(key);
    for (const el of container.querySelectorAll(`.w[data-w="${CSS.escape(key)}"]`)) {
      el.className = `w st${s}`;
    }
  }

  function updateProgress(view, book) {
    const counts = stageCounts(book);
    // ignored words (counts[5]) are excluded from the "known" total
    const total = counts.slice(0, 5).reduce((a, b) => a + b, 0);
    const pct = total ? Math.round((counts[4] / total) * 100) : 0;
    const pctEl = view.querySelector('#pct');
    const bar = view.querySelector('#pct-bar');
    if (pctEl) pctEl.textContent = pct;
    if (bar) bar.style.width = pct + '%';
    const legend = view.querySelector('#stage-legend');
    if (legend) {
      const rows = [0, 1, 2, 3, 4]
        .map(
          (s) => `
        <li>
          <span class="dot st${s}"></span>
          <span class="sl-name">${STAGE_NAMES[s]}</span>
          <span class="sl-count">${counts[s].toLocaleString()}</span>
        </li>`
        )
        .join('');
      const ignoredRow = counts[5]
        ? `
        <li class="ignored">
          <span class="dot ignore"></span>
          <span class="sl-name">${IGNORE_LABEL}</span>
          <span class="sl-count">${counts[5].toLocaleString()}</span>
        </li>`
        : '';
      legend.innerHTML = rows + ignoredRow;
    }
  }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
