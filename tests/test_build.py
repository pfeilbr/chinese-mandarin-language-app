"""Tests for scripts/build.py's data handling (no network: nothing is rendered).

Run: uv run --with pytest --with edge-tts pytest tests/
"""

import importlib.util
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("build", ROOT / "scripts" / "build.py")
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)

SOURCE = json.loads((ROOT / "data" / "phrases.json").read_text())
PHRASE = {"id": "x", "cat": "affection", "en": "Kiss me", "zh": "亲亲我",
          "py": "qīn qīn wǒ", "phon": "chin chin WAW"}


def test_bear_flag_passes_through():
    assert build.phrase_entry({**PHRASE, "bear": True})["bear"] is True


def test_no_bear_key_without_the_flag():
    assert "bear" not in build.phrase_entry(PHRASE)
    assert "bear" not in build.phrase_entry({**PHRASE, "bear": False})


def test_entry_keeps_optional_fields():
    out = build.phrase_entry({**PHRASE, "note": "n", "starter": 2})
    assert out["note"] == "n" and out["starter"] == 2
    assert [s["han"] for s in out["syllables"]] == ["亲", "亲", "我"]


def test_misaligned_phrase_is_rejected():
    with pytest.raises(ValueError):
        build.phrase_entry({**PHRASE, "phon": "chin WAW"})


def test_the_contributed_phrases_carry_the_bear():
    bears = {p["id"] for p in SOURCE["phrases"] if p.get("bear")}
    assert bears == {"kiss-me-cute", "really-want-a-hug", "come-hold-you",
                     "thinking-all-day", "you-made-me-mad"}


def test_generated_data_matches_source():
    """web/data/phrases.js must be rebuilt after editing phrases.json."""
    js = (ROOT / "web" / "data" / "phrases.js").read_text()
    payload = json.loads(js.split("window.PHRASE_DATA = ", 1)[1].rstrip().rstrip(";"))
    built = {p["id"]: p.get("bear", False) for p in payload["phrases"]}
    assert built == {p["id"]: bool(p.get("bear")) for p in SOURCE["phrases"]}
