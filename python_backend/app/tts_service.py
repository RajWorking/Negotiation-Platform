from __future__ import annotations

import asyncio
import logging
import queue
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

    def _synthesize_to_queue(
        self, text: str, voice_id: str, speed: float, q: queue.Queue
    ) -> None:
        """Run Kokoro synthesis (blocking), pushing each sentence's audio to *q*."""
        try:
            lang_code = lang_code_for_voice(voice_id)
            pipeline = self._get_pipeline(lang_code)

            for _graphemes, _phonemes, audio in pipeline(text, voice=voice_id, speed=speed):
                if hasattr(audio, 'numpy'):
                    audio = audio.numpy()
                audio_np = np.asarray(audio, dtype=np.float32)
                pcm_int16 = (audio_np * 32767).astype(np.int16)
                q.put(pcm_int16.tobytes())
        except Exception as exc:
            logger.warning("TTS synthesis failed for voice=%s: %s", voice_id, exc)
        finally:
            q.put(None)

    async def synthesize(
        self, text: str, voice_id: str, speed: float = 1.0
    ) -> AsyncGenerator[bytes, None]:
        """Stream PCM audio chunks for the given text.

        Yields int16 PCM bytes at 24kHz, one chunk per sentence.
        Each sentence is yielded as soon as it's synthesized.
        """
        self._ensure_model()
        if not self._available:
            return

        voice_id = voice_id or DEFAULT_VOICE
        q: queue.Queue = queue.Queue()

        loop = asyncio.get_event_loop()
        loop.run_in_executor(None, self._synthesize_to_queue, text, voice_id, speed, q)

        while True:
            chunk = await asyncio.to_thread(q.get)
            if chunk is None:
                break
            yield chunk
