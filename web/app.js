/* Say It In Mandarin — phrase prompter for spoken practice. */

(() => {
'use strict';

const DATA = window.PHRASE_DATA;
const BY_ID = new Map(DATA.phrases.map(p => [p.id, p]));
const CATS  = new Map(DATA.categories.map(c => [c.id, c]));

/* Two rendered tracks exist: `natural` (+0%) and `slow` (-45%, where the voice
   actually enunciates more carefully rather than just stretching). The speed
   slider is continuous, so we pick whichever track is closer to the requested
   pace and cover the remainder with playbackRate. preservesPitch keeps the tone
   contours intact — pitch is meaning in Mandarin, so this is non-negotiable. */
const SLOW_TRACK_CUTOFF = 0.72;   // at or below this, prefer the slow rendering
const RATE_MIN = 0.5, RATE_MAX = 2.0;

const store = {
  get(k, fallback) {
    try { const v = localStorage.getItem('sim.' + k); return v === null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set(k, v) { try { localStorage.setItem('sim.' + k, JSON.stringify(v)); } catch {} },
};

let favs   = new Set(store.get('favs', []));
let speed  = store.get('speed', 55);          // percent of native speaking pace
let modes  = Object.assign({ step: false, loop: false, shadow: false }, store.get('modes', {}));
let recent = store.get('recent', []);         // phrase ids, most recently played first
// Ninety phrases is a lot to face cold, so a first-time visitor lands on the
// starter set rather than the full list.
let filter = store.get('filter', 'start');
let query  = '';
let current = null;                            // phrase object shown in the sheet

const $ = sel => document.querySelector(sel);
const el = {
  list: $('#list'), chips: $('#chips'), search: $('#search'), empty: $('#empty'),
  sheet: $('#detail'), dEn: $('#d-en'), dNote: $('#d-note'), dHanzi: $('#d-hanzi'),
  dPhon: $('#d-phon'), dSandhi: $('#d-sandhi'),
  playBtn: $('#play-btn'), speed: $('#speed'), speedVal: $('#speed-val'),
  favBtn: $('#fav-btn'), toast: $('#toast'), shadowHint: $('#shadow-hint'),
};

/* ── Audio engine ────────────────────────────────────────────────────────
   One shared <audio> element, reused for every clip. This matters on iOS:
   once the element has been started by a user gesture it stays unlocked, so
   later programmatic plays inside a sequence are allowed. A fresh element per
   clip would be blocked. It also keeps AirPods routing and the lock-screen
   controls attached to a single stable source. */

const audio = new Audio();
audio.preload = 'auto';
for (const k of ['preservesPitch', 'mozPreservesPitch', 'webkitPreservesPitch']) {
  if (k in audio) audio[k] = true;
}

let generation = 0;      // bumped to cancel any in-flight sequence
let rafId = null;

const trackFor = target => (target <= SLOW_TRACK_CUTOFF ? 'slow' : 'natural');

/** How fast a track speaks relative to the natural rendering, measured from
 *  its own timing data rather than assumed from the requested TTS percentage. */
function pace(phrase, track) {
  const end = t => { const a = phrase.timing[t]; const l = a[a.length - 1]; return l.t + l.d; };
  return track === 'natural' ? 1 : end('natural') / end(track);
}

function playbackPlan(phrase, targetPct) {
  const target = targetPct / 100;
  const track = trackFor(target);
  const rate = Math.min(RATE_MAX, Math.max(RATE_MIN, target / pace(phrase, track)));
  return { track, rate, src: `audio/${phrase.id}.${track}.mp3` };
}

const sleep = (ms, gen) => new Promise(res => setTimeout(() => res(gen === generation), ms));

let cancelActive = null;   // aborts the clip currently in flight

/** Surface a playback failure instead of failing silently. Defined here and
 *  assigned below, once the toast helper exists. */
let playbackFailed = () => {};

/** Play [from, to) of the current source, resolving true if it ran to the end
 *  and false if it was cancelled.
 *
 *  Sequencing is driven by the audio element's own `timeupdate`/`ended` events,
 *  never by requestAnimationFrame. rAF is suspended in a backgrounded or
 *  screen-off tab, but media events keep firing — and phone-in-pocket with
 *  AirPods in is the main way this app gets used, so loop and shadow mode have
 *  to survive it. rAF is used only to paint the highlight, which nobody can see
 *  in that state anyway. */
function playRange(from, to, gen, onTick) {
  return new Promise(resolve => {
    let settled = false;
    let timer = null;
    let loadTimer = null;

    const cleanup = () => {
      audio.removeEventListener('timeupdate', check);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('canplay', start);
      audio.removeEventListener('error', onLoadFail);
      clearTimeout(timer);
      clearTimeout(loadTimer);
      if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
      if (cancelActive === finish) cancelActive = null;
    };
    function finish(ok) {
      if (settled) return;
      settled = true;
      cleanup();
      audio.pause();
      resolve(ok);
    }
    function check() {
      if (gen !== generation) return finish(false);
      if (audio.currentTime >= to) finish(true);
    }
    function onEnded() { finish(gen === generation); }

    const paint = () => {
      if (settled || gen !== generation) return;
      if (onTick) onTick(audio.currentTime);
      rafId = requestAnimationFrame(paint);
    };

    function onLoadFail() {
      playbackFailed('That clip could not be loaded');
      finish(false);
    }

    function start() {
      if (gen !== generation) return finish(false);
      cancelActive = finish;
      clearTimeout(loadTimer);
      try { audio.currentTime = from; } catch {}
      audio.addEventListener('timeupdate', check);
      audio.addEventListener('ended', onEnded);
      audio.play().then(() => {
        // Backstop in case timeupdate is coarser than the segment is short.
        const ms = ((to - from) / (audio.playbackRate || 1)) * 1000 + 140;
        timer = setTimeout(() => finish(gen === generation), ms);
        if (!document.hidden) rafId = requestAnimationFrame(paint);
      }).catch(err => {
        // Autoplay blocked, decode failure, or the element was torn down.
        if (err && err.name !== 'AbortError') playbackFailed('Tap play again to start audio');
        finish(false);
      });
    }

    if (audio.readyState >= 2) {
      start();
    } else {
      audio.addEventListener('canplay', start, { once: true });
      audio.addEventListener('error', onLoadFail, { once: true });
      // A clip that never loads must not leave the player hanging on "stop"
      // forever with nothing playing.
      loadTimer = setTimeout(onLoadFail, 8000);
      audio.load();
    }
  });
}

function stopPlayback() {
  generation++;
  if (cancelActive) cancelActive(false);
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  audio.pause();
  setPlayingUI(false);
  highlight(-1);
}

/** Run one pass of a phrase, honouring step mode. */
async function playOnce(phrase, plan, gen) {
  const timing = phrase.timing[plan.track];
  if (modes.step) {
    for (let i = 0; i < timing.length; i++) {
      highlight(i);
      const ok = await playRange(timing[i].t, timing[i].t + timing[i].d, gen);
      if (!ok) return false;
      if (!(await sleep(340 / plan.rate, gen))) return false;
    }
    highlight(-1);
    return true;
  }
  const end = timing[timing.length - 1];
  const ok = await playRange(0, end.t + end.d + 0.25, gen, t => {
    let idx = -1;
    for (let i = 0; i < timing.length; i++) if (t >= timing[i].t - 0.02) idx = i;
    highlight(idx);
  });
  highlight(-1);
  return ok;
}

async function play(phrase) {
  stopPlayback();
  noteUsed(phrase.id);
  const gen = ++generation;
  const plan = playbackPlan(phrase, speed);

  if (!audio.src.endsWith(plan.src)) audio.src = plan.src;
  audio.playbackRate = plan.rate;
  setMediaSession(phrase);
  setPlayingUI(true);

  try {
    do {
      audio.playbackRate = plan.rate;   // Safari resets this when src reloads
      const ok = await playOnce(phrase, plan, gen);
      if (!ok) return;

      if (modes.shadow) {
        // Silence roughly as long as the phrase, so you can say it back.
        const timing = phrase.timing[plan.track];
        const last = timing[timing.length - 1];
        const spoken = ((last.t + last.d) / plan.rate) * 1000;
        if (!(await sleep(Math.max(900, spoken * 1.15), gen))) return;
      } else if (modes.loop) {
        if (!(await sleep(700, gen))) return;
      }
    } while (modes.loop || modes.shadow);
  } finally {
    // Covers every exit: finished, cancelled, or play() rejected (autoplay
    // blocked, missing file). Without this the button stays stuck on "stop"
    // with nothing playing. Skipped if a newer playback already took over.
    if (gen === generation) {
      setPlayingUI(false);
      highlight(-1);
    }
  }
}

/** Play a single syllable in its real phrase context (tap-a-character). */
async function playSyllable(phrase, index) {
  stopPlayback();
  const gen = ++generation;
  const plan = playbackPlan(phrase, speed);
  if (!audio.src.endsWith(plan.src)) audio.src = plan.src;
  audio.playbackRate = plan.rate;

  const t = phrase.timing[plan.track][index];
  highlight(index);
  setPlayingUI(true);
  await playRange(t.t, t.t + t.d, gen);
  if (gen === generation) { highlight(-1); setPlayingUI(false); }
}

/* AirPods stem-squeeze and lock-screen controls map onto play/pause, which is
   the whole point of this app: replay without taking your phone out. */
function setMediaSession(phrase) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: phrase.en,
    artist: `${phrase.zh}  ·  ${phrase.py}`,
    album: 'Say It In Mandarin',
    artwork: [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
  });
  const handlers = {
    play:  () => play(phrase),
    pause: () => stopPlayback(),
    stop:  () => stopPlayback(),
    previoustrack: () => play(phrase),
    nexttrack:     () => play(phrase),
  };
  for (const [action, fn] of Object.entries(handlers)) {
    try { navigator.mediaSession.setActionHandler(action, fn); } catch {}
  }
}

/* ── Rendering ───────────────────────────────────────────────────────── */

const TONE_PATH = {
  1: '<path d="M1 3h13"/>',
  2: '<path d="M1.5 7.5L13.5 2"/>',
  3: '<path d="M1.5 2.5L6 7.5L13.5 2"/>',
  4: '<path d="M1.5 2L13.5 7.5"/>',
  5: '<circle cx="7.5" cy="4.5" r="1.7" fill="currentColor" stroke="none"/>',
};
const toneSvg = tone => `<svg class="syl-tone" viewBox="0 0 15 9" aria-hidden="true">${TONE_PATH[tone]}</svg>`;

const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** One column per syllable. The English respelling is the headline: it's the
 *  thing you actually read out loud. Hanzi and pinyin sit underneath as
 *  optional reference — useful to show someone, useless to read from if you
 *  can't read either script. Tone shows as colour plus a contour mark, so it
 *  survives even with both scripts switched off. */
function syllablesHtml(phrase, { interactive }) {
  const timing = phrase.timing.slow;
  return phrase.syllables.map((s, i) => {
    // `said` is the tone actually pronounced — it differs from the dictionary
    // tone wherever sandhi applies, and the spoken one is the only one worth
    // showing to someone learning to say this out loud.
    const tone = s.said || s.tone;
    const wordEnd = timing[i + 1] && timing[i + 1].word !== timing[i].word;
    const tag = interactive ? 'button' : 'span';
    return `<${tag} class="syl t${tone}${wordEnd ? ' word-end' : ''}${s.sandhi ? ' sandhi' : ''}"` +
           (interactive ? ` data-syl="${i}" aria-label="${esc(s.say)}"` : '') + '>' +
             `<span class="syl-say">${esc(s.say)}</span>` +
             toneSvg(tone) +
             `<span class="syl-han">${esc(s.han)}</span>` +
             `<span class="syl-py">${esc(s.say_py || s.py)}</span>` +
           `</${tag}>`;
  }).join('');
}

/** Compact preview for list cards — respelling first, script second. */
function inlineZh(phrase) {
  return `<span class="card-say">`
       + phrase.syllables.map(s => `<span class="t${s.said || s.tone}">${esc(s.say)}</span>`).join(' ')
       + `</span>`
       + `<span class="card-script"> ${esc(phrase.zh)}</span>`;
}

const PLAY_ICON = '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z"/></svg>';
const STAR_ICON = '<svg class="card-fav" viewBox="0 0 24 24"><path d="M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8-5.3-2.8-5.3 2.8 1-5.8L3.5 9.7l5.9-.9z"/></svg>';

const VIRTUAL_FILTERS = {
  all:    () => true,
  start:  p => p.starter != null,
  recent: p => recent.includes(p.id),
  fav:    p => favs.has(p.id),
};

function matches(p) {
  const virtual = VIRTUAL_FILTERS[filter];
  if (virtual ? !virtual(p) : p.cat !== filter) return false;
  if (!query) return true;
  const hay = `${p.en} ${p.py} ${p.zh} ${p.phon}`.toLowerCase();
  return query.split(/\s+/).every(w => hay.includes(w));
}

/** Remember what's been played so the Recent filter reflects real use. */
function noteUsed(id) {
  const wasEmpty = recent.length === 0;
  recent = [id, ...recent.filter(x => x !== id)].slice(0, 12);
  store.set('recent', recent);
  // The Recent chip only exists once there's something in it, so its first
  // appearance needs the strip rebuilt. Later plays just reorder the list.
  if (wasEmpty) renderChips();
  renderQuickbar();
}

function cardHtml(p) {
  return `<button class="card" data-id="${p.id}">
    <span class="card-text">
      <span class="card-en">${esc(p.en)}${favs.has(p.id) ? ' ' + STAR_ICON : ''}</span>
      <span class="card-zh">${inlineZh(p)}</span>
    </span>
    <span class="card-play" data-play="${p.id}" role="button" aria-label="Play ${esc(p.en)}">${PLAY_ICON}</span>
  </button>`;
}

function renderList() {
  let hits = DATA.phrases.filter(matches);
  el.empty.hidden = hits.length > 0;

  if (filter === 'start') hits.sort((a, b) => a.starter - b.starter);
  if (filter === 'recent') hits.sort((a, b) => recent.indexOf(a.id) - recent.indexOf(b.id));

  const intro = (filter === 'start' && !query)
    ? `<p class="list-intro">Twelve to learn first — the ones you'll use nearly every day.
       Once these feel easy, work through the categories.</p>`
    : '';

  // Group under headings only when browsing everything; a filtered or searched
  // view is short enough that headings would be more noise than signal.
  if (filter === 'all' && !query) {
    el.list.innerHTML = DATA.categories.map(c => {
      const items = hits.filter(p => p.cat === c.id);
      if (!items.length) return '';
      return `<h2 class="cat-head">${c.emoji} ${esc(c.name)}</h2>` + items.map(cardHtml).join('');
    }).join('');
  } else {
    el.list.innerHTML = intro + hits.map(cardHtml).join('');
  }
}

function renderChips() {
  const all = [
    { id: 'start', name: 'Start here', emoji: '🌱' },
    { id: 'all', name: 'All', emoji: '' },
    // Only worth offering once there's something in them.
    ...(recent.length ? [{ id: 'recent', name: 'Recent', emoji: '🕘' }] : []),
    ...(favs.size ? [{ id: 'fav', name: 'Favourites', emoji: '★' }] : []),
    ...DATA.categories,
  ];
  el.chips.innerHTML = all.map(c =>
    `<button class="chip" data-cat="${c.id}" aria-pressed="${filter === c.id}">${c.emoji} ${esc(c.name)}</button>`
  ).join('');
}

function highlight(index) {
  const nodes = el.dHanzi.querySelectorAll('.syl');
  nodes.forEach((n, i) => n.classList.toggle('active', i === index));
}

function setPlayingUI(on) {
  el.playBtn.classList.toggle('playing', on);
  el.playBtn.setAttribute('aria-label', on ? 'Stop' : 'Play');
  document.querySelectorAll('.card-play.playing').forEach(n => n.classList.remove('playing'));
  if (on && current) {
    const node = el.list.querySelector(`[data-play="${current.id}"]`);
    if (node) node.classList.add('playing');
  }
}

function updateSpeedUI() {
  el.speed.value = speed;
  el.speedVal.textContent = speed + '%';
  const pct = ((speed - el.speed.min) / (el.speed.max - el.speed.min)) * 100;
  el.speed.style.setProperty('--fill', pct + '%');
}

function updateModeUI() {
  for (const m of ['step', 'loop', 'shadow']) {
    $('#mode-' + m).setAttribute('aria-pressed', String(modes[m]));
  }
  el.shadowHint.hidden = !modes.shadow;
}

/* ── Sheet ───────────────────────────────────────────────────────────── */

/* Sheets (phrase detail, settings) are modal and back-dismissable. Only one is
   ever open, so a single slot plus one history entry is enough. */
let activeSheet = null;

function showSheet(node) {
  if (activeSheet) hideSheet();
  activeSheet = node;
  renderQuickbar();
  node.hidden = false;
  node.scrollTop = 0;
  document.body.style.overflow = 'hidden';
  history.pushState({ sheet: true }, '');
}

function hideSheet() {
  if (!activeSheet) return;
  const wasDetail = activeSheet === el.sheet;
  activeSheet.hidden = true;
  activeSheet = null;
  document.body.style.overflow = '';
  if (wasDetail) {
    stopRecording();   // never leave the mic live behind a closed sheet
    stopPlayback();
    current = null;
    renderList();
  }
  renderQuickbar();
}

function openSheet(phrase) {
  current = phrase;
  el.dEn.textContent = phrase.en;
  el.dNote.textContent = phrase.note || '';
  el.dNote.hidden = !phrase.note;
  el.dHanzi.innerHTML = syllablesHtml(phrase, { interactive: true });
  el.dPhon.innerHTML = phrase.phon
    ? `Read it out loud: <b>${esc(phrase.phon)}</b> &nbsp;·&nbsp; CAPITALS get the stress`
    : '';
  const shifts = phrase.syllables.filter(s => s.sandhi);
  el.dSandhi.hidden = !shifts.length;
  if (shifts.length) {
    el.dSandhi.innerHTML =
      `<b>${shifts.map(s => esc(s.say)).join(', ')}</b> ` +
      `${shifts.length === 1 ? 'is' : 'are'} underlined because the tone changes here. ` +
      `A low tone turns into a rising one when another low tone follows it — ` +
      `so 你好 is said <b>ní hǎo</b>, never <b>nǐ hǎo</b>. The colour shows what to actually say.`;
  }
  el.favBtn.setAttribute('aria-pressed', String(favs.has(phrase.id)));
  refreshCompareUI();
  showSheet(el.sheet);
  setMediaSession(phrase);
}

function toast(msg) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.toast.hidden = true; }, 2200);
}

