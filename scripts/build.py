#!/usr/bin/env -S uv run --with edge-tts --script
"""
Renders every phrase in data/phrases.json to MP3 at two speaking rates using
Microsoft's neural Mandarin voices (via edge-tts -- free, no API key), captures
per-word timing data, and emits web/data/phrases.js for the front-end.

Usage:
    ./scripts/build.py              # only render what's missing
    ./scripts/build.py --force      # re-render everything
"""

import argparse
import asyncio
import json
import re
import sys
from pathlib import Path

import edge_tts

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "phrases.json"
AUDIO_DIR = ROOT / "web" / "audio"
OUT_JS = ROOT / "web" / "data" / "phrases.js"

CONCURRENCY = 6
PUNCT = "，。？！、：；「」《》,.?!"

# Tone-marked vowels -> tone number. Unmarked syllables are neutral (5).
TONE_MARKS = {
    1: "āēīōūǖĀĒĪŌŪǕ",
    2: "áéíóúǘÁÉÍÓÚǗ",
    3: "ǎěǐǒǔǚǍĚǏǑǓǙ",
    4: "àèìòùǜÀÈÌÒÙǛ",
}
MARK_TO_TONE = {ch: tone for tone, chars in TONE_MARKS.items() for ch in chars}


def tone_of(syllable: str) -> int:
    for ch in syllable:
        if ch in MARK_TO_TONE:
            return MARK_TO_TONE[ch]
    return 5  # neutral


def hanzi_chars(zh: str) -> list[str]:
    """Sounded characters only -- punctuation is display-only."""
    return [c for c in zh if c not in PUNCT and not c.isspace()]


def build_syllables(phrase: dict) -> list[dict]:
    """Zip hanzi against pinyin and the English respelling. Mismatches are a
    hard error -- a silent misalignment would attach the wrong tone and the
    wrong pronunciation to every later syllable in the phrase."""
    chars = hanzi_chars(phrase["zh"])
    pys = phrase["py"].split()
    phons = phrase.get("phon", "").split()
    if len(chars) != len(pys):
        raise ValueError(
            f"[{phrase['id']}] {len(chars)} hanzi but {len(pys)} pinyin syllables\n"
            f"    zh: {phrase['zh']}  -> {' '.join(chars)}\n"
            f"    py: {phrase['py']}"
        )
    if len(phons) != len(chars):
        raise ValueError(
            f"[{phrase['id']}] {len(chars)} syllables but {len(phons)} respelled\n"
            f"    zh:   {phrase['zh']}\n"
            f"    phon: {phrase.get('phon', '')}\n"
            "    The respelling is what gets read aloud, so it needs one\n"
            "    space-separated chunk per syllable."
        )
    return [
        {"han": c, "py": p, "tone": tone_of(p), "say": s}
        for c, p, s in zip(chars, pys, phons)
    ]


async def render(text: str, voice: str, rate: str, out_path: Path) -> list[dict]:
    """Synthesize to MP3, returning word-level timings in seconds."""
    comm = edge_tts.Communicate(text, voice, rate=rate, boundary="WordBoundary")
    audio = bytearray()
    words: list[dict] = []
    async for chunk in comm.stream():
        if chunk["type"] == "audio":
            audio.extend(chunk["data"])
        elif chunk["type"] == "WordBoundary":
            words.append(
                {
                    "t": round(chunk["offset"] / 1e7, 3),
                    "d": round(chunk["duration"] / 1e7, 3),
                    "text": chunk["text"],
                }
            )
    if not audio:
        raise RuntimeError(f"no audio returned for {text!r} @ {rate}")
    out_path.write_bytes(bytes(audio))
    return words


