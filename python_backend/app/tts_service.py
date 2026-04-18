from __future__ import annotations

import asyncio
import logging
from typing import AsyncGenerator, Optional

import numpy as np

from .voice_map import DEFAULT_VOICE, lang_code_for_voice

logger = logging.getLogger(__name__)

# Kokoro outputs 24kHz audio
SAMPLE_RATE = 24000


class TTSService:
    """Text-to-speech service backed by Kokoro.

    Lazily loads the model on first use. Synthesizes text sentence-by-sentence
    for low first-byte latency, outputting 24kHz int16 PCM.
    """

    def __init__(self, device: str = "auto") -> None:
        self.device = device
        self._pipelines: dict[str, object] = {}  # lang_code → KPipeline
        self._available = False
        self._init_attempted = False

    @property
    def available(self) -> bool:
        if not self._init_attempted:
            self._ensure_model()
        return self._available

    def _ensure_model(self) -> None:
        if self._init_attempted:
            return
        self._init_attempted = True

        try:
            from kokoro import KPipeline  # noqa: F401
            self._available = True
            logger.info("TTS (Kokoro) available — models will load on first synthesis")
        except Exception as exc:
            logger.warning("Failed to import Kokoro: %s — server TTS disabled", exc)
            self._available = False

    def _get_pipeline(self, lang_code: str) -> object:
        """Get or create a KPipeline for the given language."""
        if lang_code not in self._pipelines:
            from kokoro import KPipeline
            self._pipelines[lang_code] = KPipeline(lang_code=lang_code)
            logger.info("Loaded Kokoro pipeline for lang=%s", lang_code)
        return self._pipelines[lang_code]

    def _synthesize_sync(self, text: str, voice_id: str) -> list[bytes]:
        """Run Kokoro synthesis (blocking). Returns list of PCM chunks."""
        lang_code = lang_code_for_voice(voice_id)
        pipeline = self._get_pipeline(lang_code)

        chunks: list[bytes] = []
        for _graphemes, _phonemes, audio in pipeline(text, voice=voice_id, speed=1.0):
            # audio may be a torch Tensor or numpy array depending on Kokoro version
            if hasattr(audio, 'numpy'):
                audio = audio.numpy()
            audio_np = np.asarray(audio, dtype=np.float32)
            pcm_int16 = (audio_np * 32767).astype(np.int16)
            chunks.append(pcm_int16.tobytes())

        return chunks

    async def synthesize(self, text: str, voice_id: str) -> AsyncGenerator[bytes, None]:
        """Stream PCM audio chunks for the given text.

        Yields int16 PCM bytes at 24kHz, one chunk per sentence.
        """
        self._ensure_model()
        if not self._available:
            return

        voice_id = voice_id or DEFAULT_VOICE

        try:
            chunks = await asyncio.to_thread(self._synthesize_sync, text, voice_id)
            for chunk in chunks:
                yield chunk
        except Exception as exc:
            logger.warning("TTS synthesis failed for voice=%s: %s", voice_id, exc)

    async def synthesize_full(self, text: str, voice_id: str) -> Optional[bytes]:
        """Synthesize complete audio and return as a single PCM buffer."""
        all_chunks: list[bytes] = []
        async for chunk in self.synthesize(text, voice_id):
            all_chunks.append(chunk)
        if not all_chunks:
            return None
        return b"".join(all_chunks)
