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

  // The free dictionary API 502s/rate-limits fairly often under load. Those
  // are transient — retry a couple of times, and only cache a `null` result
  // once we know it's a *real* answer (word not found, or found but with no
  // phonetic data), so a blip doesn't permanently freeze that word in
  // "no pronunciation available" for every story from then on.
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch('https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(key));
      if (res.status === 404) {
        _cache.ipa[key] = null;
        _persistCache();
        return null;
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);

      const data = await res.json();
      let ipa = null;
      for (const entry of data) {
        if (entry.phonetic) { ipa = entry.phonetic; break; }
        const withText = (entry.phonetics || []).find(p => p.text);
        if (withText) { ipa = withText.text; break; }
      }
      _cache.ipa[key] = ipa;
      _persistCache();
      return ipa;
    } catch {
      if (attempt < 3) await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  return null; // still failing after retries — left uncached so it's retried next time
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
    // earlier ones stay behind as the previous syllable's coda — unless
    // this is the word's first syllable, in which case there's no earlier
    // syllable to hand them to, so the whole cluster stays as the onset
    // (otherwise a word-initial cluster like "sp-" in "specialist" would
    // silently lose its "s").
    let onset = [];
    if (pendingConsonants.length <= 1 || !syllables.length) {
      onset = pendingConsonants;
      pendingConsonants = [];
    } else {
      onset = pendingConsonants.slice(-1);
      const coda = pendingConsonants.slice(0, -1);
      syllables[syllables.length - 1].coda.push(...coda);
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

// Very common pronouns/contractions/function words are either missing from
// the free dictionary entirely (most contractions), or have several unrelated
// dictionary senses where the first one "wins" by accident — e.g. the article
// "a" matched the entry for *the letter A*, producing "a-i" instead of a
// schwa. These are hand-tuned instead, in the same transliteration style as
// the built-in demo script (j for the "h" sound, u for "w", d for soft "th"...).
const WORD_OVERRIDES = {
  i: 'ái', you: 'yu', he: 'ji', she: 'shi', it: 'it', we: 'uí', they: 'déi',
  me: 'mi', him: 'jim', her: 'jer', us: 'as', them: 'dem',
  your: 'yor', our: 'áur', their: 'der', its: 'its',
  "i'm": 'áim', "i've": 'áiv', "i'll": 'áil', "i'd": 'áid',
  "you're": 'yor', "you've": 'yuv', "you'll": 'yul', "you'd": 'yud',
  "he's": 'jis', "she's": 'shis', "it's": 'its',
  "we're": 'uír', "we've": 'uív', "we'll": 'uíl',
  "they're": 'déar', "they've": 'déiv', "they'll": 'déil',
  "don't": 'dóunt', "doesn't": 'dásent', "didn't": 'dídent',
  "can't": 'kant', "couldn't": 'kúdent', "won't": 'uóunt', "wouldn't": 'údent',
  "shouldn't": 'shúdent', "isn't": 'ísent', "aren't": 'arnt',
  "wasn't": 'uásent', "weren't": 'uérent',
  "haven't": 'jávent', "hasn't": 'jásent', "hadn't": 'jádent',
  "let's": 'lets', "that's": 'dats', "there's": 'ders', "here's": 'jirs',
  "what's": 'uáts', "who's": 'jus', "how's": 'jáus', "when's": 'uens', "where's": 'uérs',
  a: 'e', an: 'an', the: 'de', of: 'of', to: 'tu', in: 'in', on: 'on',
  at: 'at', for: 'for', with: 'uiz', from: 'from', by: 'bái',
  is: 'is', am: 'am', are: 'ar', was: 'uós', were: 'uér',
  be: 'bi', been: 'bin', being: 'bí-ing',
  do: 'du', does: 'das', did: 'did',
  have: 'jav', has: 'jas', had: 'jad',
  will: 'uil', would: 'uud', can: 'kan', could: 'kud', should: 'shud',
  may: 'méi', might: 'máit', must: 'mast',
  // "business" has a colloquial "/ˈbɪd.nəs/" transcription in the dictionary
  // source that reads oddly out of context; pin it to the standard sound.
  business: 'bís-nes', one: 'uán',
};

// Strips leading/trailing punctuation (including curly “smart” quotes from
// pasted text) but keeps an apostrophe *inside* a word, e.g. "I'm" or
// "don't" — stripping those broke contraction lookups entirely.
function cleanWord(word) {
  return word
    .replace(/[‘’]/g, "'")
    .replace(/[.,;:?¿!¡"“”«»()]/g, '')
    .replace(/^'+|'+$/g, '');
}

async function wordPronunciation(word) {
  const clean = cleanWord(word);
  if (!clean || !/[a-zA-Z]/.test(clean)) return clean;

  const lower = clean.toLowerCase();
  if (lower in WORD_OVERRIDES) return WORD_OVERRIDES[lower];

  let ipa = await fetchIpa(clean);
  // Gerunds/inflections are sometimes missing their own phonetic data (e.g.
  // "marketing") even though the root word ("market") has it — fall back to
  // the root and approximate the "-ing" ending onto it.
  if (!ipa && lower.endsWith('ing') && lower.length > 5) {
    const stem = lower.slice(0, -3);
    const stemIpa = await fetchIpa(stem) || await fetchIpa(stem + 'e');
    if (stemIpa) ipa = stemIpa + 'ɪŋ';
  }
  if (!ipa) return clean.toLowerCase();
  return ipaToSpanish(ipa) || clean.toLowerCase();
}

// Firing every word in a long sentence at the dictionary API at once tends to
// trigger its rate limiting / transient 502s; a small concurrency cap spreads
// the requests out and comes back noticeably more reliable in practice.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function sentencePronunciation(sentence) {
  const words = sentence.split(/\s+/).filter(Boolean);
  const parts = await mapWithConcurrency(words, 4, wordPronunciation);
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
