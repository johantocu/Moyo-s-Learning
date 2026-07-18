// ---------- tiny DOM-builder helper (no vdom, just direct nodes) ----------

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v; // only ever used with fixed, non-user strings
    else el.setAttribute(k, v);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.appendChild(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(child) : child);
  }
  return el;
}

const INK = '#143644', ORANGE = '#17A8C4', GREEN = '#0FA089', HILITE = '#4FD4E8', CLIENT_INK = '#6B4A9C';

// ---------- state ----------

const state = {
  view: 'library', // 'library' | 'player'
  scripts: loadScripts(),
  script: null,
  part: 0, sent: 0, word: -1, playing: false, loop: false, rate: 1,
  showPron: true, showEs: true, playAll: false,
  pop: null, fluid: false, reads: 0, pulse: false,
  testMode: false, testRunning: false, testMs: 0, recording: false, micBlocked: false,
  attempts: [], micState: 'idle', playingAtt: null,
  newStoryOpen: false, newStoryBusy: false, newStoryProgress: '',
};

let _token = 0;

function setState(patch) {
  Object.assign(state, patch);
  render();
}

// ---------- library (choose / create a story) ----------

function openLibrary() {
  _stop();
  setState({ view: 'library', scripts: loadScripts(), newStoryOpen: false });
}

async function openScript(script) {
  const attempts = await loadAttempts(script.id);
  setState({
    view: 'player', script, part: 0, sent: 0, word: -1, playing: false,
    reads: 0, testMode: false, attempts, fluid: false, pop: null,
  });
}

async function createStory(title, text) {
  setState({ newStoryBusy: true, newStoryProgress: 'Dividiendo el texto...' });
  const script = buildScriptFromText(title || 'Historia sin título', text);

  const allSentences = script.parts.flatMap(p => p.sentences);
  for (let i = 0; i < allSentences.length; i++) {
    setState({ newStoryProgress: `Generando pronunciación y traducción (${i + 1}/${allSentences.length})...` });
    const sn = allSentences[i];
    const [pron, es] = await Promise.all([sentencePronunciation(sn.en), translateToSpanish(sn.en)]);
    sn.pron = pron;
    sn.es = es || '(no disponible)';
  }

  saveCustomScript(script);
  setState({ newStoryBusy: false, newStoryOpen: false, scripts: loadScripts() });
  openScript(script);
}

function removeStory(id, evt) {
  evt.stopPropagation();
  if (!confirm('¿Eliminar esta historia?')) return;
  deleteCustomScript(id);
  setState({ scripts: loadScripts() });
}

// ---------- speech synthesis ----------

function enVoices() {
  if (!('speechSynthesis' in window)) return [];
  return speechSynthesis.getVoices().filter(v => v.lang && v.lang.replace('_', '-').toLowerCase().indexOf('en') === 0);
}

// Fixed voice preference (not user-changeable): Google UK English Male,
// falling back to the female Google UK voice, then to the best-sounding
// voice available if neither is installed on this machine (the "online"
// Google voices can silently disappear between sessions/devices).
function currentVoice() {
  const vs = enVoices();
  if (!vs.length) return null;
  const male = vs.find(v => /google uk english male/i.test(v.name));
  if (male) return male;
  const female = vs.find(v => /google uk english female/i.test(v.name));
  if (female) return female;
  const score = v => {
    const n = (v.name + ' ' + v.voiceURI).toLowerCase();
    let s = 0;
    if (/natural|neural|premium|enhanced|online/.test(n)) s += 100;
    if (n.indexOf('google') >= 0) s += 50;
    if (/siri|samantha|daniel|karen|moira/.test(n)) s += 30;
    if (!v.localService) s += 5;
    return s;
  };
  return vs.slice().sort((a, b) => score(b) - score(a))[0];
}

function _stop() {
  _token++;
  clearTimeout(state._wT);
  try { speechSynthesis.cancel(); } catch { /* not available */ }
}