/* ── Events ──────────────────────────────────────────────────────────── */

el.list.addEventListener('click', e => {
  const playNode = e.target.closest('[data-play]');
  if (playNode) {
    e.stopPropagation();
    const p = BY_ID.get(playNode.dataset.play);
    if (current && current.id === p.id && !audio.paused) stopPlayback();
    else { current = p; play(p); }
    return;
  }
  const card = e.target.closest('[data-id]');
  if (card) openSheet(BY_ID.get(card.dataset.id));
});

el.chips.addEventListener('click', e => {
  const chip = e.target.closest('[data-cat]');
  if (!chip) return;
  filter = chip.dataset.cat;
  store.set('filter', filter);
  renderChips();
  renderList();
  el.list.scrollIntoView({ block: 'start' });
});

el.search.addEventListener('input', () => {
  query = el.search.value.trim().toLowerCase();
  renderList();
});

el.dHanzi.addEventListener('click', e => {
  const node = e.target.closest('[data-syl]');
  if (node && current) playSyllable(current, Number(node.dataset.syl));
});

el.playBtn.addEventListener('click', () => {
  if (!current) return;
  if (!audio.paused || rafId) stopPlayback();
  else play(current);
});

el.speed.addEventListener('input', () => {
  speed = Number(el.speed.value);
  updateSpeedUI();
});
el.speed.addEventListener('change', () => {
  store.set('speed', speed);
  // Re-start at the new speed so the change is immediately audible.
  if (current && (!audio.paused || rafId)) play(current);
});

