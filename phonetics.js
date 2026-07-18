// Turns English text into an approximate "how a Spanish speaker would read it"
// transliteration, using real IPA from a free dictionary API, plus a
// Spanish-to-English translation for meaning. Both results are cached in
// localStorage so repeated words/sentences don't refetch.

const CACHE_KEY = 'moyos-learning-lexicon-cache-v1';
const _cache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
_cache.ipa ||= {};
_cache.es ||= {};

let _saveTimer = null;
function _persistCache() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    localStorage.setItem(CACHE_KEY, JSON.stringify(_cache));
  }, 400);
}

// ---------- IPA lookup ----------

async function fetchIpa(word) {
  const key = word.toLowerCase();
  if (key in _cache.ipa) return _cache.ipa[key];
  let ipa = null;
  try {
    const res = await fetch('https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(key));
    if (res.ok) {
      const data = await res.json();
      for (const entry of data) {
        if (entry.phonetic) { ipa = entry.phonetic; break; }
        const withText = (entry.phonetics || []).find(p => p.text);
        if (withText) { ipa = withText.text; break; }
      }
    }
  } catch { /* offline or blocked: fall through to null */ }
  _cache.ipa[key] = ipa;
  _persistCache();
  return ipa;
}

// ---------- IPA -> Spanish-friendly transliteration ----------

const VOWEL_TOKENS = [
  'ɪə', 'eə', 'ʊə', // closing diphthongs + schwa
  'eɪ', 'aɪ', 'ɔɪ', 'aʊ', 'oʊ', 'əʊ', // diphthongs
  'iː', 'uː', 'ɑː', 'ɔː', 'ɜː', // long vowels
  'i', 'ɪ', 'e', 'ɛ', 'æ', 'ʌ', 'ɑ', 'ɒ', 'ɔ', 'ʊ', 'u', 'ə', 'ɚ', 'ɜ', // short vowels
];
const CONSONANT_TOKENS = [
  'tʃ', 'dʒ', // affricates
  'p', 'b', 't', 'd', 'k', 'g', 'f', 'v', 'θ', 'ð', 's', 'z', 'ʃ', 'ʒ',
  'h', 'm', 'n', 'ŋ', 'l', 'r', 'ɹ', 'j', 'w',
];
const ALL_TOKENS = [...VOWEL_TOKENS, ...CONSONANT_TOKENS].sort((a, b) => b.length - a.length);
const VOWEL_SET = new Set(VOWEL_TOKENS);

const ES_MAP = {
  'iː': 'i', 'ɪ': 'i', 'i': 'i', 'e': 'e', 'ɛ': 'e', 'æ': 'a', 'ʌ': 'a',
  'ɑː': 'a', 'ɑ': 'a', 'ɒ': 'o', 'ɔː': 'o', 'ɔ': 'o', 'ʊ': 'u', 'uː': 'u', 'u': 'u',
  'ə': 'e', 'ɚ': 'er', 'ɜː': 'er', 'ɜ': 'er',
  'eɪ': 'ei', 'aɪ': 'ai', 'ɔɪ': 'oi', 'aʊ': 'au', 'oʊ': 'ou', 'əʊ': 'ou',
  'ɪə': 'ier', 'eə': 'eer', 'ʊə': 'uer',
  'tʃ': 'ch', 'dʒ': 'y', 'p': 'p', 'b': 'b', 't': 't', 'd': 'd', 'k': 'k', 'g': 'g',
  'f': 'f', 'v': 'v', 'θ': 'z', 'ð': 'd', 's': 's', 'z': 's', 'ʃ': 'sh', 'ʒ': 'y',
  'h': 'j', 'm': 'm', 'n': 'n', 'ŋ': 'ng', 'l': 'l', 'r': 'r', 'ɹ': 'r', 'j': 'y', 'w': 'u',
};
const ACCENT = { a: 'á', e: 'é', i: 'í', o: 'ó', u: 'ú' };

function tokenizeIpa(ipa) {
  const clean = ipa.replace(/[/\[\]]/g, '');
  const tokens = [];
  let i = 0;
  while (i < clean.length) {
    const ch = clean[i];
    if (ch === 'ˈ' || ch === 'ˌ') { tokens.push({ stress: ch === 'ˈ' }); i++; continue; }
    if (ch === '.' || ch === ' ' || ch === '-') { i++; continue; }
    let matched = null;
    for (const tok of ALL_TOKENS) {
      if (clean.startsWith(tok, i)) { matched = tok; break; }
    }
    if (matched) {
      tokens.push({ tok: matched, vowel: VOWEL_SET.has(matched) });
      i += matched.length;
    } else {
      i++; // skip unknown symbol (length marks, ties, etc.)
    }
  }
  return tokens;
}

function syllabify(tokens) {
  const syllables = [];
  let pendingConsonants = [];
  let pendingStress = false;
  for (const t of tokens) {
    if ('stress' in t) { pendingStress = t.stress; continue; }
    if (!t.vowel) { pendingConsonants.push(t.tok); continue; }
    // onset: last consonant of the pending run joins this syllable;
    // earlier ones stay behind as the previous syllable's coda.
    let onset = [];
    if (pendingConsonants.length <= 1) {
      onset = pendingConsonants;
      pendingConsonants = [];
    } else {
      onset = pendingConsonants.slice(-1);
      const coda = pendingConsonants.slice(0, -1);
      if (syllables.length) syllables[syllables.length - 1].coda.push(...coda);
      pendingConsonants = [];
    }
    syllables.push({ onset, nucleus: t.tok, coda: [], stressed: pendingStress });
    pendingStress = false;
  }
  if (pendingConsonants.length && syllables.length) {
    syllables[syllables.length - 1].coda.push(...pendingConsonants);
  }
  return syllables;
}

function syllableToEs(syl) {
  const letters = [...syl.onset, syl.nucleus, ...syl.coda].map(t => ES_MAP[t] ?? t);
  if (syl.stressed) {
    const nucleusEs = ES_MAP[syl.nucleus] ?? syl.nucleus;
    const accented = nucleusEs.replace(/[aeiou]/, m => ACCENT[m] || m);
    const nucleusIdx = syl.onset.length;
    letters[nucleusIdx] = accented;
  }
  return letters.join('');
}

function ipaToSpanish(ipa) {
  const tokens = tokenizeIpa(ipa);
  const syllables = syllabify(tokens);
  if (!syllables.length) return null;
  // A one-syllable word has nothing to contrast stress with, but reads
  // more naturally with an accent (matches how the demo script does it).
  if (syllables.length === 1) syllables[0].stressed = true;
  return syllables.map(syllableToEs).join('-');
}

async function wordPronunciation(word) {
  const clean = word.replace(/[.,;:?¿!¡"'()]/g, '');
  if (!clean || !/[a-zA-Z]/.test(clean)) return clean;
  const ipa = await fetchIpa(clean);
  if (!ipa) return clean.toLowerCase();
  return ipaToSpanish(ipa) || clean.toLowerCase();
}

async function sentencePronunciation(sentence) {
  const words = sentence.split(/\s+/).filter(Boolean);
  const parts = await Promise.all(words.map(wordPronunciation));
  return parts.join(' ');
}

// ---------- Spanish translation (free MyMemory API) ----------

async function translateToSpanish(text) {
  const key = text.toLowerCase();
  if (key in _cache.es) return _cache.es[key];
  let translated = null;
  try {
    const res = await fetch('https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text) + '&langpair=en|es');
    if (res.ok) {
      const data = await res.json();
      translated = data?.responseData?.translatedText || null;
    }
  } catch { /* offline or blocked */ }
  _cache.es[key] = translated;
  _persistCache();
  return translated;
}
