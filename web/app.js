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
// The 🐻 checkbox: only the bear-marked phrases, across every category.
let bearOnly = store.get('bear', false);
let query  = '';
let current = null;                            // phrase object shown in the sheet

const $ = sel => document.querySelector(sel);
const el = {
  list: $('#list'), chips: $('#chips'), search: $('#search'), empty: $('#empty'),
  bearOnly: $('#bear-only'),
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

/** load() — which playRange calls for any clip not yet buffered — resets
 *  playbackRate to defaultPlaybackRate. Setting only playbackRate meant a
 *  clip's first play ran at the track's own pace, ignoring the speed slider. */
function setRate(rate) {
  audio.defaultPlaybackRate = rate;
  audio.playbackRate = rate;
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
  setRate(plan.rate);
  setMediaSession(phrase);
  setPlayingUI(true);

  try {
    do {
      setRate(plan.rate);   // load() resets playbackRate, so set it every pass
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
  setRate(plan.rate);

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
       + `</span>`;
}

const PLAY_ICON = '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z"/></svg>';
const COPY_ICON = '<svg class="i-copy" viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>'
                + '<svg class="i-done" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const BEAR_ICON = '<span class="card-bear" role="img" aria-label="bear">🐻</span>';
const STAR_ICON = '<svg class="card-fav" viewBox="0 0 24 24"><path d="M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8-5.3-2.8-5.3 2.8 1-5.8L3.5 9.7l5.9-.9z"/></svg>';

const VIRTUAL_FILTERS = {
  all:    () => true,
  start:  p => p.starter != null,
  recent: p => recent.includes(p.id),
  fav:    p => favs.has(p.id),
};

function matches(p) {
  // Bear-only overrides the category chip: the point is to find every one of
  // them at once, and most aren't in the starter set the list opens on.
  if (bearOnly) {
    if (!p.bear) return false;
  } else {
    const virtual = VIRTUAL_FILTERS[filter];
    if (virtual ? !virtual(p) : p.cat !== filter) return false;
  }
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
      <span class="card-en">${p.bear ? BEAR_ICON : ''}${esc(p.en)}${favs.has(p.id) ? ' ' + STAR_ICON : ''}</span>
      <span class="card-zh">${inlineZh(p)}</span>
      <span class="card-han">
        <span class="card-script" lang="zh-CN">${esc(p.zh)}</span>
        <span class="card-copy" data-copy="${p.id}" role="button" aria-label="Copy ${esc(p.zh)}">${COPY_ICON}</span>
      </span>
    </span>
    <span class="card-play" data-play="${p.id}" role="button" aria-label="Play ${esc(p.en)}">${PLAY_ICON}</span>
  </button>`;
}

/** The phrases the list is showing, in the order it shows them. */
function listHits() {
  const hits = DATA.phrases.filter(matches);
  const view = bearOnly ? 'bear' : filter;
  if (view === 'start') hits.sort((a, b) => a.starter - b.starter);
  if (view === 'recent') hits.sort((a, b) => recent.indexOf(a.id) - recent.indexOf(b.id));
  return hits;
}

/** Passive practice runs on whatever the list is showing, so the chips and
 *  search double as its picker. */
function ppEntryHtml(n) {
  return `<button class="pp-entry" data-pp>
    <span class="pp-entry-icon" aria-hidden="true">🎧</span>
    <span class="pp-entry-text">
      <span class="pp-entry-title">Passive practice</span>
      <span class="pp-entry-sub">${Math.min(PP_SIZE, n)} from this list · English, Mandarin, then you</span>
    </span>
    <span class="pp-entry-go" aria-hidden="true">${PLAY_ICON}</span>
  </button>`;
}

function renderList() {
  const hits = listHits();
  el.empty.hidden = hits.length > 0;

  const view = bearOnly ? 'bear' : filter;

  const intro = (view === 'start' && !query)
    ? `<p class="list-intro">Twelve to learn first — the ones you'll use nearly every day.
       Once these feel easy, work through the categories.</p>`
    : '';
  const entry = hits.length ? ppEntryHtml(hits.length) : '';

  // Group under headings only when browsing everything; a filtered or searched
  // view is short enough that headings would be more noise than signal.
  if (view === 'all' && !query) {
    el.list.innerHTML = entry + DATA.categories.map(c => {
      const items = hits.filter(p => p.cat === c.id);
      if (!items.length) return '';
      return `<h2 class="cat-head">${c.emoji} ${esc(c.name)}</h2>` + items.map(cardHtml).join('');
    }).join('');
  } else {
    el.list.innerHTML = entry + intro + hits.map(cardHtml).join('');
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
    `<button class="chip" data-cat="${c.id}" aria-pressed="${!bearOnly && filter === c.id}">${c.emoji} ${esc(c.name)}</button>`
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
  const wasDrill = activeSheet === $('#drill');
  const wasDetail = activeSheet === el.sheet;
  if (wasDrill) { stopPlayback(); drill = null; }
  if (activeSheet === $('#passive')) endPassive();
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
  el.dEn.textContent = (phrase.bear ? '🐻 ' : '') + phrase.en;
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

/** Clipboard API where available (needs a secure context); otherwise the old
 *  select-and-execCommand route, which still works in older iOS Safari. */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch {}
    ta.remove();
    return ok;
  }
}

/* ── Events ──────────────────────────────────────────────────────────── */

el.list.addEventListener('click', async e => {
  const copyNode = e.target.closest('[data-copy]');
  if (copyNode) {
    e.stopPropagation();
    const p = BY_ID.get(copyNode.dataset.copy);
    if (!await copyText(p.zh)) return toast("Couldn't copy");
    toast(`Copied ${p.zh}`);
    copyNode.classList.add('done');
    clearTimeout(copyNode.t);
    copyNode.t = setTimeout(() => copyNode.classList.remove('done'), 1400);
    return;
  }
  if (e.target.closest('[data-pp]')) return startPassive(ppPickSet());
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
  setBearOnly(false);
  renderChips();
  renderList();
  el.list.scrollIntoView({ block: 'start' });
});

function setBearOnly(on) {
  bearOnly = on;
  el.bearOnly.checked = on;
  store.set('bear', on);
}

el.bearOnly.addEventListener('change', () => {
  setBearOnly(el.bearOnly.checked);
  renderChips();
  renderList();
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

/* ── Ear training ────────────────────────────────────────────────────
   Listening-only tone identification. This is the best-evidenced intervention
   for a speaker of a non-tonal language: training perception alone measurably
   improves *production* too, without any speaking practice, because the
   bottleneck is an ear that doesn't yet treat pitch as meaning.

   The whole phrase is played rather than a sliced-out syllable. That's partly
   pedagogy — tones behave differently in connected speech than in isolation —
   and partly honesty: the per-syllable timings here are even subdivisions of
   TTS word spans, accurate to only ~100ms, so a sliced syllable could clip and
   mark a correct answer wrong. */

const TONE_LABEL = { 1: 'flat', 2: 'rising', 3: 'low', 4: 'falling' };
const TONE_HINT = {
  1: 'high and level, like holding a note',
  2: 'rising, like asking "huh?"',
  3: 'low and creaky — kept low rather than deeply dipped',
  4: 'falling sharply, like a firm "no!"',
};

let drill = null;          // { phrase, index, answered }
let drillScore = { right: 0, asked: 0 };

/** Syllables carrying a full tone; neutral ones aren't worth drilling. */
const drillable = p => p.syllables
  .map((s, i) => ({ s, i }))
  .filter(({ s }) => (s.said || s.tone) >= 1 && (s.said || s.tone) <= 4);

function nextQuestion() {
  const pool = DATA.phrases.filter(p => drillable(p).length);
  const phrase = pool[Math.floor(Math.random() * pool.length)];
  const opts = drillable(phrase);
  const pick = opts[Math.floor(Math.random() * opts.length)];
  drill = { phrase, index: pick.i, answered: false };

  const total = phrase.syllables.length;
  const ord = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th'][pick.i] || `${pick.i + 1}th`;
  $('#drill-meaning').textContent = phrase.en;
  $('#drill-syl').textContent = pick.s.say;
  $('#drill-where').textContent = total > 1 ? `the ${ord} of ${total} sounds` : 'the whole phrase';

  $('#drill-choices').innerHTML = [1, 2, 3, 4].map(t =>
    `<button class="drill-choice" data-tone="${t}">
       <svg viewBox="0 0 15 9" aria-hidden="true">${TONE_PATH[t]}</svg>
       ${t} ${TONE_LABEL[t]}
     </button>`).join('');

  $('#drill-feedback').hidden = true;
  $('#drill-next').hidden = true;
  renderDrillScore();
  playDrillPhrase();
}

function renderDrillScore() {
  $('#drill-score').textContent = drillScore.asked
    ? `${drillScore.right}/${drillScore.asked}` : '';
}

/** Play a phrase straight through, ignoring loop/shadow/syllable modes. */
async function playDrillPhrase() {
  if (!drill) return;
  stopPlayback();
  const gen = ++generation;
  const plan = playbackPlan(drill.phrase, speed);
  if (!audio.src.endsWith(plan.src)) audio.src = plan.src;
  setRate(plan.rate);
  const timing = drill.phrase.timing[plan.track];
  const last = timing[timing.length - 1];
  await playRange(0, last.t + last.d + 0.2, gen);
}

function answerDrill(tone) {
  if (!drill || drill.answered) return;
  drill.answered = true;
  const syl = drill.phrase.syllables[drill.index];
  const right = syl.said || syl.tone;
  const ok = tone === right;

  drillScore.asked++;
  if (ok) drillScore.right++;
  renderDrillScore();

  for (const btn of $('#drill-choices').querySelectorAll('.drill-choice')) {
    const t = Number(btn.dataset.tone);
    btn.disabled = true;
    if (t === right) btn.classList.add('correct');
    else if (t === tone) btn.classList.add('wrong');
  }

  const fb = $('#drill-feedback');
  fb.innerHTML = ok
    ? `Yes — <b>${esc(syl.say)}</b> is tone ${right}, ${TONE_HINT[right]}.`
    : `Not quite. <b>${esc(syl.say)}</b> is tone ${right} (${TONE_LABEL[right]}), ` +
      `${TONE_HINT[right]} — you picked ${tone} (${TONE_LABEL[tone]}).` +
      (syl.sandhi ? ` This one shifts: written as tone 3, said as tone 2 because a low tone follows.` : '');
  fb.hidden = false;
  $('#drill-next').hidden = false;
  playDrillPhrase();
}

$('#ear-btn').addEventListener('click', () => {
  drillScore = { right: 0, asked: 0 };
  showSheet($('#drill'));
  nextQuestion();
});
$('#drill-choices').addEventListener('click', e => {
  const btn = e.target.closest('[data-tone]');
  if (btn) answerDrill(Number(btn.dataset.tone));
});
$('#drill-next').addEventListener('click', nextQuestion);
$('#drill-replay').addEventListener('click', playDrillPhrase);

/* ── Passive practice ────────────────────────────────────────────────
   English, then Mandarin, then your turn — for up to twenty phrases from
   whatever the list is showing. Where the browser can listen it judges the
   attempt: a pass moves on; a miss says so, plays both again and asks again,
   up to PP_TRIES times so a recogniser that keeps mishearing can't trap you on
   one phrase. Media keys and AirPods map onto pause, skip and replay.

   Recognition hears words, not tones: its language model will happily turn a
   wrong tone into the right word. So a pass means "recognisable", and the tone
   work stays with record-and-compare and ear training. Where the browser can't
   listen, or isn't allowed to, it falls back to a pause to say it in and a
   Got it / Not yet. */

const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
const PP_SIZE = 20;       // phrases per set
const PP_TRIES = 3;       // attempts before moving on
const PP_PASS = 0.66;     // share of the phrase's characters that must come back
const CLIP_MAX = 60;      // seconds; a whole clip ends on `ended` long before this

// Recognition errors that won't fix themselves for the rest of the set.
const SR_FATAL = new Set(['not-allowed', 'service-not-allowed', 'audio-capture',
                          'language-not-supported', 'network', 'unsupported']);

let pp = null;            // the running set
let ppRec = null;         // live SpeechRecognition
let ppGrade = null;       // resolves the self-grade buttons
let wakeLock = null;

/* Toneless pinyin for every character the app knows, so a recogniser that
   writes a homophone (他 for 她, 在 for 再) isn't marked wrong for spelling. */
const SOUND = new Map();
for (const p of DATA.phrases) {
  for (const s of p.syllables) {
    SOUND.set(s.han, s.py.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase());
  }
}
const HAN_DIGITS = '零一二三四五六七八九';
const hanOnly = s => s.replace(/\d/g, d => HAN_DIGITS[d]).replace(/[^\p{Script=Han}]/gu, '');
const sameSound = (a, b) => a === b || (SOUND.has(a) && SOUND.get(a) === SOUND.get(b));

/** Share of the target's characters that came back, in order (LCS). Extra
 *  words around it — an "um", a false start — cost nothing. */
function matchScore(target, heard) {
  const a = [...hanOnly(target)], b = [...hanOnly(heard)];
  if (!a.length) return 0;
  let prev = new Array(b.length + 1).fill(0);
  for (const ch of a) {
    const row = [0];
    for (let j = 1; j <= b.length; j++) {
      row[j] = sameSound(ch, b[j - 1]) ? prev[j - 1] + 1 : Math.max(prev[j], row[j - 1]);
    }
    prev = row;
  }
  return prev[b.length] / a.length;
}

const spokenMs = p => {
  const t = p.timing.natural;
  const last = t[t.length - 1];
  return (last.t + last.d) * 1000;
};

function shuffle(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

function ppPickSet() {
  const hits = listHits();
  return shuffle([...(hits.length ? hits : DATA.phrases)]).slice(0, PP_SIZE);
}

/* Playback goes through the shared <audio> element like everything else, so
   iOS keeps it unlocked and the lock screen keeps its controls. */
function ppClip(src, gen) {
  if (!audio.src.endsWith(src)) audio.src = src;
  setRate(1);
  return playRange(0, CLIP_MAX, gen);
}

async function ppMandarin(p, gen) {
  const plan = playbackPlan(p, speed);
  if (!audio.src.endsWith(plan.src)) audio.src = plan.src;
  setRate(plan.rate);
  const timing = p.timing[plan.track];
  const last = timing[timing.length - 1];
  const nodes = $('#pp-say').querySelectorAll('.syl');
  const ok = await playRange(0, last.t + last.d + 0.2, gen, t => {
    let idx = -1;
    for (let i = 0; i < timing.length; i++) if (t >= timing[i].t - 0.02) idx = i;
    nodes.forEach((n, i) => n.classList.toggle('active', i === idx));
  });
  nodes.forEach(n => n.classList.remove('active'));
  return ok;
}

async function ppCue(name, token) {
  const ids = (DATA.cues || {})[name];
  if (!ids || !ids.length || !pp || pp.token !== token) return;
  const gen = ++generation;
  await ppClip(`audio/${ids[Math.floor(Math.random() * ids.length)]}.mp3`, gen);
  await sleep(250, gen);
}

/** Listen for one attempt. Resolves with every transcript the recogniser
 *  offered (its alternatives included) and any error. */
function ppListen(p, token) {
  return new Promise(resolve => {
    let rec;
    try { rec = new SpeechRec(); } catch { return resolve({ heard: [], error: 'unsupported' }); }
    rec.lang = 'zh-CN';
    rec.interimResults = true;
    rec.maxAlternatives = 5;
    rec.continuous = false;

    const finals = [];
    let interim = '', error = null, settled = false, timers = [];
    const done = () => {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout);
      if (ppRec === rec) ppRec = null;
      const got = finals.filter(Boolean);
      const joined = got.map(alts => alts[0]).join('') || interim;
      resolve({ heard: [joined, ...got.flat()].filter(Boolean), error });
    };

    rec.onresult = e => {
      interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finals[i] = Array.from({ length: r.length }, (_, k) => r[k].transcript);
        else interim += r[0].transcript;
      }
      if (pp && pp.token === token) {
        ppShowHeard(finals.filter(Boolean).map(alts => alts[0]).join('') + interim, true);
      }
    };
    rec.onerror = e => { error = e.error; };
    rec.onend = done;

    ppRec = rec;
    try { rec.start(); } catch { ppRec = null; settled = true; return resolve({ heard: [], error: 'unsupported' }); }

    // The recogniser ends itself when you stop talking; these only catch one
    // that never hears anything, or never says so.
    const budget = Math.max(5000, spokenMs(p) * 2.5 + 3000);
    timers = [
      setTimeout(() => { try { rec.stop(); } catch {} }, budget),
      setTimeout(() => { try { rec.abort(); } catch {} }, budget + 2500),
      setTimeout(done, budget + 4000),
    ];
  });
}

function ppStep(state, label) {
  $('#pp-card').dataset.state = state;
  $('#pp-step').textContent = label;
}

function ppShowHeard(text, live) {
  const node = $('#pp-heard');
  node.hidden = false;
  node.innerHTML = text
    ? `${live ? 'Hearing' : 'Heard'}: <b lang="zh-CN">${esc(text)}</b>`
    : (live ? 'Listening…' : 'Heard nothing');
}

function ppNote(text) {
  $('#pp-note').textContent = text;
  $('#pp-note').hidden = !text;
}

function ppRender() {
  const p = pp.items[pp.i];
  $('#pp-count').textContent = `${pp.i + 1} / ${pp.items.length}`;
  $('#pp-bar').style.width = (pp.i / pp.items.length) * 100 + '%';
  $('#pp-en').textContent = p.en;
  $('#pp-say').innerHTML = syllablesHtml(p, { interactive: false });
  $('#pp-zh').textContent = p.zh;
  $('#pp-heard').hidden = true;
  $('#pp-grade').hidden = true;
  $('#pp-tries').hidden = pp.tries === 0;
  $('#pp-tries').textContent = `Try ${pp.tries + 1} of ${PP_TRIES}`;
}

async function ppSelfGrade(p, gen, spokenAlready) {
  ppStep('you', 'Your turn — say it');
  if (!spokenAlready && !(await sleep(Math.max(1800, spokenMs(p) * 1.6 + 1000), gen))) return null;
  ppStep('you', 'How was that?');
  $('#pp-grade').hidden = false;
  const verdict = await new Promise(res => { ppGrade = res; });
  $('#pp-grade').hidden = true;
  return verdict;
}

async function ppHear(p, token, gen) {
  ppStep('you', 'Your turn — say it');
  ppShowHeard('', true);
  const res = await ppListen(p, token);
  if (!pp || pp.token !== token) return null;
  if (res.error && SR_FATAL.has(res.error)) {
    pp.selfGrade = true;
    ppNote(res.error === 'network'
      ? "Listening needs a connection here, so you're grading yourself for now: say it, then tap Got it or Not yet."
      : "The microphone or speech recognition isn't available, so you're grading yourself: say it, then tap Got it or Not yet.");
    $('#pp-heard').hidden = true;
    return ppSelfGrade(p, gen, true);
  }
  const score = res.heard.reduce((best, h) => Math.max(best, matchScore(p.zh, h)), 0);
  ppShowHeard(res.heard[0] || '', false);
  return score >= PP_PASS ? 'good' : 'bad';
}

/** One pass: English, Mandarin, your turn. Resolves 'good', 'bad', or null
 *  if the set was paused, skipped or closed meanwhile. */
async function ppAttempt(p, token) {
  stopPlayback();
  const gen = ++generation;
  ppStep('listen', 'English');
  if (!(await ppClip(`audio/${p.id}.en.mp3`, gen))) return null;
  if (!(await sleep(350, gen))) return null;
  ppStep('listen', 'Mandarin');
  if (!(await ppMandarin(p, gen))) return null;
  if (!pp || pp.token !== token) return null;
  return pp.selfGrade ? ppSelfGrade(p, gen, false) : ppHear(p, token, gen);
}

function ppRecord(passed, skipped) {
  const p = pp.items[pp.i];
  pp.results.push({ p, passed, skipped: !!skipped, attempts: pp.tries + 1 });
  pp.i++;
  pp.tries = 0;
}

async function ppRun() {
  if (!pp || pp.paused || pp.done) return;
  const token = ++pp.token;
  const live = () => pp && pp.token === token;
  keepAwake(true);

  while (live() && pp.i < pp.items.length) {
    const p = pp.items[pp.i];
    ppRender();
    setPassiveMedia(p);
    const verdict = await ppAttempt(p, token);
    if (!live() || !verdict) return;

    if (verdict === 'good') {
      ppStep('good', 'Good');
      ppRecord(true);
      await ppCue('good', token);
    } else if (pp.tries + 1 >= PP_TRIES) {
      ppStep('bad', 'Moving on — this one goes on your list');
      ppRecord(false);
      await ppCue('moveon', token);
    } else {
      ppStep('bad', 'Not quite — again');
      pp.tries++;
      await ppCue('again', token);
    }
  }
  if (live()) ppFinish(token);
}

function ppAnswer(verdict) {
  if (!ppGrade) return;
  const res = ppGrade;
  ppGrade = null;
  res(verdict);
}

/** Stop whatever is in flight — audio, listening, a pending self-grade. */
function ppHalt() {
  if (pp) pp.token++;
  if (ppRec) { const rec = ppRec; ppRec = null; try { rec.abort(); } catch {} }
  ppAnswer(null);
  stopPlayback();
}

function ppPause() {
  if (!pp || pp.done || pp.paused) return;
  pp.paused = true;
  ppHalt();
  ppStep('paused', 'Paused');
  $('#pp-pause').textContent = 'Resume';
  $('#pp-pause').setAttribute('aria-pressed', 'true');
  keepAwake(false);
}

function ppResume() {
  if (!pp || pp.done || !pp.paused) return;
  pp.paused = false;
  $('#pp-pause').textContent = 'Pause';
  $('#pp-pause').setAttribute('aria-pressed', 'false');
  ppRun();   // the current phrase starts over from the English
}

/** Count it / Skip: settle the current phrase by hand and move on. */
function ppSettle(passed) {
  if (!pp || pp.done) return;
  ppHalt();
  ppRecord(passed, !passed);
  if (pp.i >= pp.items.length) return ppFinish(pp.token);
  if (pp.paused) { ppRender(); ppStep('paused', 'Paused'); }
  else ppRun();
}

function ppReplay() {
  if (!pp || pp.done) return;
  ppHalt();
  if (pp.paused) ppResume(); else ppRun();
}

function ppFinish(token) {
  pp.done = true;
  keepAwake(false);
  const n = pp.results.length;
  const first = pp.results.filter(r => r.passed && r.attempts === 1).length;
  const later = pp.results.filter(r => r.passed && r.attempts > 1).length;
  const work = pp.results.filter(r => !r.passed || r.attempts > 1);

  $('#pp-count').textContent = '';
  $('#pp-bar').style.width = '100%';
  $('#pp-run').hidden = true;
  $('#pp-done').hidden = false;
  $('#pp-score').textContent = `${first} / ${n}`;
  $('#pp-score-sub').textContent = 'on the first try' +
    (later ? ` · ${later} more on a retry` : '') +
    (n - first - later ? ` · ${n - first - later} to work on` : '');
  $('#pp-missed').innerHTML = work.length
    ? `<p class="pp-missed-head">Worth another go</p>` + work.map(r =>
        `<div class="pp-miss">
           <span class="pp-miss-en">${esc(r.p.en)}</span>
           <span class="pp-miss-say">${esc(r.p.phon)} · <span lang="zh-CN">${esc(r.p.zh)}</span></span>
         </div>`).join('')
    : '';
  $('#pp-again').textContent = work.length ? 'Practise these' : 'Same set again';
  pp.retry = work.length ? work.map(r => r.p) : pp.items;
  ppCue('done', token);
}

function startPassive(items) {
  if (!items.length) return;
  ppHalt();
  pp = {
    items, i: 0, tries: 0, results: [], token: 0,
    paused: false, done: false, selfGrade: !SpeechRec,
  };
  $('#pp-run').hidden = false;
  $('#pp-done').hidden = true;
  $('#pp-pause').textContent = 'Pause';
  $('#pp-pause').setAttribute('aria-pressed', 'false');
  ppNote(pp.selfGrade
    ? "This browser can't listen, so you grade yourself: say it in the pause, then tap Got it or Not yet."
    : 'Say each phrase after the Mandarin and it listens. It hears words, not tones — a pass means recognisable, not perfect.');
  if (activeSheet !== $('#passive')) showSheet($('#passive'));
  // Synchronously, inside the tap: the first clip's load() has to happen in
  // the gesture for iOS to let the rest of the set play.
  ppRun();
}

function endPassive() {
  ppHalt();
  pp = null;
  keepAwake(false);
}

/* Lock-screen and AirPods controls drive the set while it runs. */
function setPassiveMedia(p) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: p.en,
    artist: `${p.zh}  ·  Passive practice`,
    album: 'Say It In Mandarin',
    artwork: [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
  });
  const handlers = {
    play: ppResume, pause: ppPause, stop: ppPause,
    nexttrack: () => ppSettle(false), previoustrack: ppReplay,
  };
  for (const [action, fn] of Object.entries(handlers)) {
    try { navigator.mediaSession.setActionHandler(action, fn); } catch {}
  }
}

/* Listening only works with the page in front, so keep the screen on while a
   set runs. The system drops the lock whenever the page is hidden. */
async function keepAwake(on) {
  if (!('wakeLock' in navigator)) return;
  try {
    if (on && !wakeLock) {
      const lock = await navigator.wakeLock.request('screen');
      if (!pp || pp.done || pp.paused) return lock.release();
      wakeLock = lock;
      lock.addEventListener('release', () => { if (wakeLock === lock) wakeLock = null; });
    } else if (!on && wakeLock) {
      const lock = wakeLock;
      wakeLock = null;
      await lock.release();
    }
  } catch {}
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && pp && !pp.done && !pp.paused) keepAwake(true);
});

$('#pp-pause').addEventListener('click', () => (pp && pp.paused ? ppResume() : ppPause()));
$('#pp-pass').addEventListener('click', () => ppSettle(true));
$('#pp-skip').addEventListener('click', () => ppSettle(false));
$('#pp-yes').addEventListener('click', () => ppAnswer('good'));
$('#pp-no').addEventListener('click', () => ppAnswer('bad'));
$('#pp-again').addEventListener('click', () => pp && startPassive(shuffle([...pp.retry])));
$('#pp-next').addEventListener('click', () => startPassive(ppPickSet()));

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
    setBearOnly(false);
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
      setRate(plan.rate);
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

/* Themes. The colours live in styles.css as [data-theme] blocks; this is only
   the menu. Midnight is the original look and stays the default. index.html
   applies the saved theme before first paint; this keeps it in sync after. */
const THEMES = [
  { id: 'daylight',  name: 'Daylight',    group: 'Light' },
  { id: 'solarized', name: 'Solarized',   group: 'Light' },
  { id: 'latte',     name: 'Latte',       group: 'Light' },
  { id: 'gruvbox',   name: 'Gruvbox',     group: 'Light' },
  { id: 'midnight',  name: 'Midnight',    group: 'Dark' },
  { id: 'dracula',   name: 'Dracula',     group: 'Dark' },
  { id: 'nord',      name: 'Nord',        group: 'Dark' },
  { id: 'tokyo',     name: 'Tokyo Night', group: 'Dark' },
  { id: 'bear',      name: 'Bear',        group: 'Cute', mascot: '🐻' },
  { id: 'panda',     name: 'Panda',       group: 'Cute', mascot: '🐼' },
  { id: 'kitty',     name: 'Kitty',       group: 'Cute', mascot: '🎀' },
  { id: 'love',      name: 'Love',        group: 'Cute', mascot: '💕' },
];

function applyTheme() {
  const id = THEMES.some(t => t.id === prefs.theme) ? prefs.theme : 'midnight';
  document.documentElement.dataset.theme = id;
  // Browser chrome (Android's status bar, Safari's tab bar) follows the page.
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta && bg) meta.content = bg;
  for (const tile of document.querySelectorAll('[data-pick]')) {
    tile.setAttribute('aria-pressed', String(tile.dataset.pick === id));
  }
}

/** Each swatch carries its own data-theme, so it previews with the theme's
 *  real tokens rather than a copy of them. */
function renderThemePicker() {
  const groups = [...new Set(THEMES.map(t => t.group))];
  $('#theme-picker').innerHTML = groups.map(g =>
    `<p class="theme-label">${g}</p><div class="theme-grid">` +
    THEMES.filter(t => t.group === g).map(t =>
      `<button class="theme-tile" data-pick="${t.id}" aria-pressed="false">
         <span class="theme-swatch" data-theme="${t.id}" aria-hidden="true">
           ${t.mascot ? `<span class="theme-mascot">${t.mascot}</span>` : ''}
           <span class="sw-card"><i class="t1"></i><i class="t2"></i><i class="t3"></i><i class="t4"></i></span>
           <span class="sw-accent"></span>
         </span>
         <span class="theme-name">${t.name}</span>
       </button>`).join('') +
    '</div>').join('');
}

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

/** Every clip the app can play: both Mandarin tracks, the English prompt, and
 *  passive practice's spoken cues. */
function audioUrls() {
  const urls = [];
  for (const p of DATA.phrases) {
    for (const t of Object.keys(DATA.tracks)) urls.push(`audio/${p.id}.${t}.mp3`);
    urls.push(`audio/${p.id}.en.mp3`);
  }
  for (const ids of Object.values(DATA.cues || {})) for (const id of ids) urls.push(`audio/${id}.mp3`);
  return urls;
}

async function refreshStorage() {
  const sub = $('#offline-sub');
  const total = audioUrls().length;
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

$('#theme-picker').addEventListener('click', e => {
  const tile = e.target.closest('[data-pick]');
  if (!tile) return;
  prefs.theme = tile.dataset.pick;
  savePrefs();
  applyTheme();
});

$('#opt-autocheck').addEventListener('change', e => {
  prefs.autocheck = e.target.checked;
  savePrefs();
});

/* Pre-download every clip so the app works with no signal at all. */
$('#offline-btn').addEventListener('click', async e => {
  const pill = $('#offline-pill');
  const sub = $('#offline-sub');
  if (pill.dataset.state === 'busy') return;

  const urls = audioUrls();

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
renderThemePicker();
applyTheme();
el.bearOnly.checked = bearOnly;
renderChips();
renderList();
updateSpeedUI();
updateModeUI();
refreshInstallSection();
renderQuickbar();
applyDeepLink();

window.addEventListener('load', initServiceWorker);

})();
