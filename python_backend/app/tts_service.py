from __future__ import annotations

import asyncio
import logging
import queue
from pathlib import Path
from typing import AsyncGenerator, Optional

import numpy as np

from .config import settings
from .voice_map import DEFAULT_VOICE, lang_code_for_voice, resolve_piper_voice

logger = logging.getLogger(__name__)

KOKORO_SAMPLE_RATE = 24000
PIPER_SAMPLE_RATE = 22050


class TTSService:
    """Text-to-speech service supporting Kokoro (balanced/quality) and Piper (fast).

    Lazily loads each engine on first use. Both engines stream sentence-level
    int16 PCM audio, but at different sample rates.
    """

    def __init__(self, device: str = "auto") -> None:
        self.device = device
        # Kokoro state
        self._kokoro_pipelines: dict[str, object] = {}  # lang_code → KPipeline
        self._kokoro_available = False
        self._kokoro_init_attempted = False
        # Piper state
        self._piper_voices: dict[str, object] = {}  # piper_voice_name → PiperVoice
        self._piper_available = False
        self._piper_init_attempted = False

    # ------------------------------------------------------------------
    # Availability
    # ------------------------------------------------------------------
    @property
    def available(self) -> bool:
        if not self._kokoro_init_attempted:
            self._ensure_kokoro()
        if not self._piper_init_attempted:
            self._ensure_piper()
        return self._kokoro_available or self._piper_available

    def _engine_available(self, engine: str) -> bool:
        if engine == "piper":
            if not self._piper_init_attempted:
                self._ensure_piper()
            return self._piper_available
        if not self._kokoro_init_attempted:
            self._ensure_kokoro()
        return self._kokoro_available

    # ------------------------------------------------------------------
    # Kokoro init & synthesis
    # ------------------------------------------------------------------
    def _ensure_kokoro(self) -> None:
        if self._kokoro_init_attempted:
            return
        self._kokoro_init_attempted = True
        try:
            from kokoro import KPipeline  # noqa: F401
            self._kokoro_available = True
            logger.info("TTS (Kokoro) available — models will load on first synthesis")
        except Exception as exc:
            logger.warning("Failed to import Kokoro: %s — Kokoro TTS disabled", exc)
            self._kokoro_available = False

    def _get_kokoro_pipeline(self, lang_code: str) -> object:
        if lang_code not in self._kokoro_pipelines:
            from kokoro import KPipeline
            self._kokoro_pipelines[lang_code] = KPipeline(lang_code=lang_code)
            logger.info("Loaded Kokoro pipeline for lang=%s", lang_code)
        return self._kokoro_pipelines[lang_code]

    def _synthesize_kokoro_to_queue(
        self, text: str, voice_id: str, speed: float, q: queue.Queue
    ) -> None:
        try:
            lang_code = lang_code_for_voice(voice_id)
            pipeline = self._get_kokoro_pipeline(lang_code)
            for _graphemes, _phonemes, audio in pipeline(text, voice=voice_id, speed=speed):
                if hasattr(audio, 'numpy'):
                    audio = audio.numpy()
                audio_np = np.asarray(audio, dtype=np.float32)
                pcm_int16 = (audio_np * 32767).astype(np.int16)
                q.put(pcm_int16.tobytes())
        except Exception as exc:
            logger.warning("Kokoro synthesis failed for voice=%s: %s", voice_id, exc)
        finally:
            q.put(None)

    # ------------------------------------------------------------------
    # Piper init & synthesis
    # ------------------------------------------------------------------
    def _ensure_piper(self) -> None:
        if self._piper_init_attempted:
            return
        self._piper_init_attempted = True
        try:
            from piper.voice import PiperVoice  # noqa: F401
            voices_dir = settings.piper_voices_dir
            if voices_dir.is_dir() and any(voices_dir.glob("*.onnx")):
                self._piper_available = True
                logger.info("TTS (Piper) available — voices dir: %s", voices_dir)
            else:
                logger.warning("Piper importable but no voice files found in %s — Piper TTS disabled", voices_dir)
                self._piper_available = False
        except Exception as exc:
            logger.warning("Failed to import Piper: %s — Piper TTS disabled", exc)
            self._piper_available = False

    def _get_piper_voice(self, piper_voice_name: str) -> object:
        if piper_voice_name not in self._piper_voices:
            from piper.voice import PiperVoice
            model_path = settings.piper_voices_dir / f"{piper_voice_name}.onnx"
            if not model_path.exists():
                logger.warning("Piper voice model not found: %s — downloading", model_path)
                from piper.download_voices import download_voice
                settings.piper_voices_dir.mkdir(parents=True, exist_ok=True)
                download_voice(piper_voice_name, settings.piper_voices_dir)
            self._piper_voices[piper_voice_name] = PiperVoice.load(str(model_path))
            logger.info("Loaded Piper voice: %s", piper_voice_name)
        return self._piper_voices[piper_voice_name]

    def _synthesize_piper_to_queue(
        self, text: str, piper_voice_name: str, q: queue.Queue
    ) -> None:
        try:
            voice = self._get_piper_voice(piper_voice_name)
            for chunk in voice.synthesize(text):
                q.put(chunk.audio_int16_bytes)
        except Exception as exc:
            logger.warning("Piper synthesis failed for voice=%s: %s", piper_voice_name, exc)
        finally:
            q.put(None)

    # ------------------------------------------------------------------
    # Unified synthesis interface
    # ------------------------------------------------------------------
    async def synthesize(
        self, text: str, voice_id: str, speed: float = 1.0, engine: str = "kokoro"
    ) -> AsyncGenerator[tuple[bytes, int], None]:
        """Stream PCM audio chunks for the given text.

        Yields (int16_pcm_bytes, sample_rate) tuples, one per sentence/chunk.
        *engine* selects "kokoro" (24 kHz) or "piper" (22.05 kHz).
        Falls back to the other engine if the requested one is unavailable.
        """
        # Resolve engine with fallback
        if engine == "piper" and not self._engine_available("piper"):
            logger.warning("Piper unavailable, falling back to Kokoro for this request")
            engine = "kokoro"
        if engine == "kokoro" and not self._engine_available("kokoro"):
            logger.warning("Kokoro unavailable, falling back to Piper for this request")
            engine = "piper"

        if not self._engine_available(engine):
            return

        voice_id = voice_id or DEFAULT_VOICE
        q: queue.Queue = queue.Queue()
        loop = asyncio.get_event_loop()

        if engine == "piper":
            piper_voice_name = resolve_piper_voice(voice_id)
            loop.run_in_executor(None, self._synthesize_piper_to_queue, text, piper_voice_name, q)
            sample_rate = PIPER_SAMPLE_RATE
        else:
            loop.run_in_executor(None, self._synthesize_kokoro_to_queue, text, voice_id, speed, q)
            sample_rate = KOKORO_SAMPLE_RATE

        while True:
            chunk = await asyncio.to_thread(q.get)
            if chunk is None:
                break
            yield (chunk, sample_rate)
