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
let filter = 'all';
let query  = '';
let current = null;                            // phrase object shown in the sheet

const $ = sel => document.querySelector(sel);
const el = {
  list: $('#list'), chips: $('#chips'), search: $('#search'), empty: $('#empty'),
  sheet: $('#detail'), dEn: $('#d-en'), dNote: $('#d-note'), dHanzi: $('#d-hanzi'),
  dPhon: $('#d-phon'), playBtn: $('#play-btn'), speed: $('#speed'), speedVal: $('#speed-val'),
  favBtn: $('#fav-btn'), toast: $('#toast'), offlineBtn: $('#offline-btn'),
  shadowHint: $('#shadow-hint'),
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

/** Colour each hanzi by its tone so the shape of the word is visible at a glance. */
function hanziHtml(phrase, { interactive }) {
  const sounded = phrase.syllables;
  const timing = phrase.timing.slow;
  let si = 0, out = '';
  for (const ch of phrase.zh) {
    if (/[\s，。？！、：；]/.test(ch)) {
      if (ch.trim()) out += `<span class="syl-punct">${esc(ch)}</span>`;
      continue;
    }
    const s = sounded[si];
    if (!s) break;
    const wordEnd = timing[si + 1] && timing[si + 1].word !== timing[si].word;
    const tag = interactive ? 'button' : 'span';
    out += `<${tag} class="syl t${s.tone}${wordEnd ? ' word-end' : ''}"` +
           (interactive ? ` data-syl="${si}" aria-label="${esc(s.py)}"` : '') + '>' +
             `<span class="syl-han">${esc(s.han)}</span>` +
             `<span class="syl-py">${esc(s.py)}</span>` +
             toneSvg(s.tone) +
           `</${tag}>`;
    si++;
  }
  return out;
}

/** Compact inline hanzi for list cards. */
function inlineZh(phrase) {
  return phrase.syllables
    .map(s => `<span class="t${s.tone}" style="color:var(--t${s.tone})">${esc(s.han)}</span>`)
    .join('') + `<span style="color:var(--text-faint)"> · ${esc(phrase.py)}</span>`;
}

const PLAY_ICON = '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z"/></svg>';
const STAR_ICON = '<svg class="card-fav" viewBox="0 0 24 24"><path d="M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8-5.3-2.8-5.3 2.8 1-5.8L3.5 9.7l5.9-.9z"/></svg>';

function matches(p) {
  if (filter === 'fav' && !favs.has(p.id)) return false;
  if (filter !== 'all' && filter !== 'fav' && p.cat !== filter) return false;
  if (!query) return true;
  const hay = `${p.en} ${p.py} ${p.zh} ${p.phon}`.toLowerCase();
  return query.split(/\s+/).every(w => hay.includes(w));
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
  const hits = DATA.phrases.filter(matches);
  el.empty.hidden = hits.length > 0;

  // Group under headings only when browsing everything; a filtered or searched
  // view is short enough that headings would be more noise than signal.
  if (filter === 'all' && !query) {
    el.list.innerHTML = DATA.categories.map(c => {
      const items = hits.filter(p => p.cat === c.id);
      if (!items.length) return '';
      return `<h2 class="cat-head">${c.emoji} ${esc(c.name)}</h2>` + items.map(cardHtml).join('');
    }).join('');
  } else {
    el.list.innerHTML = hits.map(cardHtml).join('');
  }
}

function renderChips() {
  const all = [
    { id: 'all', name: 'All', emoji: '' },
    { id: 'fav', name: 'Favourites', emoji: '★' },
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

function openSheet(phrase) {
  current = phrase;
  el.dEn.textContent = phrase.en;
  el.dNote.textContent = phrase.note || '';
  el.dNote.hidden = !phrase.note;
  el.dHanzi.innerHTML = hanziHtml(phrase, { interactive: true });
  el.dPhon.innerHTML = phrase.phon ? `Sounds like <b>${esc(phrase.phon)}</b>` : '';
  el.favBtn.setAttribute('aria-pressed', String(favs.has(phrase.id)));
  el.sheet.hidden = false;
  el.sheet.scrollTop = 0;
  document.body.style.overflow = 'hidden';
  history.pushState({ sheet: true }, '');
  setMediaSession(phrase);
}

function closeSheet() {
  stopPlayback();
  el.sheet.hidden = true;
  document.body.style.overflow = '';
  current = null;
  renderList();
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
  toast(favs.has(current.id) ? 'Saved to favourites' : 'Removed from favourites');
});

$('#close-btn').addEventListener('click', () => history.back());

window.addEventListener('popstate', () => { if (!el.sheet.hidden) closeSheet(); });

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !el.sheet.hidden) history.back();
  if (e.key === ' ' && current && !el.sheet.hidden && e.target === document.body) {
    e.preventDefault();
    (!audio.paused || rafId) ? stopPlayback() : play(current);
  }
});

/* Pre-download every clip so the app works with no signal at all. */
el.offlineBtn.addEventListener('click', async () => {
  const urls = [];
  for (const p of DATA.phrases) for (const t of Object.keys(DATA.tracks)) urls.push(`audio/${p.id}.${t}.mp3`);
  el.offlineBtn.disabled = true;
  let done = 0;
  for (const u of urls) {
    try { await fetch(u, { cache: 'force-cache' }); } catch {}
    el.offlineBtn.textContent = `${Math.round((++done / urls.length) * 100)}%`;
  }
  el.offlineBtn.textContent = 'Saved ✓';
  el.offlineBtn.dataset.state = 'done';
  el.offlineBtn.disabled = false;
  toast('All audio available offline');
});

/* ── Boot ────────────────────────────────────────────────────────────── */

playbackFailed = msg => { stopPlayback(); toast(msg); };

renderChips();
renderList();
updateSpeedUI();
updateModeUI();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

})();