for (const m of ['step', 'loop', 'shadow']) {
  $('#mode-' + m).addEventListener('click', () => {
    modes[m] = !modes[m];
    // Loop and shadow both repeat; running them together is ambiguous.
    if (m === 'loop' && modes.loop) modes.shadow = false;
    if (m === 'shadow' && modes.shadow) modes.loop = false;
    store.set('modes', modes);
    updateModeUI();
    if (current && (!audio.paused || rafId)) play(current);
  });
}

el.favBtn.addEventListener('click', () => {
  if (!current) return;
  favs.has(current.id) ? favs.delete(current.id) : favs.add(current.id);
  store.set('favs', [...favs]);
  el.favBtn.setAttribute('aria-pressed', String(favs.has(current.id)));
  renderChips();
  renderQuickbar();
  toast(favs.has(current.id) ? 'Saved to favourites' : 'Removed from favourites');
});

for (const btn of document.querySelectorAll('.close-btn')) {
  btn.addEventListener('click', () => history.back());
}

window.addEventListener('popstate', hideSheet);

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$('#present').hidden) return closePresent();
  if (e.key === 'Escape' && activeSheet) history.back();
  if (e.key === ' ' && current && activeSheet === el.sheet && e.target === document.body) {
    e.preventDefault();
    (!audio.paused || rafId) ? stopPlayback() : play(current);
  }
});

