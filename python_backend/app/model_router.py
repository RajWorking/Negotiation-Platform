from __future__ import annotations

from .config import settings
from .schemas import Mode


def route_mode(mode: Mode) -> dict[str, object]:
    if mode == "fast":
        return {
            "mode": mode,
            "context_window": 4,
            "response_style": "concise",
            "coaching_depth": 1,
            "chat_model": settings.hf_chat_model_fast,
        }
    if mode == "quality":
        return {
            "mode": mode,
            "context_window": 10,
            "response_style": "strategic",
            "coaching_depth": 3,
            "chat_model": settings.hf_chat_model_quality,
        }
    return {
        "mode": "balanced",
        "context_window": 6,
        "response_style": "balanced",
        "coaching_depth": 2,
        "chat_model": settings.hf_chat_model_balanced,
    }