// Rough syllable count (vowel-group heuristic) used to time the karaoke
// highlight — closer to real speech duration than raw character count
// (e.g. "though" is short to say despite 6 letters).
function estimateSyllables(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 1;
  const groups = w.match(/[aeiouy]+/g);
  let n = groups ? groups.length : 1;
  if (w.length > 2 && w.endsWith('e') && !w.endsWith('le')) n--;
  return Math.max(1, n);
}
function wordDuration(word) {
  return 90 + estimateSyllables(word) * 175;
}

function speak(p, s) {
  if (!('speechSynthesis' in window)) return;
  _stop();
  const tk = _token;
  const script = state.script;
  const sn = script.parts[p].sentences[s];
  const words = sn.en.split(/\s+/);
  setState({ part: p, sent: s, word: -1, playing: true, pop: null });

  const u = new SpeechSynthesisUtterance(sn.en);
  u.lang = 'en-US';
  u.rate = state.rate;
  u.pitch = sn.speaker === 'client' ? 0.78 : 1;
  const v = currentVoice(); if (v) u.voice = v;

  // Chrome/network ("online"/"natural"/"enhanced") voices fire onboundary
  // events unreliably — often all at once, well ahead of the actual audio —
  // so they're not a trustworthy sync source. Drive the highlight purely
  // from a syllable-based timer instead: less "exact" but steady and
  // predictable, which reads as better-synced than a jumpy correction.
  const scheduleNext = (fromWi) => {
    clearTimeout(state._wT);
    if (fromWi >= words.length) return;
    state._wT = setTimeout(() => {
      if (tk !== _token) return;
      setState({ word: fromWi });
      scheduleNext(fromWi + 1);
    }, wordDuration(words[fromWi]) / state.rate);
  };

  u.onstart = () => {
    if (tk !== _token) return;
    scheduleNext(0);
  };
  u.onend = () => {
    if (tk !== _token) return;
    clearTimeout(state._wT);
    advance(words.length);
  };
  state._utt = u;
  speechSynthesis.speak(u);
}

function advance(nWords) {
  if (state.loop) return speak(state.part, state.sent);
  const part = state.script.parts[state.part];
  if (state.sent + 1 < part.sentences.length) return speak(state.part, state.sent + 1);
  if (state.playAll && state.part + 1 < state.script.parts.length) return speak(state.part + 1, 0);
  setState({ playing: false, word: nWords });
}

function goPart(p) {
  if (p < 0 || p >= state.script.parts.length) return;
  const wasPlaying = state.playing;
  _stop();
  if (wasPlaying) { setState({ playAll: false, reads: 0 }); speak(p, 0); }
  else setState({ playAll: false, part: p, sent: 0, word: -1, playing: false, pop: null, reads: 0 });
}

function seekSent(d) {
  let { part, sent, playing } = state;
  const parts = state.script.parts;
  sent += d;
  if (sent < 0) { if (part > 0) { part--; sent = parts[part].sentences.length - 1; } else sent = 0; }
  else if (sent >= parts[part].sentences.length) {
    if (part + 1 < parts.length) { part++; sent = 0; } else sent = parts[part].sentences.length - 1;
  }
  if (playing) speak(part, sent);
  else { _stop(); setState({ part, sent, word: -1, playing: false }); }
}