/* ── Present mode ────────────────────────────────────────────────────
   Hands the phone to the other person. Characters are shown as large as the
   viewport allows, because they're what a Chinese reader actually reads — and
   the one part of the phrase this app otherwise keeps hidden. Flip rotates the
   text 180° so the phone can just be slid across a table. */

function openPresent() {
  if (!current) return;
  $('#present-en').textContent = current.en;
  $('#present-zh').textContent = current.zh;
  $('#present-py').textContent = current.py;
  $('#present').hidden = false;
  document.body.style.overflow = 'hidden';
}

function closePresent() {
  $('#present').hidden = true;
  if (!activeSheet) document.body.style.overflow = '';
}

$('#show-btn').addEventListener('click', openPresent);
$('#present-close').addEventListener('click', closePresent);
$('#present-play').addEventListener('click', () => current && play(current));
$('#present-flip').addEventListener('click', e => {
  const on = $('#present').classList.toggle('flipped');
  e.currentTarget.setAttribute('aria-pressed', String(on));
});

/* ── Quick strip ─────────────────────────────────────────────────────
   Live use is bursty and repetitive — the same handful of phrases, needed in
   seconds, one-handed. Those live in the thumb's reach at the bottom rather
   than behind a scrolling chip row at the top. */

function quickList() {
  const ids = [...recent, ...[...favs].filter(id => !recent.includes(id))];
  return ids.map(id => BY_ID.get(id)).filter(Boolean).slice(0, 12);
}

