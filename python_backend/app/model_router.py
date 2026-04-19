from __future__ import annotations

from .config import settings
from .schemas import Mode


def route_mode(mode: Mode) -> dict[str, object]:
    """Map a quality mode to its routing config (model, context window, etc.)."""
    if mode == "fast":
        return {
            "mode": mode,
            "context_window": 4,
            "response_style": "concise",
            "coaching_depth": 1,
            "chat_model": settings.llm_model_fast,
            "stt_model_size": "tiny",
            "stt_beam_size": 1,
            "tts_speed": 1.2,
            "tts_engine": "piper",
        }
    if mode == "quality":
        return {
            "mode": mode,
            "context_window": 10,
            "response_style": "strategic",
            "coaching_depth": 3,
            "chat_model": settings.llm_model_balanced,
            "stt_model_size": settings.stt_model_size,
            "stt_beam_size": 3,
            "tts_speed": 1.0,
            "tts_engine": "gemini",
        }
    return {
        "mode": "balanced",
        "context_window": 6,
        "response_style": "balanced",
        "coaching_depth": 2,
        "chat_model": settings.llm_model_balanced,
        "stt_model_size": settings.stt_model_size,
        "stt_beam_size": 3,
        "tts_speed": 1.0,
        "tts_engine": "kokoro",
    }