function wordPron(sn, wi) {
  const clean = t => t.replace(/[.,;:?¿!¡"']/g, '');
  const ws = sn.en.split(/\s+/), ps = (sn.pron || '').split(/\s+/);
  if (!sn.pron) return '';
  if (ws.length === ps.length) return clean(ps[wi]);
  const a = Math.floor(wi * ps.length / ws.length);
  const b = Math.max(a + 1, Math.floor((wi + 1) * ps.length / ws.length));
  return ps.slice(a, b).map(clean).join(' ');
}

function speakWord(s, wi) {
  const p = state.part;
  const sn = state.script.parts[p].sentences[s];
  const word = sn.en.split(/\s+/)[wi].replace(/[.,;:?¿!¡"']/g, '');
  _stop();
  setState({ playing: false, sent: s, word: -1, pop: { s, w: wi } });
  if (!('speechSynthesis' in window) || !word) return;
  const u = new SpeechSynthesisUtterance(word);
  u.lang = 'en-US';
  u.rate = Math.min(state.rate, 0.85);
  u.pitch = sn.speaker === 'client' ? 0.78 : 1;
  const v = currentVoice(); if (v) u.voice = v;
  state._utt = u;
  speechSynthesis.speak(u);
}

// ---------- reads counter (repeat-10x) ----------

function countRead() {
  clearTimeout(state._pulseT);
  const n = state.reads + 1;
  if (n >= 10) {
    setState({ reads: 10, pulse: true });
    state._pulseT = setTimeout(() => {
      setState({ pulse: false });
      if (state.part + 1 < state.script.parts.length) goPart(state.part + 1);
      else setState({ reads: 0, testMode: true });
    }, 800);
  } else {
    setState({ reads: n, pulse: true });
    state._pulseT = setTimeout(() => setState({ pulse: false }), 180);
  }
}
function uncountRead() { setState({ reads: Math.max(0, state.reads - 1) }); }

// ---------- reading test (record + compare attempts) ----------

function fmtMs(ms) {
  const s = Math.floor(ms / 1000);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') + '.' + Math.floor((ms % 1000) / 100);
}

function startTest() {
  _stop();
  state._t0 = Date.now();
  clearInterval(state._ti);
  state._ti = setInterval(() => setState({ testMs: Date.now() - state._t0 }), 100);
  setState({ testRunning: true, testMs: 0, playing: false });
  if (navigator.mediaDevices?.getUserMedia) {
    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
      if (!state.testRunning) { stream.getTracks().forEach(t => t.stop()); return; }
      state._stream = stream; state._chunks = [];
      state._rec = new MediaRecorder(stream);
      state._rec.ondataavailable = e => state._chunks.push(e.data);
      state._rec.start();
      setState({ recording: true });
    }).catch(() => setState({ recording: false, micBlocked: true }));
  }
}

function endTest() {
  clearInterval(state._ti);
  const ms = Date.now() - state._t0;
  const finish = async (blob) => {
    await saveAttempt(state.script.id, ms, blob || null);
    const attempts = await loadAttempts(state.script.id);
    setState({ testRunning: false, recording: false, testMs: ms, attempts });
  };
  if (state._rec && state._rec.state !== 'inactive') {
    state._rec.onstop = () => {
      const blob = new Blob(state._chunks, { type: state._rec.mimeType || 'audio/webm' });
      if (state._stream) state._stream.getTracks().forEach(t => t.stop());
      finish(blob);
    };
    state._rec.stop();
  } else finish(null);
}

function playAttempt(idx) {
  if (state._audio) { state._audio.pause(); state._audio = null; }
  if (state.playingAtt === idx) { setState({ playingAtt: null }); return; }
  const a = state.attempts[idx];
  if (!a || !a.url) return;
  state._audio = new Audio(a.url);
  state._audio.onended = () => setState({ playingAtt: null });
  state._audio.play();
  setState({ playingAtt: idx });
}

async function removeAttempt(idx) {
  if (state._audio) { state._audio.pause(); state._audio = null; }
  const a = state.attempts[idx];
  if (a && a.id != null) await deleteAttempt(a.id);
  const attempts = await loadAttempts(state.script.id);
  setState({ playingAtt: null, attempts });
}

function exitTest() {
  if (state.testRunning) endTest();
  setState({ testMode: false });
}

function askMic() {
  if (!navigator.mediaDevices?.getUserMedia) { setState({ micState: 'denied' }); return; }
  navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
    stream.getTracks().forEach(t => t.stop());
    setState({ micState: 'ok', micBlocked: false });
  }).catch(() => setState({ micState: 'denied', micBlocked: true }));
}

// ---------- keyboard shortcuts ----------

window.addEventListener('keydown', (e) => {
  if (state.view !== 'player' || state.testMode || state.newStoryOpen) return;
  const t = (e.target.tagName || '').toUpperCase();
  if (t === 'SELECT' || t === 'INPUT' || t === 'TEXTAREA') return;
  if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); countRead(); }
  else if (e.code === 'Delete' || e.code === 'Backspace') { e.preventDefault(); uncountRead(); }
});

if ('speechSynthesis' in window) {
  speechSynthesis.getVoices();
  speechSynthesis.onvoiceschanged = () => render();
}

