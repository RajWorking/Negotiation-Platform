from __future__ import annotations

import base64
import logging
from pathlib import Path
from typing import AsyncGenerator, Awaitable, Callable, Optional, Union

from .agents import CoachingAgent, PracticeAgent
from .analysis_orchestrator import SemanticAnalysisOrchestrator
from .document_ingestion import DocumentIngestionService
from .feature_extraction import extract_features
from .key_moment_detector import detect_key_moments
from .llm_client import LLMClient
from .model_router import route_mode
from .schemas import (
    BehavioralFeatures,
    Checkpoint,
    CoachingReport,
    ConversationTurn,
    CreateSessionRequest,
    LiveState,
    SessionState,
    SimulationConfig,
)
from .utils import ensure_dir, make_id, now_iso, summarize_text

logger = logging.getLogger(__name__)

# Type alias — works with both FileSessionStore and PostgresSessionStore
SessionStore = object  # duck-typed: must have async get() and save()


class SessionOrchestrator:
    """Central coordinator for session lifecycle, turn processing, and coaching."""

    def __init__(
        self,
        store: SessionStore,
        document_service: DocumentIngestionService,
        audio_dir: Path,
        llm: LLMClient,
        stt_service: object = None,
        tts_service: object = None,
    ) -> None:
        self.store = store
        self.document_service = document_service
        self.audio_dir = audio_dir
        self.practice_agent = PracticeAgent(llm)
        self.coaching_agent = CoachingAgent(llm)
        self.semantic_analysis_svc = SemanticAnalysisOrchestrator(llm)
        self.stt_service = stt_service
        self.tts_service = tts_service

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------
    async def _require_session(self, session_id: str) -> SessionState:
        session = await self.store.get(session_id)
        if not session:
            raise ValueError(f"Session not found: {session_id}")
        return session

    # ------------------------------------------------------------------
    # Session lifecycle
    # ------------------------------------------------------------------
    async def create_session(self, payload: CreateSessionRequest) -> SessionState:
        session_id = make_id("sess")
        created_at = now_iso()
        session = SessionState(
            sessionId=session_id,
            status="created",
            config=SimulationConfig(
                sessionId=session_id,
                situationDescription=payload.situation_description,
                partnerTone=payload.partner_tone,
                voiceProfile=payload.voice_profile,
                mode=payload.mode,
                coachingFocuses=payload.coaching_focuses,
                createdAt=created_at,
            ),
            turns=[],
            checkpoints=[],
            keyMoments=[],
            reports=[],
            documentChunks=[],
            features=BehavioralFeatures(),
            semanticAnalysis={},
            archivedTurns=[],
            liveState=LiveState(lastUpdatedAt=created_at),
            createdAt=created_at,
            updatedAt=created_at,
        )
        await self.store.save(session)
        logger.info("Created session %s (mode=%s, tone=%s)", session_id, payload.mode, payload.partner_tone)
        return session

    async def upload_documents(self, session_id: str, files: list[dict[str, str]]) -> dict[str, object]:
        session = await self._require_session(session_id)
        indexed = 0
        for file_entry in files:
            file_name = str(file_entry["fileName"])
            saved_path = self.document_service.save_upload(session_id, file_name, str(file_entry["base64"]))
            chunks = await self.document_service.ingest(session_id, file_name, saved_path)
            session.document_chunks.extend(chunks)
            indexed += 1
        await self.store.save(session)
        return {"uploaded": len(files), "indexed": indexed, "status": "ready"}

    async def start(self, session_id: str) -> SessionState:
        session = await self._require_session(session_id)
        session.status = "live"
        session.live_state.current_speaker = "user"
        session.live_state.last_updated_at = now_iso()
        await self.store.save(session)
        return session

    async def pause(self, session_id: str) -> SessionState:
        session = await self._require_session(session_id)
        session.status = "paused"
        session.live_state.current_speaker = None
        session.live_state.last_updated_at = now_iso()
        await self.store.save(session)
        return session

    async def resume(self, session_id: str) -> SessionState:
        session = await self._require_session(session_id)
        session.status = "live"
        session.live_state.current_speaker = "user"
        session.live_state.last_updated_at = now_iso()
        await self.store.save(session)
        return session

    async def end(self, session_id: str) -> SessionState:
        session = await self._require_session(session_id)
        session.status = "ended"
        session.live_state.current_speaker = None
        session.live_state.last_updated_at = now_iso()
        await self.store.save(session)
        return session

    async def state(self, session_id: str) -> SessionState:
        return await self._require_session(session_id)

    async def checkpoints(self, session_id: str) -> list[Checkpoint]:
        return (await self._require_session(session_id)).checkpoints

    # ------------------------------------------------------------------
    # Audio & transcript ingestion
    # ------------------------------------------------------------------
    async def ingest_audio_chunk(self, session_id: str, encoded: Optional[str]) -> LiveState:
        session = await self._require_session(session_id)
        session.live_state.audio_chunks_received += 1
        if encoded:
            data = base64.b64decode(encoded)
            ensure_dir(self.audio_dir)
            target = self.audio_dir / f"{session_id}.webm"
            with target.open("ab") as handle:
                handle.write(data)
            session.live_state.bytes_received += len(data)
        session.live_state.last_updated_at = now_iso()
        await self.store.save(session)
        return session.live_state

    async def set_partial_transcript(self, session_id: str, text: str) -> SessionState:
        session = await self._require_session(session_id)
        session.live_state.partial_transcript = text
        session.live_state.current_speaker = "user"
        session.live_state.last_updated_at = now_iso()
        await self.store.save(session)
        return session

    async def ingest_audio_chunk_with_stt(
        self, session_id: str, encoded: Optional[str], audio_format: Optional[str] = None
    ) -> dict[str, object]:
        """Ingest audio chunk, store to disk, and run STT if available."""
        live_state = await self.ingest_audio_chunk(session_id, encoded)
        transcription = None

        if self.stt_service and encoded:
            session = await self._require_session(session_id)
            routing = route_mode(session.config.mode)
            audio_bytes = base64.b64decode(encoded)
            is_raw_pcm = audio_format == "pcm_s16le"
            transcription = await self.stt_service.transcribe_chunk(
                session_id, audio_bytes, is_raw_pcm=is_raw_pcm,
                model_size=routing["stt_model_size"],
                beam_size=routing["stt_beam_size"],
            )

        return {"live_state": live_state, "transcription": transcription}

    async def finalize_stt_audio(self, session_id: str) -> object:
        """Force-finalize any buffered STT audio for the session."""
        if not self.stt_service:
            return None
        session = await self._require_session(session_id)
        routing = route_mode(session.config.mode)
        return await self.stt_service.finalize_session_audio(
            session_id,
            model_size=routing["stt_model_size"],
            beam_size=routing["stt_beam_size"],
        )

    async def synthesize_agent_speech(
        self, session_id: str, text: str
    ) -> AsyncGenerator[tuple[bytes, int], None]:
        """Synthesize agent speech using TTS. Yields (pcm_bytes, sample_rate) tuples."""
        if not self.tts_service:
            return

        from .voice_map import resolve_voice

        session = await self._require_session(session_id)
        routing = route_mode(session.config.mode)
        voice_id = resolve_voice(session.config.voice_profile)

        async for chunk, sample_rate in self.tts_service.synthesize(
            text, voice_id, speed=routing["tts_speed"], engine=routing["tts_engine"]
        ):
            yield (chunk, sample_rate)

    def reset_stt_session(self, session_id: str) -> None:
        """Clear STT audio buffer for a session."""
        if self.stt_service:
            self.stt_service.reset_session(session_id)

    # ------------------------------------------------------------------
    # Turn finalization — the core loop
    # ------------------------------------------------------------------
    async def finalize_user_transcript(
        self,
        session_id: str,
        text: str,
        on_progress: Callable[[str], Awaitable[None]] | None = None,
    ) -> dict[str, object]:
        session = await self._require_session(session_id)
        if session.status in {"paused", "ended"}:
            return {
                "session": session, "user_turn": None, "agent_turn": None,
                "checkpoint": None, "key_moments_created": [], "agent_source": "none",
            }

        routing = route_mode(session.config.mode)

        # Merge any accumulated partial transcript the client hadn't included
        existing_partial = (session.live_state.partial_transcript or "").strip()
        if existing_partial and existing_partial not in text:
            text = f"{existing_partial} {text}".strip()

        # Record user turn
        user_turn = ConversationTurn(
            turnId=make_id("turn"), sessionId=session_id,
            speaker="user", transcript=text,
            startedAt=now_iso(), endedAt=now_iso(),
        )
        session.turns.append(user_turn)
        session.live_state.partial_transcript = ""
        session.live_state.current_speaker = "agent"
        session.features = extract_features(session.turns)

        # Generate agent response
        try:
            if on_progress:
                await on_progress("generating_response")
        except Exception:
            pass
        agent_payload = await self.practice_agent.generate(
            config={
                "situation_description": session.config.situation_description,
                "partner_tone": session.config.partner_tone,
            },
            routing=routing,
            turns=[t.model_dump(mode="json", by_alias=False) for t in session.turns],
        )
        agent_source = agent_payload.get("source", "unknown")

        agent_turn = ConversationTurn(
            turnId=make_id("turn"), sessionId=session_id,
            speaker="agent", transcript=str(agent_payload["reply_text"]),
            emotionTags=list(agent_payload.get("emotion_tags", [])),
            startedAt=now_iso(), endedAt=now_iso(),
            metadata={"intent": agent_payload.get("intent"), "source": agent_source},
        )
        session.turns.append(agent_turn)
        session.live_state.turn_index = len(session.turns)
        session.live_state.current_speaker = "user"
        session.features = extract_features(session.turns)

        # Heuristic key moment detection (fast, synchronous)
        fallback_key_moments = detect_key_moments(session_id, session.turns)
        previous_kinds = {m.kind for m in session.key_moments}
        session.key_moments = fallback_key_moments
        new_key_moments = [m for m in session.key_moments if m.kind not in previous_kinds]

        # Create checkpoint
        checkpoint = Checkpoint(
            checkpointId=make_id("ckpt"), sessionId=session_id,
            turnIndex=len(session.turns),
            transcriptSnapshot=[t.model_copy(deep=True) for t in session.turns],
            stateSnapshot={
                "status": session.status,
                "features": session.features.model_dump(mode="json", by_alias=True),
                "liveState": session.live_state.model_dump(mode="json", by_alias=True),
            },
            summary=summarize_text(agent_turn.transcript, 72),
            createdAt=now_iso(),
        )
        session.checkpoints.append(checkpoint)
        session.live_state.last_checkpoint_id = checkpoint.checkpoint_id
        await self.store.save(session)

        return {
            "session": session, "user_turn": user_turn, "agent_turn": agent_turn,
            "checkpoint": checkpoint, "key_moments_created": new_key_moments,
            "agent_source": agent_source,
        }

    async def run_background_analysis(self, session_id: str) -> dict[str, object]:
        """Run semantic analysis in the background after agent response is sent."""
        session = await self._require_session(session_id)
        routing = route_mode(session.config.mode)

        previous_kinds = {m.kind for m in session.key_moments}
        fallback_key_moments = detect_key_moments(session_id, session.turns)

        semantic_result = await self.semantic_analysis_svc.analyze(
            session_id=session_id,
            scenario=session.config.situation_description,
            partner_tone=session.config.partner_tone,
            routing=routing,
            turns=session.turns,
            fallback_key_moments=fallback_key_moments,
            heuristic_features=session.features.model_dump(mode="json", by_alias=False),
        )
        session.semantic_analysis = {
            "signals": semantic_result.get("signals", []),
            "summary": semantic_result.get("summary", ""),
            "source": semantic_result.get("source", "heuristic_fallback"),
        }
        session.key_moments = semantic_result.get("key_moments", fallback_key_moments)
        new_key_moments = [m for m in session.key_moments if m.kind not in previous_kinds]

        await self.store.save(session)
        return {"key_moments_created": new_key_moments, "session": session}

    # ------------------------------------------------------------------
    # Coaching
    # ------------------------------------------------------------------
    async def coach(self, session_id: str, window_turns: int) -> CoachingReport:
        session = await self._require_session(session_id)
        routing = route_mode(session.config.mode)
        recent_turns = session.turns[-max(2, window_turns):]

        retrieved = self.document_service.retrieve(
            session.document_chunks,
            " ".join([
                session.config.situation_description,
                " ".join(t.transcript for t in recent_turns),
                f"apologies {session.features.apology_frequency} anchors {session.features.anchoring_attempts}",
            ]),
        )

        payload = await self.coaching_agent.generate(
            session_id=session_id,
            config={
                "situation_description": session.config.situation_description,
                "coaching_focuses": session.config.coaching_focuses,
            },
            routing=routing,
            recent_turns=[t.model_dump(mode="json", by_alias=False) for t in recent_turns],
            features=session.features.model_dump(mode="json", by_alias=False),
            semantic_analysis=session.semantic_analysis,
            key_moments=[m.model_dump(mode="json", by_alias=False) for m in session.key_moments],
            retrieved=retrieved,
        )

        report = CoachingReport(
            reportId=make_id("coach"), sessionId=session_id,
            basedOnTurnRange={
                "start": max(0, len(session.turns) - len(recent_turns)),
                "end": max(0, len(session.turns) - 1),
            },
            strengths=list(payload.get("strengths", []))[:3],
            weakSignals=list(payload.get("weak_signals", []))[:3],
            suggestedNextMove=str(payload.get("suggested_next_move", "")),
            retrievedEvidence=list(payload.get("retrieved_evidence", [])),
            createdAt=now_iso(),
        )
        session.reports.append(report)
        session.status = "paused"
        await self.store.save(session)
        return report

    # ------------------------------------------------------------------
    # Rewind
    # ------------------------------------------------------------------
    async def rewind(self, session_id: str, checkpoint_id: str) -> dict[str, object]:
        session = await self._require_session(session_id)
        checkpoint = next(
            (cp for cp in session.checkpoints if cp.checkpoint_id == checkpoint_id),
            None,
        )
        if not checkpoint:
            raise ValueError(f"Checkpoint not found: {checkpoint_id}")

        later_turns = session.turns[len(checkpoint.transcript_snapshot):]
        session.archived_turns.extend(later_turns)
        session.turns = [t.model_copy(deep=True) for t in checkpoint.transcript_snapshot]
        session.live_state.turn_index = checkpoint.turn_index
        session.live_state.last_checkpoint_id = checkpoint.checkpoint_id
        session.live_state.current_speaker = "user"
        session.live_state.partial_transcript = ""
        session.status = "live"
        session.features = extract_features(session.turns)
        session.key_moments = detect_key_moments(session_id, session.turns)
        session.semantic_analysis = {"signals": [], "summary": "", "source": "reset_after_rewind"}
        await self.store.save(session)

        logger.info("Rewound session %s to checkpoint %s (turn %d)", session_id, checkpoint_id, checkpoint.turn_index)
        return {"status": "restored", "turn_index": checkpoint.turn_index, "session": session}