function renderQuickbar() {
  const items = quickList();
  const bar = $('#quickbar');
  bar.hidden = items.length === 0 || !!activeSheet;
  document.body.classList.toggle('has-quickbar', !bar.hidden);
  if (bar.hidden) return;
  $('#quick-tiles').innerHTML = items.map(p =>
    `<button class="quick-tile" data-quick="${p.id}" aria-label="Play ${esc(p.en)}">
       <span class="quick-tile-en">${esc(p.en)}</span>
       <span class="quick-tile-say">${esc(p.phon)}</span>
     </button>`).join('');
}

$('#quick-tiles').addEventListener('click', e => {
  const node = e.target.closest('[data-quick]');
  if (!node) return;
  const p = BY_ID.get(node.dataset.quick);
  if (current && current.id === p.id && !audio.paused) return stopPlayback();
  current = p;
  play(p);
});

/* ── Deep links ──────────────────────────────────────────────────────
   iOS won't let a PWA register Siri phrases, widgets or Back Tap directly, but
   the Shortcuts app can "Open URL" — and a Shortcut *can* be bound to Back Tap
   and the Action Button. Supporting ?p= and ?present= is what makes that
   bridge possible. */

function applyDeepLink() {
  const q = new URLSearchParams(location.search);
  const p = q.get('p') && BY_ID.get(q.get('p'));
  const cat = q.get('cat');
  if (cat && (CATS.has(cat) || VIRTUAL_FILTERS[cat])) {
    filter = cat;
    renderChips();
    renderList();
  }
  if (p) {
    openSheet(p);
    if (q.get('present') === '1') openPresent();
  }
}