// ---------- progress calculation ----------

function computeProgress() {
  const st = state, script = st.script;
  let totalW = 0, doneW = 0;
  script.parts.forEach((pt, pi) => {
    pt.sentences.forEach((x, i) => {
      const n = x.en.split(/\s+/).length;
      totalW += n;
      if (pi < st.part) doneW += n;
      else if (pi === st.part) {
        if (i < st.sent) doneW += n;
        else if (i === st.sent && st.word >= 0) doneW += Math.min(st.word + 1, n);
      }
    });
  });
  return Math.round(100 * doneW / Math.max(1, totalW));
}

// =====================================================================
// RENDER
// =====================================================================

const root = document.getElementById('root');

function render() {
  root.innerHTML = '';
  if (state.view === 'library') root.appendChild(renderLibrary());
  else root.appendChild(renderPlayer());
}

function renderLibrary() {
  const page = h('div', { class: 'library-page' },
    h('img', { class: 'hero-mascot', src: 'stitch-hero.png', alt: '' })
  );

  const wrap = h('div', { class: 'library' });
  wrap.appendChild(h('header', { class: 'library-header' },
    h('h1', {}, "🎤 Moyo's Learning"),
    h('p', {}, 'Practica tu pronunciación en inglés al estilo karaoke.')
  ));

  const grid = h('div', { class: 'library-grid' });
  state.scripts.forEach(script => {
    const totalSentences = script.parts.reduce((a, p) => a + p.sentences.length, 0);
    const card = h('div', { class: 'story-card', onclick: () => openScript(script) },
      script.id !== 'demo' ? h('button', { class: 'story-delete', onclick: (e) => removeStory(script.id, e) }, '🗑') : null,
      h('div', { class: 'story-card-title' }, script.title),
      h('div', { class: 'story-card-meta' }, `${script.parts.length} partes · ${totalSentences} frases`),
    );
    grid.appendChild(card);
  });

  const newCard = h('div', { class: 'story-card story-card-new', onclick: () => setState({ newStoryOpen: true }) },
    h('div', { class: 'story-card-plus' }, '+'),
    h('div', {}, 'Nueva historia')
  );
  grid.appendChild(newCard);
  wrap.appendChild(grid);

  if (state.newStoryOpen) wrap.appendChild(renderNewStoryModal());
  page.appendChild(wrap);
  return page;
}

const PROMPT_MONOLOGO = `Necesito que me ayudes a preparar un texto en inglés para practicar pronunciación en una app. Es un monólogo: una sola persona hablando, sin diálogo.

Por favor:
1. Corrige cualquier error de ortografía o gramática en inglés.
2. Divide el texto en oraciones completas y claras (una idea por oración cuando sea posible).
3. No agregues numeración, títulos, nombres ni comentarios — devuélveme solo el texto limpio, listo para pegar tal cual.

Aquí está el texto:
[pega aquí tu texto]`;

const PROMPT_DIALOGO = `Necesito que me ayudes a preparar un texto en inglés para practicar pronunciación en una app de karaoke con dos personas hablando (por ejemplo un vendedor/agente y un cliente/prospecto).

Por favor:
1. Corrige cualquier error de ortografía o gramática en inglés.
2. Identifica qué líneas dice cada persona. Si no es obvio quién es quién, pregúntame antes de continuar.
3. Marca cada línea de UNA de las dos personas (la que tenga menos protagonismo o esté "respondiendo", como el cliente/prospecto) con el símbolo › al inicio de la línea. Las líneas de la otra persona no llevan ningún símbolo.
4. Cada intervención va en su propia línea (un salto de línea por cada vez que habla alguien, no juntes frases de personas distintas en la misma línea).
5. No agregues nombres, numeración ni comentarios — devuélveme solo el texto formateado, listo para pegar tal cual.

Aquí está el texto:
[pega aquí tu texto]`;

