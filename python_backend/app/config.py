from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


@dataclass(frozen=True)
class Settings:
    port: int = int(os.getenv("PORT", "8000"))
    base_dir: Path = Path(__file__).resolve().parents[1] / "data"
    hf_token: Optional[str] = os.getenv("HF_TOKEN") or None
    hf_chat_model_fast: str = os.getenv("HF_CHAT_MODEL_FAST", "Qwen/Qwen2.5-7B-Instruct")
    hf_chat_model_balanced: str = os.getenv("HF_CHAT_MODEL_BALANCED", "Qwen/Qwen2.5-7B-Instruct")
    hf_chat_model_quality: str = os.getenv("HF_CHAT_MODEL_QUALITY", "Qwen/Qwen2.5-7B-Instruct")


settings = Settings()