def map_words_to_syllables(words: list[dict], n_syllables: int) -> list[dict]:
    """The TTS segments Chinese into words (回来, 怎么样) and sometimes returns a
    whole short phrase as one span. Subdivide each span evenly across the
    syllables it covers so every syllable gets its own time range -- needed for
    tap-a-character and syllable-by-syllable stepping. Even subdivision is an
    approximation, but Mandarin syllables are near-isochronous, especially at
    the slow rate where this matters most.

    Returns one entry per syllable: {t, d, word} where `word` groups syllables
    that the segmenter considered a single word.
    """
    out: list[dict] = []
    cursor = 0
    for word_index, w in enumerate(words):
        length = len(hanzi_chars(w["text"]))
        if length == 0 or cursor >= n_syllables:
            continue
        length = min(length, n_syllables - cursor)
        step = w["d"] / length
        for k in range(length):
            out.append(
                {
                    "t": round(w["t"] + k * step, 3),
                    "d": round(step, 3),
                    "word": word_index,
                }
            )
        cursor += length

    # Any syllable the segmenter never reported still needs a slot.
    while len(out) < n_syllables:
        last = out[-1] if out else {"t": 0.0, "d": 0.3, "word": 0}
        out.append({"t": round(last["t"] + last["d"], 3), "d": last["d"], "word": last["word"]})
    return out[:n_syllables]


async def process(phrase: dict, cfg: dict, force: bool, sem: asyncio.Semaphore) -> dict:
    syllables = build_syllables(phrase)
    out = {
        "id": phrase["id"],
        "cat": phrase["cat"],
        "en": phrase["en"],
        "zh": phrase["zh"],
        "py": phrase["py"],
        "phon": phrase.get("phon", ""),
        "syllables": syllables,
        "timing": {},
    }
    if phrase.get("note"):
        out["note"] = phrase["note"]

    async with sem:
        for track, rate in cfg["tracks"].items():
            mp3 = AUDIO_DIR / f"{phrase['id']}.{track}.mp3"
            cache = AUDIO_DIR / f"{phrase['id']}.{track}.json"
            if mp3.exists() and cache.exists() and not force:
                words = json.loads(cache.read_text())
            else:
                words = await render(phrase["zh"], cfg["voice"], rate, mp3)
                cache.write_text(json.dumps(words, ensure_ascii=False))
                print(f"  ✓ {phrase['id']}.{track}", flush=True)
            out["timing"][track] = map_words_to_syllables(words, len(syllables))
    return out


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="re-render existing audio")
    args = ap.parse_args()

    cfg = json.loads(SRC.read_text())
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    OUT_JS.parent.mkdir(parents=True, exist_ok=True)

    # Validate every phrase up front so a typo fails fast, before any network work.
    errors = []
    seen = set()
    cat_ids = {c["id"] for c in cfg["categories"]}
    for p in cfg["phrases"]:
        try:
            build_syllables(p)
        except ValueError as e:
            errors.append(str(e))
        if p["id"] in seen:
            errors.append(f"[{p['id']}] duplicate id")
        seen.add(p["id"])
        if p["cat"] not in cat_ids:
            errors.append(f"[{p['id']}] unknown category {p['cat']!r}")
    if errors:
        print("Validation failed:\n" + "\n".join(errors), file=sys.stderr)
        return 1

    print(f"Rendering {len(cfg['phrases'])} phrases x {len(cfg['tracks'])} rates "
          f"as {cfg['voice']}...")
    sem = asyncio.Semaphore(CONCURRENCY)
    phrases = await asyncio.gather(
        *(process(p, cfg, args.force, sem) for p in cfg["phrases"])
    )

    payload = {
        "voice": cfg["voice"],
        "tracks": cfg["tracks"],
        "categories": cfg["categories"],
        "phrases": list(phrases),
    }
    OUT_JS.write_text(
        "// Generated by scripts/build.py -- do not edit by hand.\n"
        "window.PHRASE_DATA = "
        + json.dumps(payload, ensure_ascii=False, indent=1)
        + ";\n"
    )

    total_mb = sum(f.stat().st_size for f in AUDIO_DIR.glob("*.mp3")) / 1e6
    print(f"\nDone. {len(phrases)} phrases, {total_mb:.1f} MB of audio.")
    print(f"Wrote {OUT_JS.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
