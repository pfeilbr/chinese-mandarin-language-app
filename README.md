# Say It In Mandarin

An in-ear phrase prompter for speaking Mandarin to someone you actually live with.

Pick an English phrase, hear it spoken in Mandarin at whatever speed you need, say it
back. Built for the case where you have AirPods in, your phone is in your pocket, and
your partner is in the next room.

**Live app:** https://pfeilbr.github.io/chinese-mandarin-language-app/

## Install it on your phone

Open the link in **Safari** on iPhone, tap the Share button, and choose
**Add to Home Screen**. It then launches full screen with no browser chrome.

Open the **☰ menu → Offline audio → Save all audio** once, and it works with no
signal at all.

(On Android or desktop Chrome the menu offers a one-tap **Install** button
instead. iOS has no programmatic install — Safari's Share sheet is the only
route — so the app just tells you where to tap.)

## What it does

- **90 phrases** across affection, sweet talk, meeting the family, occasions and
  toasts, Chengdu and spice, meals, coming and going, checking in, chores, and
  the "I'm still learning, say it slower" repair kit.
- **Record yourself and hear it back** against the native clip, so you don't
  drill a wrong tone in without noticing.
- **Continuous speed control**, 40% to 110% of native pace.
- **Written in English you can just read.** Every phrase is respelled
  syllable-by-syllable the way it actually sounds — `nee how kuh EYE`, with
  CAPITALS marking the stressed syllable. Chinese characters and pinyin are both
  off by default: two scripts you can't read yet are noise around the one line
  you're trying to say. Turn either back on in Settings.
- **Tone colouring and contour marks** on every syllable. Tones are what decide
  whether you're understood, so they're the most visible thing on screen — and
  they ride on the English respelling, so they work with both scripts hidden.
- **Tap any syllable** to hear just that sound, in its real phrase context.
- **Syllable mode** steps through one sound at a time.
- **Shadow mode** plays the phrase, leaves a silent gap for you to say it out loud,
  then plays it again — indefinitely. This is the one to use with AirPods in.
- **Lock-screen and AirPods controls.** Squeeze the stem to replay without taking
  your phone out.
- **Favourites** and search across English, pinyin, and hanzi.
- **Settings** (☰): install, updates, offline audio and storage, and display
  toggles — turn pinyin off to test yourself on the characters.

## Checking your pronunciation

The phrase screen has **Record yourself**; when you stop, it plays the native
clip and your attempt back to back. Listen to the *shape* of each syllable —
flat, rising, dipping, falling. Tones decide whether you're understood; the
consonants matter far less.

It's a plain A/B rather than speech recognition on purpose: `SpeechRecognition`
is unreliable-to-absent in iOS Safari, which is the one browser this has to work
in. Recordings live in memory for the session only, and the mic stream is
released the moment you stop — iOS keeps showing the in-use indicator otherwise.

## A note on the phrase content

The phrases were written without a native speaker checking them. Register and
regional flavour are judgement calls, and a few are worth confirming before you
lean on them — `早安` reads slightly Taiwanese where mainland speakers say
`早上好`, and `我喜欢你` is closer to "I like you" (a confession-stage phrase)
than the app's gloss suggests. Getting a native speaker to read the list is the
single highest-value change available to this project.

The Chengdu section is standard Mandarin, including `巴适` and `安逸`, which are
Sichuanese words. Their real Sichuanese pronunciation differs from what the
voice produces — Microsoft's neural voices cover Liaoning and Shaanxi dialects
but not Sichuanese, so that part has to come from a person.

## Updates

The app checks for a new version on launch and offers it rather than applying it
silently: you get an **Update available** prompt with *Update* and *Later*. You
can also check by hand from **☰ menu → Updates**. Accepting swaps in the new
version and reloads; the downloaded audio is kept, so an update never costs you
the 2 MB again.

The mechanics are worth knowing if you change the deploy:

- The service worker deliberately does **not** call `skipWaiting()` on install.
  A new version parks in `waiting` until you accept it, so the app can't swap
  itself out mid-sentence. Accepting posts `SKIP_WAITING` and reloads.
- The deploy workflow stamps the commit SHA into `sw.js`. This is load-bearing:
  browsers decide an update exists by byte-comparing that one file, so without
  the stamp an unchanged `sw.js` would hide new versions no matter what else
  changed.
- Registration uses `updateViaCache: 'none'`, otherwise the browser may serve
  `sw.js` from its HTTP cache and miss updates for up to 24 hours.

## Audio

Every clip is pre-rendered to MP3 at two speaking rates by Microsoft's neural
Mandarin voice (`zh-CN-XiaoxiaoNeural`) via [`edge-tts`][edge-tts] — free, and no
API key or account.

Pre-rendering rather than synthesising in the browser is a deliberate choice. The
Web Speech API is the obvious shortcut, but on iOS its `rate` parameter is
unreliable below 1.0 and its Mandarin voices are noticeably robotic — and slow,
clear playback is the entire point of this app. Shipping audio files also means
correct AirPods routing, real lock-screen controls, and genuine offline use.

The **slow** track is synthesised at `-45%`, so the voice genuinely enunciates more
carefully rather than just being stretched. The speed slider picks whichever track
is closer to the requested pace and covers the remainder with `playbackRate`, with
`preservesPitch` on throughout — pitch *is* meaning in Mandarin, so tone contours
must survive any speed change.

The build also captures per-word timings from the TTS service and subdivides them
to per-syllable, which is what drives the synced highlighting and tap-to-hear.

## Adding or changing phrases

1. Edit [`data/phrases.json`](data/phrases.json).
2. Run the build:

   ```sh
   ./scripts/build.py          # renders only what's missing
   ./scripts/build.py --force  # re-renders everything
   ```

3. Commit. Pushing to `main` redeploys the site.

Each entry needs one pinyin syllable per sounded character:

```json
{
  "id": "youre-cute",
  "cat": "compliments",
  "en": "You're so cute",
  "zh": "你好可爱",
  "py": "nǐ hǎo kě ài",
  "phon": "nee how kuh EYE",
  "note": "可爱 is the everyday \"cute\" — safe and sweet any time."
}
```

All three of `zh`, `py` and `phon` must line up **one chunk per sounded
character** — the build fails loudly if they don't. That check is deliberate: a
silent misalignment would attach the wrong tone and the wrong pronunciation to
every later syllable in the phrase, which is exactly the kind of error that
teaches you to say something wrong without ever noticing.

- `py` — pinyin, one space-separated syllable per character. Tone numbers are
  derived from the marks, so write it as actually spoken and apply sandhi
  (`yí xià`, `yì qǐ`).
- `phon` — the English respelling, and the line the app shows biggest, because
  it's the one that gets read out loud. One space-separated chunk per syllable.
  Capitalise the syllable that takes the stress. Spell for an English reader
  who has never seen pinyin: `chr` not `chi`, `shyahng` not `xiǎng`.

## Layout

```
data/phrases.json      source of truth — the only file you edit to add phrases
scripts/build.py       renders MP3s + timings, emits web/data/phrases.js
scripts/make_icons.py  regenerates the PWA icons
web/                   the deployed site (static, no build step, no dependencies)
  audio/               pre-rendered clips, two rates per phrase
  data/phrases.js      generated — do not edit by hand
```

Requires [`uv`](https://docs.astral.sh/uv/) to run the build scripts; the site
itself has no dependencies and no build step.

[edge-tts]: https://github.com/rany2/edge-tts