function renderNewStoryModal() {
  const overlay = h('div', { class: 'modal-overlay', onclick: (e) => { if (e.target === overlay && !state.newStoryBusy) setState({ newStoryOpen: false }); } });

  if (state.newStoryBusy) {
    overlay.appendChild(h('div', { class: 'modal' },
      h('div', { class: 'spinner' }),
      h('p', {}, state.newStoryProgress)
    ));
    return overlay;
  }

  const titleInput = h('input', { type: 'text', placeholder: 'Ej. The Tortoise and the Hare', class: 'field-input' });
  const textArea = h('textarea', { rows: 8, placeholder: 'Pega aquí tu historia en inglés...', class: 'field-input' });

  // Prompt helper box: toggled with plain DOM (no setState/render) so the
  // title/story the user already typed above is never wiped out.
  const promptText = h('pre', { class: 'prompt-text' });
  const copyBtn = h('button', { class: 'btn btn-secondary btn-sm' }, '📋 Copiar');
  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(promptText.textContent).then(() => {
      copyBtn.textContent = '✅ ¡Copiado!';
      setTimeout(() => { copyBtn.textContent = '📋 Copiar'; }, 1500);
    });
  });
  const promptBox = h('div', { class: 'prompt-box', style: { display: 'none' } },
    promptText,
    h('div', { class: 'prompt-box-actions' }, copyBtn),
  );

  let openKind = null;
  function togglePrompt(kind, text) {
    if (openKind === kind) { promptBox.style.display = 'none'; openKind = null; return; }
    promptText.textContent = text;
    promptBox.style.display = 'block';
    openKind = kind;
  }

  const promptButtons = h('div', { class: 'prompt-buttons' },
    h('button', { class: 'btn btn-secondary btn-sm', onclick: () => togglePrompt('mono', PROMPT_MONOLOGO) }, '💬 Prompt: Monólogo'),
    h('button', { class: 'btn btn-secondary btn-sm', onclick: () => togglePrompt('dialogo', PROMPT_DIALOGO) }, '🗣️ Prompt: Diálogo'),
  );

  const modal = h('div', { class: 'modal' },
    h('h2', {}, 'Nueva historia'),
    h('p', { class: 'hint' }, '¿No sabes cómo darle formato al texto? Pídeselo a Claude con uno de estos prompts:'),
    promptButtons,
    promptBox,
    h('label', { class: 'field' }, h('span', {}, 'Título'), titleInput),
    h('label', { class: 'field' }, h('span', {}, 'Historia en inglés'), textArea),
    h('p', { class: 'hint' }, 'La app la dividirá en partes y generará automáticamente la fonética y la traducción de cada frase.'),
    h('p', { class: 'hint' }, 'Si es un diálogo: las líneas de la segunda persona deben empezar con "› " (por ejemplo, "› Have you already one?"). Se mostrarán a la derecha, en cursiva, y se leerán con un tono distinto.'),
    h('div', { class: 'modal-actions' },
      h('button', { class: 'btn btn-secondary', onclick: () => setState({ newStoryOpen: false }) }, 'Cancelar'),
      h('button', { class: 'btn btn-primary', onclick: () => {
        if (!textArea.value.trim()) { alert('Pega una historia en inglés.'); return; }
        createStory(titleInput.value.trim(), textArea.value.trim());
      } }, 'Crear')
    )
  );
  overlay.appendChild(modal);
  return overlay;
}

function renderPlayer() {
  const wrap = h('div', { class: 'player' });
  wrap.appendChild(renderHeader());
  wrap.appendChild(renderMain());
  if (state.testMode) wrap.appendChild(renderTestModal());
  wrap.appendChild(renderReadsButton());
  wrap.appendChild(renderFooter());
  return wrap;
}

function renderHeader() {
  const script = state.script;
  const tabsWrap = h('div', { class: 'tabs' });
  script.parts.forEach((pt, i) => {
    const on = i === state.part;
    tabsWrap.appendChild(h('button', {
      class: 'tab' + (on ? ' tab-active' : ''),
      onclick: () => goPart(i),
    }, pt.label));
  });
  tabsWrap.appendChild(h('button', {
    class: 'btn-chip' + (state.playAll && state.playing ? ' btn-chip-active' : ''),
    onclick: () => { _stop(); setState({ playAll: true }); speak(0, 0); },
  }, '▶ Todo el guion'));
  tabsWrap.appendChild(h('button', { class: 'btn-chip', onclick: startTestFromHeader }, '🎙 Test'));

  return h('header', { class: 'topbar' },
    h('div', { class: 'topbar-row' },
      h('button', { class: 'back-btn', onclick: openLibrary }, '← Mis historias'),
      h('div', { class: 'topbar-title' }, script.title),
    ),
    tabsWrap
  );
}