/* ── Record & compare ────────────────────────────────────────────────
   Hearing yourself straight after the native clip is the only reliable way to
   notice you've been drilling a wrong tone. Deliberately a plain A/B rather
   than speech recognition: SpeechRecognition is unreliable-to-absent in iOS
   Safari, which is the one browser this has to work in. */

const myAudio = new Audio();
const recordings = new Map();   // phrase id -> { url }
let mediaRecorder = null;
let recTimer = null;

const REC_MIME = ('MediaRecorder' in window)
  ? ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg']
      .find(t => { try { return MediaRecorder.isTypeSupported(t); } catch { return false; } })
  : undefined;

const canRecord = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia
                     && 'MediaRecorder' in window);

function refreshCompareUI() {
  $('#compare').hidden = !canRecord;
  if (!canRecord) return;
  const has = current && recordings.has(current.id);
  $('#cmp-actions').hidden = !has;
  $('#cmp-hint').hidden = !has;
  $('#rec-btn').hidden = !!has;
}

async function startRecording() {
  stopPlayback();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    return toast('Microphone access is needed to record');
  }

  const chunks = [];
  try {
    mediaRecorder = REC_MIME ? new MediaRecorder(stream, { mimeType: REC_MIME })
                             : new MediaRecorder(stream);
  } catch {
    stream.getTracks().forEach(t => t.stop());
    return toast("This browser can't record audio");
  }

  const phraseId = current.id;
  mediaRecorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  mediaRecorder.onstop = () => {
    // Releasing the mic matters on iOS, which otherwise keeps showing the
    // in-use indicator for as long as the tab is open.
    stream.getTracks().forEach(t => t.stop());
    clearInterval(recTimer);
    mediaRecorder = null;

    const old = recordings.get(phraseId);
    if (old) URL.revokeObjectURL(old.url);
    if (chunks.length) {
      const blob = new Blob(chunks, { type: chunks[0].type || REC_MIME || 'audio/webm' });
      recordings.set(phraseId, { url: URL.createObjectURL(blob) });
    }
    $('#rec-btn').classList.remove('recording');
    $('#rec-label').textContent = 'Record yourself';
    refreshCompareUI();
    if (current && current.id === phraseId && recordings.has(phraseId)) playComparison(true);
  };

  mediaRecorder.start();
  const started = Date.now();
  $('#rec-btn').classList.add('recording');
  $('#rec-label').textContent = 'Stop  0:00';
  recTimer = setInterval(() => {
    const s = Math.floor((Date.now() - started) / 1000);
    $('#rec-label').textContent = `Stop  0:${String(s).padStart(2, '0')}`;
    if (s >= 15) stopRecording();          // safety cap
  }, 250);
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
}

/** Play a recording, resolving when it finishes or is cancelled. */
function playBlob(url, gen) {
  return new Promise(resolve => {
    let settled = false;
    const done = ok => {
      if (settled) return;
      settled = true;
      myAudio.removeEventListener('ended', onEnd);
      myAudio.pause();
      resolve(ok);
    };
    function onEnd() { done(gen === generation); }
    myAudio.addEventListener('ended', onEnd);
    myAudio.src = url;
    myAudio.playbackRate = 1;
    myAudio.play()
      .then(() => { cancelActive = done; })
      .catch(() => done(false));
  });
}

async function playComparison(includeNative) {
  const rec = current && recordings.get(current.id);
  if (!rec) return;
  stopPlayback();
  const gen = ++generation;
  setPlayingUI(true);

  try {
    if (includeNative) {
      const plan = playbackPlan(current, speed);
      if (!audio.src.endsWith(plan.src)) audio.src = plan.src;
      audio.playbackRate = plan.rate;
      const timing = current.timing[plan.track];
      const last = timing[timing.length - 1];
      const ok = await playRange(0, last.t + last.d + 0.2, gen, t => {
        let idx = -1;
        for (let i = 0; i < timing.length; i++) if (t >= timing[i].t - 0.02) idx = i;
        highlight(idx);
      });
      highlight(-1);
      if (!ok) return;
      if (!(await sleep(450, gen))) return;
    }
    await playBlob(rec.url, gen);
  } finally {
    if (gen === generation) { setPlayingUI(false); highlight(-1); }
  }
}

$('#rec-btn').addEventListener('click', () => {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') stopRecording();
  else if (current) startRecording();
});
$('#cmp-both').addEventListener('click', () => playComparison(true));
$('#cmp-mine').addEventListener('click', () => playComparison(false));
$('#cmp-redo').addEventListener('click', () => {
  const rec = current && recordings.get(current.id);
  if (rec) { URL.revokeObjectURL(rec.url); recordings.delete(current.id); }
  refreshCompareUI();
  startRecording();
});

/* ── Settings ────────────────────────────────────────────────────────── */

