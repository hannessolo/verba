// Plain-text helpers: language detection and tokenization.

// distinctive (non-shared) high-frequency words per language
const STOPWORDS = {
  it: [
    'che', 'questo', 'questa', 'questi', 'queste', 'della', 'delle',
    'perché', 'più', 'già', 'così', 'loro', 'anche', 'dove', 'essere',
    'stato', 'stata', 'stati', 'stare', 'però', 'cui', 'noi', 'voi',
    'dopo', 'sempre', 'tutta', 'tutte', 'tutti', 'molto', 'di', 'un',
    'una', 'per', 'sono', 'come', 'era', 'fu', 'avere', 'fare',
  ],
  es: [
    'las', 'los', 'del', 'por', 'para', 'pero', 'aunque', 'este',
    'esta', 'esto', 'está', 'más', 'mas', 'sus', 'que', 'ha', 'han',
    'había', 'habia', 'fue', 'son', 'hay', 'todo', 'toda', 'todas',
    'todos', 'cada', 'dónde', 'como', 'muy', 'pues', 'ya', 'aquí',
    'alli', 'una',
  ],
};

/** Italian/Spanish detector based on distinctive stopword frequency. */
export function detectLanguage(text) {
  const lower = text.toLowerCase();
  const count = (words) =>
    words.reduce((acc, w) => {
      const re = new RegExp(`(^|[^a-zà-ÿ'’-])${w}($|[^a-zà-ÿ'’-])`, 'g');
      return acc + (lower.match(re) || []).length;
    }, 0);
  const it = count(STOPWORDS.it);
  const es = count(STOPWORDS.es);
  // require a minimum signal and a clear margin before committing
  if (Math.min(it, es) < 3) return null;
  if (it * 2 < es) return 'es';
  if (es * 2 < it) return 'it';
  return null;
}

/** Split text into paragraph blocks. */
export function toParagraphs(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.replace(/\n/g, ' ').trim())
    .filter(Boolean);
}

// matches a word token: letters (incl. accented), internal apostrophes/hyphens
export const WORD_RE = /([A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ'’\-]*)/g;

// leading elision particles (d' l' n' t' c' s' all' dall' dell' nell' un' bell' quell' quall')
// are stripped and rendered as plain text, so "l'altissimo" resolves to "altissimo"
const ELISION_RE = /^(?:d|l|n|t|c|s|de|ne|all|dall|dell|nell|un|bell|quell|quall)[’']/i;

const hasLetter = (s) => /[A-Za-zÀ-ÖØ-öø-ÿ]/.test(s);
// any letter-bearing fragment is a word (incl. 1-char words like "e" and "o" —
// elision particles are stripped before splitting, so no stray "l"/"d" blobs)
const isWordFrag = (s) => hasLetter(s);

const wordKeyOf = (s) => s.toLowerCase().replace(/[’‘`]/g, "'");

/**
 * Split a raw word token into display fragments:
 * - a leading elision particle ("l'", "dell'", …) becomes plain text
 * - the apostrophe otherwise acts as a word separator
 * Returns [{ type: 'text'|'word', value, key? }].
 */
export function splitWordToken(token) {
  const out = [];
  let rest = token;
  const m = rest.match(ELISION_RE);
  if (m) {
    out.push({ type: 'text', value: rest.slice(0, m[0].length) });
    rest = rest.slice(m[0].length);
  }
  for (const part of rest.split(/([’'])/)) {
    if (!part) continue;
    if (/^[’']+$/.test(part)) {
      out.push({ type: 'text', value: part });
    } else if (isWordFrag(part)) {
      out.push({ type: 'word', value: part, key: wordKeyOf(part) });
    } else {
      out.push({ type: 'text', value: part });
    }
  }
  return out;
}

/**
 * Turn a paragraph into an array of { type: 'text'|'word', value, key }
 * fragments, preserving the original token text.
 */
export function tokenize(paragraph) {
  const out = [];
  let last = 0;
  for (const m of paragraph.matchAll(WORD_RE)) {
    if (m.index > last) out.push({ type: 'text', value: paragraph.slice(last, m.index) });
    out.push(...splitWordToken(m[0]));
    last = m.index + m[0].length;
  }
  if (last < paragraph.length) out.push({ type: 'text', value: paragraph.slice(last) });
  return out;
}

/** Set of word keys (elision-stripped) appearing in a text. */
export function wordKeysInText(text) {
  const seen = new Set();
  for (const m of text.matchAll(WORD_RE)) {
    for (const f of splitWordToken(m[0])) {
      if (f.type === 'word') seen.add(f.key);
    }
  }
  return seen;
}

/** Extract readable paragraphs from an XHTML chapter. */
export function htmlToParagraphs(html) {
  const doc = new DOMParser().parseFromString(html, 'application/xhtml+xml');
  // if the parser choked (malformed XML), retry as html
  if (doc.querySelector('parsererror')) {
    const d2 = new DOMParser().parseFromString(html, 'text/html');
    return htmlToParagraphsFromDocument(d2);
  }
  return htmlToParagraphsFromDocument(doc);
}

function htmlToParagraphsFromDocument(doc) {
  for (const sel of ['script', 'style', 'svg', 'nav', 'toc', '[epub\\:type="toc"]']) {
    try {
      for (const el of doc.querySelectorAll(sel)) el.remove();
    } catch {}
  }
  const blocks = doc.querySelectorAll(
    'h1, h2, h3, h4, h5, h6, p, blockquote, li'
  );
  const out = [];
  if (blocks.length) {
    for (const el of blocks) {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (t) out.push(t);
    }
  } else {
    const t = (doc.body && doc.body.textContent) || '';
    for (const p of t.split(/\n+/)) {
      const t2 = p.replace(/\s+/g, ' ').trim();
      if (t2) out.push(t2);
    }
  }
  return out;
}
