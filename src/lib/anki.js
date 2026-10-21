import JSZip from 'jszip';
import initSqlJs from 'sql.js/dist/sql-wasm-browser.js';
import wasmUrl from 'sql.js/dist/sql-wasm-browser.wasm?url';
import { normalizeReviewState } from './srs.js';

let sqlPromise;

function sqlEngine() {
  if (!sqlPromise) {
    sqlPromise = initSqlJs({ locateFile: () => wasmUrl });
  }
  return sqlPromise;
}

function rows(db, sql) {
  const result = db.exec(sql)[0];
  if (!result) return [];
  return result.values.map((values) =>
    Object.fromEntries(result.columns.map((column, index) => [column, values[index]]))
  );
}

function parseJson(value, label) {
  try {
    return JSON.parse(value || '{}');
  } catch {
    throw new Error(`This Anki deck has invalid ${label} data.`);
  }
}

function id() {
  return globalThis.crypto?.randomUUID?.() ||
    `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function plainText(html) {
  const source = String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:div|p|li|tr|h[1-6])\s*>/gi, '\n');
  const doc = new DOMParser().parseFromString(source, 'text/html');
  return (doc.body.textContent || '').replace(/\u00a0/g, ' ').trim();
}

function reviewStateFromAnki(card, createdAt, lastReviewed) {
  const reps = Math.max(0, Number(card.reps) || 0);
  if (!reps && Number(card.queue) === 0) return null;

  const rawInterval = Number(card.ivl) || 0;
  const interval = rawInterval < 0
    ? Math.abs(rawInterval)
    : Math.max(0, rawInterval) * 1440;
  const dueField = Number(card.due) || 0;
  let due;
  if (Number(card.queue) === 1) {
    due = dueField * 1000;
  } else if (Number(card.queue) === 2 || Number(card.queue) === 3) {
    due = createdAt * 1000 + dueField * 86400000;
  } else {
    due = Date.now();
  }
  if (!Number.isFinite(due)) due = Date.now();

  const last = lastReviewed || due - interval * 60000;
  return normalizeReviewState({
    due,
    interval,
    ease: (Number(card.factor) || 2500) / 1000,
    reps,
    lapses: Math.max(0, Number(card.lapses) || 0),
    last,
  });
}

function fieldIndexes(model) {
  const fields = Array.isArray(model?.flds) ? model.flds : [];
  const names = fields.map((field) => String(field.name || '').trim().toLowerCase());
  const find = (aliases) => names.findIndex((name) => aliases.includes(name));
  let front = find(['front', 'word', 'french', 'target', 'term', 'expression', 'question', 'prompt']);
  let back = find(['back', 'english', 'translation', 'meaning', 'definition', 'answer', 'gloss']);
  if (front < 0) front = 0;
  if (back < 0) {
    back = names.findIndex((name, index) =>
      index !== front && !/(picture|image|photo|audio|sound|recording)/i.test(name)
    );
  }
  return {
    front,
    back: back === front ? -1 : back,
    frontName: names[front],
    backName: names[back],
  };
}

function templateFields(template, model) {
  const references = [...String(template || '').matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)]
    .map(([, expression]) =>
      expression.trim().replace(/^[#/^]\s*/, '').split(':').at(-1).trim().toLowerCase()
    );
  return (Array.isArray(model?.flds) ? model.flds : [])
    .map((field) => String(field.name || '').trim().toLowerCase())
    .filter((name) => references.includes(name));
}

export async function importAnkiPackage(file) {
  const zip = await JSZip.loadAsync(file);
  const collection =
    zip.file('collection.anki2') ||
    zip.file('collection.anki21');
  if (!collection) {
    throw new Error('This file does not contain a supported Anki collection database.');
  }

  const SQL = await sqlEngine();
  let db;
  try {
    db = new SQL.Database(await collection.async('uint8array'));
    const collectionRows = rows(db, 'SELECT crt, decks, models FROM col LIMIT 1');
    if (!collectionRows.length) throw new Error('The Anki collection is empty.');
    const col = collectionRows[0];
    const createdAt = Number(col.crt) || Math.floor(Date.now() / 1000);
    const decks = parseJson(col.decks, 'deck');
    const models = parseJson(col.models, 'note type');
    const notes = new Map(
      rows(db, 'SELECT id, mid, flds FROM notes').map((note) => [String(note.id), note])
    );
    const lastReviews = new Map();
    try {
      for (const review of rows(db, 'SELECT cid, MAX(id) AS last FROM revlog GROUP BY cid')) {
        lastReviews.set(String(review.cid), Number(review.last) || 0);
      }
    } catch (error) {
      console.warn('Anki review history unavailable; importing card intervals only.', error);
    }

    const grouped = new Map();
    let skipped = 0;
    for (const card of rows(
      db,
      'SELECT id, nid, did, ord, queue, due, ivl, factor, reps, lapses FROM cards ORDER BY did, due, id'
    )) {
      const note = notes.get(String(card.nid));
      const model = models[String(note?.mid)];
      if (!note || !model || Number(model.type) !== 0) {
        skipped++;
        continue;
      }
      const indexes = fieldIndexes(model);
      if (indexes.back < 0) {
        skipped++;
        continue;
      }

      const fields = String(note.flds || '').split('\x1f');
      let front = plainText(fields[indexes.front]);
      let back = plainText(fields[indexes.back]);
      const template = Array.isArray(model.tmpls) ? model.tmpls[Number(card.ord)] : null;
      if (template) {
        const referenced = templateFields(template.qfmt, model);
        const usesFront = referenced.includes(indexes.frontName);
        const usesBack = referenced.includes(indexes.backName);
        if ((!usesFront && !usesBack) ||
          (!usesFront && referenced.some((name) => name !== indexes.backName))) {
          skipped++;
          continue;
        }
        if (!usesFront && usesBack) [front, back] = [back, front];
      }
      if (!front || !back) {
        skipped++;
        continue;
      }

      const deckInfo = decks[String(card.did)];
      const name = String(deckInfo?.name || file.name.replace(/\.apkg$/i, '') || 'Imported Anki deck');
      if (!grouped.has(String(card.did))) {
        grouped.set(String(card.did), {
          id: `anki-${id()}`,
          name,
          createdAt: Date.now(),
          cards: [],
        });
      }
      const srs = reviewStateFromAnki(card, createdAt, lastReviews.get(String(card.id)));
      grouped.get(String(card.did)).cards.push({
        id: String(card.id),
        front,
        back,
        suspended: Number(card.queue) === -1,
        ...(srs ? { srs } : {}),
      });
    }

    const imported = [...grouped.values()].filter((deck) => deck.cards.length);
    if (!imported.length) {
      throw new Error(`No supported basic front/back cards were found${skipped ? ` (${skipped} unsupported cards skipped)` : ''}.`);
    }
    return { decks: imported, skipped };
  } finally {
    db?.close();
  }
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/\u001f/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\r\n?/g, '\n')
    .replace(/\n/g, '<br>');
}

function guid() {
  return Math.random().toString(36).slice(2, 12);
}

async function checksum(text) {
  const bytes = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return new DataView(bytes).getUint32(0, false);
}

function scheduleToAnki(state, now, today, newDue, suspended = false) {
  const srs = normalizeReviewState(state);
  if (suspended) {
    return { type: srs?.reps ? 2 : 0, queue: -1, due: newDue, ivl: srs?.interval ? Math.round(srs.interval / 1440) : 0, srs };
  }
  if (!srs || srs.reps === 0) {
    return { type: 0, queue: 0, due: newDue, ivl: 0, srs: null };
  }
  if (srs.interval < 1440) {
    return {
      type: 1,
      queue: 1,
      due: Math.max(Math.floor(now / 1000) + 60, Math.round(srs.due / 1000)),
      ivl: -Math.max(1, Math.round(srs.interval)),
      srs,
    };
  }
  return {
    type: 2,
    queue: 2,
    due: Math.max(0, Math.round((srs.due - today) / 86400000)),
    ivl: Math.max(1, Math.round(srs.interval / 1440)),
    srs,
  };
}

function insert(db, sql, values) {
  const statement = db.prepare(sql);
  try {
    statement.run(values);
  } finally {
    statement.free();
  }
}

export async function downloadAnkiPackage(name, cards, { reversed = false } = {}) {
  if (!Array.isArray(cards) || !cards.length) {
    throw new Error('This deck has no cards to export.');
  }
  const SQL = await sqlEngine();
  const db = new SQL.Database();
  const now = Date.now();
  const nowSeconds = Math.floor(now / 1000);
  const today = Math.floor(now / 86400000) * 86400000;
  const modelId = 1600000000000 + Math.floor(Math.random() * 1000000);
  const createdNoteIds = cards.map((_, index) => now + index * 10 + 1);
  const dconf = {
    id: 1,
    name: 'Default',
    mod: nowSeconds,
    usn: -1,
    maxTaken: 60,
    autoplay: true,
    timer: 0,
    replayq: true,
    new: { bury: true, delays: [1, 10], initialFactor: 2500, ints: [1, 4, 7], order: 1, perDay: 20, separate: true },
    rev: { bury: true, ease4: 1.3, ivlFct: 1, maxIvl: 36500, hardFactor: 1.2, perDay: 200 },
    lapse: { delays: [10], leechAction: 0, leechFails: 8, minInt: 1, mult: 0 },
  };
  const templates = [
    {
      name: 'Card 1',
      ord: 0,
      qfmt: '{{Front}}',
      afmt: '{{FrontSide}}<hr id=answer>{{Back}}',
      bqfmt: '',
      bafmt: '',
      did: null,
      browser: { q: '{{Front}}', a: '{{FrontSide}}<hr id=answer>{{Back}}' },
    },
  ];
  if (reversed) {
    templates.push({
      name: 'Card 2',
      ord: 1,
      qfmt: '{{Back}}',
      afmt: '{{FrontSide}}<hr id=answer>{{Front}}',
      bqfmt: '',
      bafmt: '',
      did: null,
      browser: { q: '{{Back}}', a: '{{FrontSide}}<hr id=answer>{{Front}}' },
    });
  }
  const model = {
    id: modelId,
    name: reversed ? 'Basic (and reversed)' : 'Basic',
    type: 0,
    mod: nowSeconds,
    usn: -1,
    sortf: 0,
    did: 1,
    tmpls: templates,
    flds: [
      { name: 'Front', ord: 0, sticky: false, rtl: false, font: 'Arial', size: 20, media: [] },
      { name: 'Back', ord: 1, sticky: false, rtl: false, font: 'Arial', size: 20, media: [] },
    ],
    css: '.card { font-family: Arial; font-size: 20px; text-align: center; color: black; background-color: white; }',
    latexPre: '\\documentclass[12pt]{article}\\begin{document}',
    latexPost: '\\end{document}',
    req: reversed ? [[0, 'all', [0]], [1, 'all', [1]]] : [[0, 'all', [0]]],
  };
  const deck = {
    id: 1,
    name,
    mod: nowSeconds,
    usn: -1,
    desc: '',
    dyn: 0,
    collapsed: false,
    browserCollapsed: false,
    conf: 1,
    extendNew: 0,
    extendRev: 0,
  };
  const col = {
    id: 1,
    crt: Math.floor(today / 1000),
    mod: nowSeconds,
    scm: nowSeconds,
    ver: 11,
    dty: 0,
    usn: -1,
    ls: 0,
    conf: JSON.stringify({
      activeDecks: [1],
      curDeck: 1,
      curModel: String(modelId),
      nextPos: cards.length,
      sortType: 'noteFld',
      sortBackwards: false,
      timeLim: 0,
    }),
    models: JSON.stringify({ [modelId]: model }),
    decks: JSON.stringify({ 1: deck }),
    dconf: JSON.stringify({ 1: dconf }),
    tags: '{}',
  };

  db.run(`
    CREATE TABLE col (
      id integer primary key, crt integer not null, mod integer not null,
      scm integer not null, ver integer not null, dty integer not null,
      usn integer not null, ls integer not null, conf text not null,
      models text not null, decks text not null, dconf text not null, tags text not null
    );
    CREATE TABLE notes (
      id integer primary key, guid text not null, mid integer not null,
      mod integer not null, usn integer not null, tags text not null,
      flds text not null, sfld integer not null, csum integer not null,
      flags integer not null, data text not null
    );
    CREATE TABLE cards (
      id integer primary key, nid integer not null, did integer not null,
      ord integer not null, mod integer not null, usn integer not null,
      type integer not null, queue integer not null, due integer not null,
      ivl integer not null, factor integer not null, reps integer not null,
      lapses integer not null, left integer not null, odue integer not null,
      odid integer not null, flags integer not null, data text not null
    );
    CREATE TABLE revlog (
      id integer primary key, cid integer not null, usn integer not null,
      ease integer not null, ivl integer not null, lastIvl integer not null,
      factor integer not null, time integer not null, type integer not null
    );
    CREATE TABLE graves (usn integer not null, oid integer not null, type integer not null);
    CREATE INDEX ix_notes_csum ON notes (csum);
    CREATE INDEX ix_cards_nid ON cards (nid);
    CREATE INDEX ix_cards_sched ON cards (did, queue, due);
    CREATE INDEX ix_revlog_cid ON revlog (cid);
  `);
  insert(
    db,
    'INSERT INTO col VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [col.id, col.crt, col.mod, col.scm, col.ver, col.dty, col.usn, col.ls, col.conf, col.models, col.decks, col.dconf, col.tags]
  );

  for (let index = 0; index < cards.length; index++) {
    const item = cards[index];
    const front = String(item.front || '').replace(/\u001f/g, ' ').trim();
    const back = String(item.back || '').replace(/\u001f/g, ' ').trim();
    const fields = `${escapeHtml(front)}\x1f${escapeHtml(back)}`;
    const noteId = createdNoteIds[index];
    insert(
      db,
      'INSERT INTO notes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [noteId, guid(), modelId, nowSeconds, -1, ' ', fields, front, await checksum(front), 0, '']
    );

    const directions = reversed ? 2 : 1;
    for (let ord = 0; ord < directions; ord++) {
      const schedule = reversed ? item.srsPair?.[ord] : item.srs;
      const state = scheduleToAnki(schedule, now, today, index + 1, !!item.suspended);
      const cardId = noteId * 2 + ord;
      const srs = state.srs;
      insert(
        db,
        'INSERT INTO cards VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          cardId, noteId, 1, ord, nowSeconds, -1, state.type, state.queue, state.due,
          state.ivl, Math.round((srs?.ease || 2.5) * 1000), srs?.reps || 0,
          srs?.lapses || 0, 0, 0, 0, 0, '',
        ]
      );
    }
  }

  try {
    const zip = new JSZip();
    zip.file('collection.anki2', db.export());
    zip.file('media', '{}');
    const blob = await zip.generateAsync({
      type: 'blob',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').trim() || 'anki-deck'}.apkg`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } finally {
    db.close();
  }
}