const BUILD = (document.querySelector('meta[name="app-build"]') || {}).content || '';
// The deploy workflow substitutes the placeholder; if it's still there we're
// running an unstamped local copy.
const BUILD_LABEL = (!BUILD || BUILD.startsWith('__')) ? 'dev' : BUILD;

const DISPLAY_OPTS = {
  tones:  { key: 'opt-tones',  cls: 'no-tone-colour', invert: true },
  hanzi:  { key: 'opt-hanzi',  cls: 'hide-hanzi',     invert: true },
  pinyin: { key: 'opt-pinyin', cls: 'hide-pinyin',    invert: true },
};

// Hanzi and pinyin default off: the English respelling is what you read, and
// two scripts you can't read yet are just noise around it.
let prefs = Object.assign(
  { tones: true, hanzi: false, pinyin: false, autocheck: true },
  store.get('prefs', {})
);

function applyPrefs() {
  for (const [name, o] of Object.entries(DISPLAY_OPTS)) {
    const on = prefs[name] !== false;
    // Each class *disables* a feature, so it's applied when the toggle is off.
    document.documentElement.classList.toggle(o.cls, o.invert ? !on : on);
    const input = $('#' + o.key);
    if (input) input.checked = on;
  }
  $('#opt-autocheck').checked = prefs.autocheck !== false;
}

function savePrefs() { store.set('prefs', prefs); }

const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

const isIOS = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

let deferredInstall = null;   // Chrome/Android beforeinstallprompt event

function refreshInstallSection() {
  const group = $('#install-group');
  const iosCard = $('#ios-install');
  const btn = $('#install-btn');

  // Already installed — nothing useful to offer.
  if (isStandalone()) { group.hidden = true; return; }

  // iOS has no programmatic install; Safari's Share sheet is the only route,
  // so the honest thing is to say exactly where to tap.
  const showIOS = isIOS() && !deferredInstall;
  iosCard.hidden = !showIOS;
  btn.hidden = !deferredInstall;
  group.hidden = iosCard.hidden && btn.hidden;
}

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredInstall = e;
  refreshInstallSection();
});

window.addEventListener('appinstalled', () => {
  deferredInstall = null;
  refreshInstallSection();
  toast('Installed — open it from your home screen');
});

$('#install-btn').addEventListener('click', async () => {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  await deferredInstall.userChoice;
  deferredInstall = null;
  refreshInstallSection();
});

function bytes(n) {
  if (!n) return '0 MB';
  return n > 1e9 ? (n / 1e9).toFixed(1) + ' GB' : Math.max(1, Math.round(n / 1e6)) + ' MB';
}

async function refreshStorage() {
  const sub = $('#offline-sub');
  const total = DATA.phrases.length * Object.keys(DATA.tracks).length;
  try {
    const cache = await caches.open('sim-audio');
    const saved = (await cache.keys()).length;
    if (saved >= total) {
      sub.textContent = `All ${total} clips saved`;
      $('#offline-pill').textContent = 'Saved';
      $('#offline-pill').dataset.state = 'done';
    } else {
      sub.textContent = saved
        ? `${saved} of ${total} clips saved`
        : 'Works with no signal once saved';
      $('#offline-pill').textContent = 'Save';
      delete $('#offline-pill').dataset.state;
    }
  } catch {
    sub.textContent = 'Works with no signal once saved';
  }
  if (navigator.storage && navigator.storage.estimate) {
    try {
      const { usage } = await navigator.storage.estimate();
      if (usage) sub.textContent += ` · ${bytes(usage)} used`;
    } catch {}
  }
}

function refreshFavsRow() {
  $('#favs-sub').textContent = favs.size
    ? `${favs.size} phrase${favs.size === 1 ? '' : 's'} saved`
    : 'No favourites saved';
}

function openSettings() {
  $('#about-build').textContent = BUILD_LABEL;
  $('#about-voice').textContent = DATA.voice;
  $('#about-count').textContent = String(DATA.phrases.length);
  refreshInstallSection();
  refreshFavsRow();
  refreshStorage();
  showSheet($('#settings'));
}

$('#menu-btn').addEventListener('click', openSettings);

for (const [name, o] of Object.entries(DISPLAY_OPTS)) {
  $('#' + o.key).addEventListener('change', e => {
    prefs[name] = e.target.checked;
    savePrefs();
    applyPrefs();
  });
}

$('#opt-autocheck').addEventListener('change', e => {
  prefs.autocheck = e.target.checked;
  savePrefs();
});

/* Pre-download every clip so the app works with no signal at all. */
$('#offline-btn').addEventListener('click', async e => {
  const pill = $('#offline-pill');
  const sub = $('#offline-sub');
  if (pill.dataset.state === 'busy') return;

  const urls = [];
  for (const p of DATA.phrases) for (const t of Object.keys(DATA.tracks)) urls.push(`audio/${p.id}.${t}.mp3`);

  pill.dataset.state = 'busy';
  pill.textContent = '0%';
  let done = 0, failed = 0;
  for (const u of urls) {
    try { const r = await fetch(u); if (!r.ok) failed++; } catch { failed++; }
    done++;
    pill.textContent = Math.round((done / urls.length) * 100) + '%';
    sub.textContent = `Saving ${done} of ${urls.length}…`;
  }
  await refreshStorage();
  toast(failed ? `Saved, but ${failed} clip${failed === 1 ? '' : 's'} failed` : 'All audio available offline');
});