function startTestFromHeader() { _stop(); setState({ testMode: true, playing: false }); }

function renderMain() {
  const script = state.script;
  const part = script.parts[state.part];
  const main = h('main', { class: 'main' });

  main.appendChild(h('div', { class: 'part-nav' },
    h('button', { class: 'btn btn-secondary', onclick: () => goPart(state.part - 1) }, '⏮ Parte anterior'),
    h('button', { class: 'btn btn-secondary', onclick: () => goPart(state.part + 1) }, 'Parte siguiente ⏭'),
  ));

  main.appendChild(h('div', { class: 'part-heading' },
    h('div', {},
      h('div', { class: 'part-label' }, `Parte ${part.label}`),
      h('div', { class: 'part-title' }, part.title),
      h('div', { class: 'part-status' }, `Frase ${state.sent + 1} de ${part.sentences.length}${state.playAll ? ' · reproduciendo todo el guion' : ''}`),
    ),
    h('button', { class: 'btn btn-secondary', onclick: () => setState({ fluid: !state.fluid }) },
      state.fluid ? '📄 Vista fluida' : '🧩 Por frases')
  ));

  main.appendChild(renderSentences(part));
  main.appendChild(h('div', { class: 'tap-hint' }, 'Toca cualquier frase para escucharla desde ahí. Toca una palabra para su significado.'));
  return main;
}

function renderWordSpan(sn, sentIdx, wi, active, done) {
  const t = sn.en.split(/\s+/)[wi];
  let bg = 'transparent', fg = sn.speaker === 'client' ? CLIENT_INK : INK;
  if (done) fg = GREEN;
  else if (active) {
    if (state.word >= 0 && wi < state.word) fg = GREEN;
    else if (wi === state.word) { bg = HILITE; fg = '#08333B'; }
  }
  if (state.pop && state.pop.s === sentIdx && state.pop.w === wi) { bg = HILITE; fg = '#08333B'; }
  return h('span', {
    class: 'word',
    style: { background: bg, color: fg },
    onclick: (e) => { e.stopPropagation(); speakWord(sentIdx, wi); },
  }, t);
}

function renderSentences(part) {
  const container = h('div', { class: 'sentences' });

  if (state.fluid) {
    const card = h('div', { class: 'sentence-card sentence-card-active' });
    part.sentences.forEach((sn, i) => {
      const done = i < state.sent, active = i === state.sent;
      const isClient = sn.speaker === 'client';
      const row = h('div', {
        class: 'fluid-row' + (isClient ? ' fluid-row-client' : ''),
        onclick: () => { setState({ playAll: false }); speak(state.part, i); },
      });
      const wordsRow = h('div', { class: 'words-row words-row-big' + (isClient ? ' words-row-client' : '') });
      sn.en.split(/\s+/).forEach((_, wi) => wordsRow.appendChild(renderWordSpan(sn, i, wi, active, done)));
      row.appendChild(wordsRow);
      if (state.pop && state.pop.s === i) row.appendChild(renderPopover(sn, i, state.pop.w));
      if (state.showPron) row.appendChild(h('div', { class: 'sentence-pron' }, sn.pron || 'cargando...'));
      if (state.showEs) row.appendChild(h('div', { class: 'sentence-es' }, sn.es || 'cargando...'));
      card.appendChild(row);
    });
    container.appendChild(card);
    return container;
  }

  part.sentences.forEach((sn, i) => {
    const active = i === state.sent, done = i < state.sent;
    const isClient = sn.speaker === 'client';
    const card = h('div', {
      class: 'sentence-card' + (active ? ' sentence-card-active' : ' sentence-card-dim') + (isClient ? ' sentence-card-client' : ''),
      onclick: () => { setState({ playAll: false }); speak(state.part, i); },
    });
    const wordsRow = h('div', { class: 'words-row' + (active ? '' : ' words-row-small') + (isClient ? ' words-row-client' : '') });
    sn.en.split(/\s+/).forEach((_, wi) => wordsRow.appendChild(renderWordSpan(sn, i, wi, active, done)));
    card.appendChild(wordsRow);

    if (state.pop && state.pop.s === i) card.appendChild(renderPopover(sn, i, state.pop.w));
    if (state.showPron) card.appendChild(h('div', { class: 'sentence-pron' }, sn.pron || 'cargando...'));
    if (state.showEs) card.appendChild(h('div', { class: 'sentence-es' }, sn.es || 'cargando...'));
    container.appendChild(card);
  });
  return container;
}

