from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

# Load .env file if python-dotenv is available
try:
    from dotenv import load_dotenv
    _env_path = Path(__file__).resolve().parents[1] / ".env"
    load_dotenv(_env_path, override=True)
except ImportError:
    pass


@dataclass(frozen=True)
class Settings:
    port: int = int(os.getenv("PORT", "8000"))
    base_dir: Path = Path(__file__).resolve().parents[1] / "data"

    # --- Database (PostgreSQL) ---
    # If unset, falls back to file-based storage for local development.
    database_url: Optional[str] = os.getenv("DATABASE_URL")

    # --- Redis (optional, enables multi-instance WebSocket pub/sub) ---
    redis_url: Optional[str] = os.getenv("REDIS_URL")

    # --- LLM models (LiteLLM format: provider/model) ---
    # See https://docs.litellm.ai/docs/providers for supported providers.
    # LiteLLM reads API keys from standard env vars:
    #   HUGGINGFACE_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, etc.
    llm_model_fast: str = os.getenv("LLM_MODEL_FAST", "openai/gpt-5.4-nano")
    llm_model_balanced: str = os.getenv("LLM_MODEL_BALANCED", "openai/gpt-5.4-mini")
    llm_model_quality: str = os.getenv("LLM_MODEL_QUALITY", "openai/gpt-5.4-pro")
    embedding_model: str = os.getenv("EMBEDDING_MODEL", "openai/text-embedding-3-small")

    # --- Auth (optional API key — if set, all endpoints require X-API-Key) ---
    api_key: Optional[str] = os.getenv("API_KEY")

    # --- CORS ---
    allowed_origins: list[str] = field(default_factory=lambda: [
        origin.strip()
        for origin in os.getenv("ALLOWED_ORIGINS", "http://localhost:5173,http://localhost:3000").split(",")
        if origin.strip()
    ])

    # --- Rate limiting (slowapi format, e.g. "30/minute") ---
    rate_limit: str = os.getenv("RATE_LIMIT", "30/minute")

    # --- STT (Faster-Whisper) ---
    stt_enabled: bool = os.getenv("STT_ENABLED", "true").lower() == "true"
    stt_model_size: str = os.getenv("STT_MODEL_SIZE", "small")
    stt_device: str = os.getenv("STT_DEVICE", "auto")
    stt_compute_type: str = os.getenv("STT_COMPUTE_TYPE", "auto")

    # --- TTS (Kokoro + Piper) ---
    tts_enabled: bool = os.getenv("TTS_ENABLED", "true").lower() == "true"
    tts_device: str = os.getenv("TTS_DEVICE", "auto")
    piper_voices_dir: Path = Path(os.getenv("PIPER_VOICES_DIR", str(Path(__file__).resolve().parents[1] / "data" / "piper_voices")))


def _sync_hf_key() -> None:
    """Bridge old HF_TOKEN env var to LiteLLM's expected HUGGINGFACE_API_KEY."""
    if not os.getenv("HUGGINGFACE_API_KEY"):
        hf_token = os.getenv("HF_TOKEN")
        if hf_token:
            os.environ["HUGGINGFACE_API_KEY"] = hf_token


_sync_hf_key()
settings = Settings()