$('#clear-audio-btn').addEventListener('click', async () => {
  await caches.delete('sim-audio');
  await refreshStorage();
  toast('Saved audio cleared');
});

$('#clear-favs-btn').addEventListener('click', () => {
  if (!favs.size) return;
  favs.clear();
  store.set('favs', []);
  refreshFavsRow();
  renderList();
  toast('Favourites cleared');
});

/* ── Updates ─────────────────────────────────────────────────────────
   The worker no longer calls skipWaiting() on install, so a new version parks
   in `waiting` until the user accepts it here. */

let swReg = null;
let acceptedUpdate = false;

/* Whether a worker already controlled this page distinguishes an update from a
 * first install, and it is only unambiguous here — read at script evaluation,
 * before any registration. Later the initial worker's clients.claim() sets a
 * controller mid-install, and a first install briefly parks in `waiting` before
 * auto-activating; both would otherwise make a brand new visitor's first load
 * look like an update and offer to update them to what they just downloaded. */
const HAD_CONTROLLER = 'serviceWorker' in navigator && !!navigator.serviceWorker.controller;

function setUpdateStatus(text) { $('#update-status').textContent = text; }

function showUpdatePrompt() {
  if (!HAD_CONTROLLER) return;   // a first install is not an update
  $('#update-bar').hidden = false;
  setUpdateStatus('Update ready to install');
}

$('#update-later').addEventListener('click', () => {
  $('#update-bar').hidden = true;
  toast('You can update from the menu any time');
});

$('#update-now').addEventListener('click', () => {
  const waiting = swReg && swReg.waiting;
  if (!waiting) { $('#update-bar').hidden = true; return location.reload(); }
  acceptedUpdate = true;
  $('#update-now').textContent = 'Updating…';
  waiting.postMessage({ type: 'SKIP_WAITING' });
});

$('#check-btn').addEventListener('click', () => checkForUpdate(true));

async function checkForUpdate(manual) {
  if (!swReg) return;
  const pill = $('#check-pill');
  if (manual) { pill.dataset.state = 'busy'; pill.textContent = 'Checking'; setUpdateStatus('Checking…'); }
  try {
    await swReg.update();
    // `update()` resolves once the check completes, but a newly found worker
    // still has to install before it reaches `waiting`.
    if (swReg.installing) {
      await new Promise(res => {
        const w = swReg.installing;
        w.addEventListener('statechange', function on() {
          if (w.state === 'installed' || w.state === 'redundant') {
            w.removeEventListener('statechange', on); res();
          }
        });
        setTimeout(res, 12000);
      });
    }
    if (swReg.waiting) {
      showUpdatePrompt();
      if (manual) { delete pill.dataset.state; pill.textContent = 'Update'; }
    } else if (manual) {
      pill.dataset.state = 'done';
      pill.textContent = 'Latest';
      setUpdateStatus(`You're on the newest version (${BUILD_LABEL})`);
      setTimeout(() => { delete pill.dataset.state; pill.textContent = 'Check'; }, 2600);
    }
  } catch {
    if (manual) {
      delete pill.dataset.state;
      pill.textContent = 'Check';
      setUpdateStatus('Could not check — you may be offline');
    }
  }
}

function initServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  // Whether a worker controlled this page *at load* is what distinguishes an
  // update from a first install. It can't be read later: the initial worker's
  // clients.claim() sets a controller mid-install, which would make a brand new
  // visitor's first load look like an update and prompt them to update to the
  // version they just downloaded.
  const hadController = !!navigator.serviceWorker.controller;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // Only reload for an update the user actually asked for; the very first
    // registration also fires this when it claims the page.
    if (acceptedUpdate) location.reload();
  });

  // updateViaCache:'none' keeps the browser from serving sw.js out of the HTTP
  // cache, which would otherwise hide new versions for up to 24 hours.
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
    .then(reg => {
      swReg = reg;
      if (reg.waiting && hadController) showUpdatePrompt();

      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', () => {
          // A worker reaching `installed` when one already controlled the page
          // means this is an update, not a first install.
          if (nw.state === 'installed' && hadController) showUpdatePrompt();
        });
      });

      if (prefs.autocheck !== false) checkForUpdate(false);
      else setUpdateStatus('Automatic checking is off');
    })
    .catch(() => setUpdateStatus('Updates unavailable'));
}

/* ── Boot ────────────────────────────────────────────────────────────── */

playbackFailed = msg => { stopPlayback(); toast(msg); };

applyPrefs();
renderChips();
renderList();
updateSpeedUI();
updateModeUI();
refreshInstallSection();
renderQuickbar();
applyDeepLink();

window.addEventListener('load', initServiceWorker);

})();
