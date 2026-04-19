from __future__ import annotations

import logging
from typing import Optional

from .schemas import VoiceProfile

logger = logging.getLogger(__name__)

# All Kokoro voicepacks available for English.
# Format: (voice_id, label, lang, gender, style_hint)
KOKORO_VOICES = [
    # American English — Female
    ("af_bella", "Bella", "a", "female", "warm"),
    ("af_sarah", "Sarah", "a", "female", "clear"),
    ("af_heart", "Heart", "a", "female", "expressive"),
    ("af_nicole", "Nicole", "a", "female", "smooth"),
    ("af_nova", "Nova", "a", "female", "bright"),
    ("af_sky", "Sky", "a", "female", "light"),
    ("af_river", "River", "a", "female", "flowing"),
    # American English — Male
    ("am_adam", "Adam", "a", "male", "confident"),
    ("am_michael", "Michael", "a", "male", "calm"),
    ("am_eric", "Eric", "a", "male", "steady"),
    ("am_liam", "Liam", "a", "male", "friendly"),
    # British English — Female
    ("bf_emma", "Emma", "b", "female", "professional"),
    ("bf_isabella", "Isabella", "b", "female", "composed"),
    ("bf_alice", "Alice", "b", "female", "gentle"),
    ("bf_lily", "Lily", "b", "female", "bright"),
    # British English — Male
    ("bm_george", "George", "b", "male", "authoritative"),
    ("bm_lewis", "Lewis", "b", "male", "measured"),
    ("bm_daniel", "Daniel", "b", "male", "warm"),
]

# Quick lookup by voice ID
_VOICE_BY_ID = {v[0]: v for v in KOKORO_VOICES}

# Default voice
DEFAULT_VOICE = "af_bella"

# Voices shown in the frontend selector (curated subset for simplicity)
SELECTABLE_VOICES = [
    {"id": "af_bella", "label": "Bella", "description": "American female, warm", "accent": "american", "gender": "female"},
    {"id": "af_sarah", "label": "Sarah", "description": "American female, clear", "accent": "american", "gender": "female"},
    {"id": "af_nova", "label": "Nova", "description": "American female, bright", "accent": "american", "gender": "female"},
    {"id": "am_adam", "label": "Adam", "description": "American male, confident", "accent": "american", "gender": "male"},
    {"id": "am_michael", "label": "Michael", "description": "American male, calm", "accent": "american", "gender": "male"},
    {"id": "am_liam", "label": "Liam", "description": "American male, friendly", "accent": "american", "gender": "male"},
    {"id": "bf_emma", "label": "Emma", "description": "British female, professional", "accent": "british", "gender": "female"},
    {"id": "bf_isabella", "label": "Isabella", "description": "British female, composed", "accent": "british", "gender": "female"},
    {"id": "bm_george", "label": "George", "description": "British male, authoritative", "accent": "british", "gender": "male"},
    {"id": "bm_daniel", "label": "Daniel", "description": "British male, warm", "accent": "british", "gender": "male"},
]


def resolve_voice(profile: VoiceProfile) -> str:
    """Map a VoiceProfile to a Kokoro voice ID.

    If `profile.preset` matches a known voice ID, use it directly.
    Otherwise fall back to matching by gender/accent fields, then to the default.
    """
    # Direct match via preset
    if profile.preset and profile.preset in _VOICE_BY_ID:
        return profile.preset

    # Try to match by gender + accent
    gender = (profile.gender or "").lower()
    accent = (profile.accent or "").lower()

    # Map accent to Kokoro language prefix
    lang_prefix = "a"  # default American
    if accent in ("british", "uk"):
        lang_prefix = "b"

    candidates = [
        v for v in KOKORO_VOICES
        if v[2] == lang_prefix and (not gender or v[3] == gender)
    ]

    if candidates:
        return candidates[0][0]

    if profile.preset:
        logger.warning("Unknown voice preset '%s' — using default %s", profile.preset, DEFAULT_VOICE)

    return DEFAULT_VOICE


def lang_code_for_voice(voice_id: str) -> str:
    """Return the Kokoro language code for a given voice ID."""
    voice = _VOICE_BY_ID.get(voice_id)
    if voice:
        return voice[2]
    # Infer from prefix: af_*, am_* → 'a', bf_*, bm_* → 'b'
    if voice_id.startswith("b"):
        return "b"
    return "a"


# ---------------------------------------------------------------------------
# Piper voice mapping (used in fast mode)
# ---------------------------------------------------------------------------
PIPER_VOICE_MAP: dict[str, str] = {
    # American female → en_US-amy-medium
    "af_bella": "en_US-amy-medium",
    "af_sarah": "en_US-amy-medium",
    "af_heart": "en_US-amy-medium",
    "af_nicole": "en_US-amy-medium",
    "af_nova": "en_US-amy-medium",
    "af_sky": "en_US-amy-medium",
    "af_river": "en_US-amy-medium",
    # American male → en_US-ryan-medium
    "am_adam": "en_US-ryan-medium",
    "am_michael": "en_US-ryan-medium",
    "am_eric": "en_US-ryan-medium",
    "am_liam": "en_US-ryan-medium",
    # British female → en_GB-alba-medium
    "bf_emma": "en_GB-alba-medium",
    "bf_isabella": "en_GB-alba-medium",
    "bf_alice": "en_GB-alba-medium",
    "bf_lily": "en_GB-alba-medium",
    # British male → en_GB-alan-medium
    "bm_george": "en_GB-alan-medium",
    "bm_lewis": "en_GB-alan-medium",
    "bm_daniel": "en_GB-alan-medium",
}
DEFAULT_PIPER_VOICE = "en_US-amy-medium"


def resolve_piper_voice(kokoro_voice_id: str) -> str:
    """Map a Kokoro voice ID to the closest Piper voice name."""
    return PIPER_VOICE_MAP.get(kokoro_voice_id, DEFAULT_PIPER_VOICE)


# ---------------------------------------------------------------------------
# Gemini voice mapping (used in quality mode)
# ---------------------------------------------------------------------------
GEMINI_VOICE_MAP: dict[str, str] = {
    # American female → Kore
    "af_bella": "Kore",
    "af_sarah": "Aoede",
    "af_heart": "Leda",
    "af_nicole": "Kore",
    "af_nova": "Aoede",
    "af_sky": "Leda",
    "af_river": "Kore",
    # American male → Charon
    "am_adam": "Charon",
    "am_michael": "Puck",
    "am_eric": "Charon",
    "am_liam": "Puck",
    # British female → Aoede
    "bf_emma": "Aoede",
    "bf_isabella": "Leda",
    "bf_alice": "Aoede",
    "bf_lily": "Leda",
    # British male → Orus
    "bm_george": "Orus",
    "bm_lewis": "Orus",
    "bm_daniel": "Puck",
}
DEFAULT_GEMINI_VOICE = "Kore"


def resolve_gemini_voice(kokoro_voice_id: str) -> str:
    """Map a Kokoro voice ID to the closest Gemini voice name."""
    return GEMINI_VOICE_MAP.get(kokoro_voice_id, DEFAULT_GEMINI_VOICE)