function renderPopover(sn, sentIdx, wi) {
  const word = sn.en.split(/\s+/)[wi].replace(/[.,;:?¿!¡"']/g, '');
  const pron = wordPron(sn, wi);
  return h('div', { class: 'popover', onclick: (e) => e.stopPropagation() },
    h('button', { class: 'popover-play', onclick: (e) => { e.stopPropagation(); speakWord(sentIdx, wi); } }, '🔊'),
    h('span', { class: 'popover-word' }, word),
    h('span', { class: 'popover-pron' }, pron),
    h('button', { class: 'popover-close', onclick: (e) => { e.stopPropagation(); setState({ pop: null }); } }, '✕'),
  );
}

function renderReadsButton() {
  return h('button', {
    class: 'reads-btn' + (state.pulse ? ' reads-btn-pulse' : ''),
    title: 'Marcar una lectura en voz alta (Espacio o Enter)',
    onclick: countRead,
  },
    h('span', { class: 'reads-count' }, `${state.reads}`, h('span', { class: 'reads-total' }, '/10')),
    h('span', { class: 'reads-label' }, 'LECTURAS')
  );
}

function renderFooter() {
  const pct = computeProgress();
  const msg = pct === 0 ? 'Lista para brillar ✨' : pct < 35 ? '¡Buen comienzo! 💪' : pct < 70 ? '¡Vas muy bien! 🔥' : pct < 100 ? '¡Ya casi! 🚀' : '¡Guion completo! 🎉';

  const rates = [0.5, 0.75, 1].map(r => h('button', {
    class: 'btn-chip-dark' + (state.rate === r ? ' btn-chip-dark-active' : ''),
    onclick: () => { setState({ rate: r }); if (state.playing) speak(state.part, state.sent); },
  }, r + '×'));

  return h('div', { class: 'footer' },
    h('div', { class: 'footer-inner' },
      h('div', { class: 'progress-row' },
        h('div', { class: 'progress-track-wrap' },
          h('img', { class: 'mascot', src: 'mascot.png', alt: '', style: { left: `clamp(0px, calc(${pct}% - 20px), calc(100% - 40px))` } }),
          h('div', { class: 'progress-track' }, h('div', { class: 'progress-fill', style: { width: pct + '%' } })),
        ),
        h('span', { class: 'progress-msg' }, `${pct}% · ${msg}`),
      ),
      h('div', { class: 'transport-row' },
        h('button', { class: 'transport-btn', title: 'Frase anterior', onclick: () => seekSent(-1) }, '⏮'),
        h('button', { class: 'transport-play', onclick: () => {
          if (state.playing) { _stop(); setState({ playing: false }); }
          else speak(state.part, state.sent);
        } }, state.playing ? '⏸ Pausar' : '▶ Reproducir'),
        h('button', {
          class: 'transport-btn' + (state.loop ? ' transport-btn-active' : ''),
          title: 'Repetir frase en bucle',
          onclick: () => setState({ loop: !state.loop }),
        }, '🔁'),
        h('button', { class: 'transport-btn', title: 'Frase siguiente', onclick: () => seekSent(1) }, '⏭'),
      ),
      h('div', { class: 'toggles-row' },
        ...rates,
        h('div', { class: 'divider' }),
        h('button', {
          class: 'btn-chip-dark' + (state.showPron ? ' btn-chip-dark-active' : ''),
          onclick: () => setState({ showPron: !state.showPron }),
        }, state.showPron ? 'Pronunciación: sí' : 'Pronunciación: no'),
        h('button', {
          class: 'btn-chip-dark' + (state.showEs ? ' btn-chip-dark-active' : ''),
          onclick: () => setState({ showEs: !state.showEs }),
        }, state.showEs ? 'Traducción: sí' : 'Traducción: no'),
      ),
    )
  );
}

function renderTestModal() {
  const script = state.script;
  const overlay = h('div', { class: 'test-overlay' });
  const inner = h('div', { class: 'test-inner' });

  inner.appendChild(h('div', { class: 'test-head' },
    h('div', {},
      h('div', { class: 'part-label' }, 'Test de lectura'),
      h('div', { class: 'part-title' }, 'Lee todo el guion en voz alta'),
    ),
    h('button', { class: 'close-btn', onclick: exitTest }, '✕'),
  ));

  inner.appendChild(h('div', { class: 'test-timer-box' },
    h('div', {},
      h('div', { class: 'test-time' }, fmtMs(state.testMs)),
      h('div', { class: 'test-rec-label' },
        state.testRunning
          ? (state.recording ? '● Grabando tu voz' : (state.micBlocked ? '🚫 Micrófono bloqueado: revisa los permisos del navegador y recarga' : 'Activando micrófono…'))
          : 'El micrófono se activa al iniciar'),
    ),
    h('button', {
      class: 'test-toggle-btn',
      style: { background: state.testRunning ? '#C0442E' : ORANGE },
      onclick: () => state.testRunning ? endTest() : startTest(),
    }, state.testRunning ? '⏹ Terminar y guardar' : (state.attempts.length ? '🔁 Repetir test' : '▶ Iniciar test')),
  ));

  if (state.micState === 'idle') {
    inner.appendChild(h('div', { class: 'mic-box' },
      h('span', {}, 'Antes de empezar, activa el micrófono:'),
      h('button', { class: 'btn btn-primary', onclick: askMic }, '🎙 Activar micrófono'),
    ));
  }
  if (state.micState === 'ok') {
    inner.appendChild(h('div', { class: 'mic-ok' }, '✅ Micrófono listo — tus lecturas se grabarán'));
  }

  if (state.attempts.length) {
    const list = h('div', { class: 'attempts-list' },
      h('div', { class: 'attempts-title' }, 'Tus intentos'));
    [...state.attempts].reverse().forEach((a, ridx) => {
      const idx = state.attempts.length - 1 - ridx;
      const tag = idx === 0 ? '🌱 Primera' : (idx === state.attempts.length - 1 ? '⭐ Última' : (a.date || ''));
      const row = h('div', { class: 'attempt-row' },
        h('span', { class: 'attempt-n' }, `Intento ${a.n}`),
        h('span', { class: 'attempt-tag' }, tag),
        h('span', { class: 'attempt-time' }, `⏱ ${fmtMs(a.ms)}`),
      );
      if (a.url) {
        row.appendChild(h('button', {
          class: 'attempt-play',
          style: { background: state.playingAtt === idx ? '#C0442E' : ORANGE },
          onclick: (e) => { e.stopPropagation(); playAttempt(idx); },
        }, state.playingAtt === idx ? '⏹ Detener' : '▶ Escuchar'));
      } else {
        row.appendChild(h('span', { class: 'attempt-noaudio' }, 'Sin audio (micrófono no permitido)'));
      }
      row.appendChild(h('button', { class: 'attempt-del', onclick: (e) => { e.stopPropagation(); removeAttempt(idx); } }, '🗑'));
      list.appendChild(row);
    });
    inner.appendChild(list);
  }

  const allParts = h('div', { class: 'all-parts' });
  script.parts.forEach(pt => {
    allParts.appendChild(h('div', { class: 'all-part-card' },
      h('div', { class: 'all-part-label' }, `Parte ${pt.label} · ${pt.title}`),
      h('div', { class: 'all-part-text' }, pt.sentences.map(x => x.en).join(' ')),
    ));
  });
  inner.appendChild(allParts);

  overlay.appendChild(inner);
  return overlay;
}

render();
