from __future__ import annotations

import asyncio
import io
import logging
import time
from dataclasses import dataclass, field
from typing import Optional

logger = logging.getLogger(__name__)

# Minimum accumulated audio (seconds) before attempting partial transcription
_PARTIAL_INTERVAL_S = 1.0
# Silence duration (seconds) to trigger final transcription
_SILENCE_THRESHOLD_S = 0.6
# If transcript text is unchanged for this many consecutive checks, treat as final
_STABLE_COUNT_FOR_FINAL = 1


@dataclass
class TranscriptionResult:
    text: str
    is_final: bool
    confidence: float = 0.0


@dataclass
class _SessionBuffer:
    """Per-session audio accumulator."""
    pcm_parts: list[bytes] = field(default_factory=list)
    pcm_total: int = 0
    raw_total: int = 0
    last_partial_at: float = 0.0
    last_chunk_at: float = 0.0
    last_text: str = ""
    stable_count: int = 0


class STTService:
    """Speech-to-text service backed by Faster-Whisper.

    Lazily loads the model on first use. Accumulates per-session audio
    chunks and uses VAD to detect speech boundaries.
    """

    def __init__(
        self,
        model_size: str = "small",
        device: str = "auto",
        compute_type: str = "auto",
    ) -> None:
        self.model_size = model_size
        self.device = device
        self.compute_type = compute_type
        self._model = None
        self._available = False
        self._import_checked = False
        self._buffers: dict[str, _SessionBuffer] = {}

    @property
    def available(self) -> bool:
        if not self._import_checked:
            self._check_import()
        return self._available

    def _check_import(self) -> None:
        """Quick check that faster-whisper is importable (no model download yet)."""
        if self._import_checked:
            return
        self._import_checked = True
        try:
            import faster_whisper  # noqa: F401
            self._available = True
            logger.info("STT (faster-whisper) available — model will load on first transcription")
        except Exception as exc:
            logger.warning("faster-whisper not importable: %s — server STT disabled", exc)
            self._available = False

    def _ensure_model(self) -> None:
        if self._model is not None:
            return

        try:
            from faster_whisper import WhisperModel

            # Auto-detect device
            device = self.device
            compute_type = self.compute_type
            if device == "auto":
                try:
                    import torch
                    device = "cuda" if torch.cuda.is_available() else "cpu"
                except ImportError:
                    device = "cpu"
            if compute_type == "auto":
                compute_type = "float16" if device == "cuda" else "int8"

            self._model = WhisperModel(
                self.model_size,
                device=device,
                compute_type=compute_type,
            )
            self._available = True
            logger.info("STT model loaded: size=%s device=%s compute=%s", self.model_size, device, compute_type)
        except Exception as exc:
            logger.warning("Failed to load STT model: %s — server STT disabled", exc)
            self._available = False

    def _get_buffer(self, session_id: str) -> _SessionBuffer:
        if session_id not in self._buffers:
            self._buffers[session_id] = _SessionBuffer()
        return self._buffers[session_id]

    def _decode_webm_to_pcm(self, webm_data: bytes) -> Optional[bytes]:
        """Convert webm/opus audio to 16kHz mono PCM using PyAV (no system ffmpeg needed)."""
        try:
            import av
            import numpy as np

            container = av.open(io.BytesIO(webm_data), format="webm")
            resampler = av.AudioResampler(format="s16", layout="mono", rate=16000)

            frames: list[bytes] = []
            for frame in container.decode(audio=0):
                resampled = resampler.resample(frame)
                for r in resampled:
                    frames.append(r.to_ndarray().tobytes())
            container.close()

            if not frames:
                return None
            return b"".join(frames)
        except Exception as exc:
            logger.warning("Audio decode failed: %s", exc)
            return None

    def _transcribe_sync(self, pcm_data: bytes) -> TranscriptionResult:
        """Run Whisper transcription (blocking). Called via asyncio.to_thread."""
        import numpy as np

        audio_array = np.frombuffer(pcm_data, dtype=np.int16).astype(np.float32) / 32768.0

        if len(audio_array) < 1600:  # < 0.1s of audio at 16kHz
            return TranscriptionResult(text="", is_final=False, confidence=0.0)

        segments, info = self._model.transcribe(
            audio_array,
            beam_size=3,
            language="en",
            vad_filter=True,
            vad_parameters=dict(
                min_silence_duration_ms=int(_SILENCE_THRESHOLD_S * 1000),
                speech_pad_ms=200,
            ),
        )

        texts = []
        total_prob = 0.0
        count = 0
        for segment in segments:
            texts.append(segment.text.strip())
            total_prob += segment.avg_logprob
            count += 1

        text = " ".join(texts).strip()
        confidence = (total_prob / count) if count > 0 else 0.0

        return TranscriptionResult(text=text, is_final=False, confidence=confidence)

    async def transcribe_chunk(
        self, session_id: str, audio_bytes: bytes, is_raw_pcm: bool = False
    ) -> Optional[TranscriptionResult]:
        """Feed an audio chunk and return a transcription result if ready.

        Returns None if not enough audio has accumulated yet.
        Returns a TranscriptionResult with is_final=True when the user
        has stopped speaking (transcript unchanged across checks).

        If is_raw_pcm is True, audio_bytes is 16kHz mono int16 PCM.
        Otherwise it is webm/opus and will be decoded.
        """
        self._ensure_model()
        if not self._available:
            return None

        buf = self._get_buffer(session_id)
        buf.raw_total += len(audio_bytes)
        buf.last_chunk_at = time.monotonic()

        if is_raw_pcm:
            buf.pcm_parts.append(audio_bytes)
            buf.pcm_total += len(audio_bytes)
        else:
            pcm = await asyncio.to_thread(self._decode_webm_to_pcm, audio_bytes)
            if pcm:
                buf.pcm_parts.append(pcm)
                buf.pcm_total += len(pcm)

        # Don't transcribe until we have ~0.5s of PCM (16kHz mono int16 = 32KB/s)
        if buf.pcm_total < 16000:
            return None

        now = time.monotonic()
        time_since_partial = now - buf.last_partial_at

        # Only attempt transcription every _PARTIAL_INTERVAL_S seconds
        if buf.last_partial_at > 0 and time_since_partial < _PARTIAL_INTERVAL_S:
            return None

        pcm_data = b"".join(buf.pcm_parts)
        result = await asyncio.to_thread(self._transcribe_sync, pcm_data)
        buf.last_partial_at = now

        if not result.text:
            return None

        # Detect end-of-speech: if the transcript hasn't changed across
        # consecutive transcription attempts, the user has stopped talking.
        if result.text == buf.last_text and buf.last_text:
            buf.stable_count += 1
            if buf.stable_count >= _STABLE_COUNT_FOR_FINAL:
                self.reset_session(session_id)
                return TranscriptionResult(
                    text=result.text, is_final=True, confidence=result.confidence
                )
        else:
            buf.stable_count = 0
        buf.last_text = result.text

        return result

    async def finalize_session_audio(self, session_id: str) -> Optional[TranscriptionResult]:
        """Force-transcribe any remaining buffered audio and return final result."""
        self._ensure_model()
        if not self._available:
            return None

        buf = self._get_buffer(session_id)
        if not buf.pcm_parts:
            return None

        pcm_data = b"".join(buf.pcm_parts)
        if len(pcm_data) < 3200:
            self.reset_session(session_id)
            return None

        result = await asyncio.to_thread(self._transcribe_sync, pcm_data)
        self.reset_session(session_id)

        if not result.text:
            return None

        return TranscriptionResult(text=result.text, is_final=True, confidence=result.confidence)

    def reset_session(self, session_id: str) -> None:
        """Clear the audio buffer for a session."""
        self._buffers.pop(session_id, None)
