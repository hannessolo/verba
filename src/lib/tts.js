// Browser-native text-to-speech via the Web Speech API
// (window.speechSynthesis). No network and no API key: the voices are the
// ones installed on the device (macOS/Windows system voices, Apple voices on
// iOS, Google TTS on Android). Local OS voices work offline — the "Google …"
// network voices in Chromium do not — so when picking a voice we prefer
// voice.localService for reliable PWA/offline use.
//
// The module degrades to a no-op where the API is missing (very old or
// unusual browsers): available() is false and speak()/stop() do nothing.

// Fallback BCP-47 tags used when the device has no discoverable voice for
// the language (iOS sometimes returns an empty voice list but still
// synthesizes fine when the utterance carries the lang tag).
const DEFAULT_TAGS = { it: 'it-IT', es: 'es-ES', fr: 'fr-FR', en: 'en-US' };

let voices = [];
let lastCancel = 0;
let inited = false;

export function supported() {
  return typeof speechSynthesis !== 'undefined' &&
    typeof SpeechSynthesisUtterance !== 'undefined';
}

function refresh() {
  if (!supported()) return;
  const v = speechSynthesis.getVoices();
  if (v && v.length) voices = v;
}

// Start loading the device's voices. In most browsers getVoices() is empty
// until the async voiceschanged event fires; without this the first clicks
// would fall back to the default voice. Idempotent: views call it on every
// render and the voiceschanged listener must be registered only once.
export function initVoices() {
  if (!supported() || inited) return;
  inited = true;
  refresh();
  try {
    speechSynthesis.addEventListener('voiceschanged', refresh);
  } catch {
    speechSynthesis.onvoiceschanged = refresh;
  }
}

// Best voice for a language ('it' | 'es' | 'fr' | 'en' or a full tag).
// Prefers local (offline-capable) voices, then any match, then null.
export function pickVoice(lang) {
  if (!voices.length) refresh();
  const l = String(lang || '').toLowerCase().replace('_', '-');
  if (!l) return null;
  const matches = voices.filter(
    (v) => v.lang && v.lang.toLowerCase().replace('_', '-').startsWith(l)
  );
  if (!matches.length) return null;
  const local = matches.filter((v) => v.localService);
  return (local.length ? local : matches)[0];
}

// true when something can plausibly speak `lang` on this device. Not a
// guarantee (an empty voice list + no default voice fails silently) but
// enough to decide whether to show the UI.
export function available(lang) {
  if (!supported()) return false;
  if (voices.length) return !!pickVoice(lang);
  return true; // voices still loading — assume the system has one
}

// Speak `text` in `lang` at `rate`. Cancels any speech in flight first.
export function speak(text, lang, rate = 1) {
  stop();
  if (!supported() || !text) return;
  // Calling speak() immediately after cancel() drops the utterance in some
  // Chromium versions — defer it briefly.
  if (Date.now() - lastCancel < 150) setTimeout(() => doSpeak(text, lang, rate), 80);
  else doSpeak(text, lang, rate);
}

function doSpeak(text, lang, rate) {
  try {
    const u = new SpeechSynthesisUtterance(text);
    const v = pickVoice(lang);
    if (v) {
      u.voice = v;
      u.lang = v.lang;
    } else {
      const l = String(lang || '').toLowerCase();
      u.lang = DEFAULT_TAGS[l] || l;
    }
    u.rate = Number(rate) || 1;
    // Chrome desktop silently stops mid-utterance on long text (sentences
    // are long enough to hit this); a periodic resume() keeps it going.
    const timer = setInterval(() => {
      if (speechSynthesis.speaking && !speechSynthesis.paused)
        speechSynthesis.resume();
    }, 10000);
    u.onend = () => clearInterval(timer);
    u.onerror = () => clearInterval(timer);
    speechSynthesis.speak(u);
  } catch (e) {
    console.warn('text-to-speech failed', e);
  }
}

// Stop any speech in flight. Safe to call when nothing is speaking.
export function stop() {
  if (!supported()) return;
  try {
    if (speechSynthesis.speaking || speechSynthesis.pending) {
      lastCancel = Date.now();
      speechSynthesis.cancel();
    }
  } catch (e) {
    console.warn('text-to-speech stop failed', e);
  }
}