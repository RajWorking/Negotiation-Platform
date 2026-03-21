from __future__ import annotations

import base64
from pathlib import Path
from typing import Optional

from .agents import CoachingAgent, PracticeAgent
from .document_ingestion import DocumentIngestionService
from .feature_extraction import extract_features
from .hf_client import HuggingFaceChatClient
from .model_router import route_mode
from .schemas import (
    BehavioralFeatures,
    Checkpoint,
    CoachingReport,
    ConversationTurn,
    CreateSessionRequest,
    DocumentChunk,
    LiveState,
    SessionState,
    SimulationConfig,
)
from .storage import SessionStore
from .utils import ensure_dir, make_id, now_iso, summarize_text


class SessionOrchestrator:
    def __init__(
        self,
        store: SessionStore,
        document_service: DocumentIngestionService,
        audio_dir: Path,
        hf_client: HuggingFaceChatClient,
    ) -> None:
        self.store = store
        self.document_service = document_service
        self.audio_dir = audio_dir
        self.practice_agent = PracticeAgent(hf_client)
        self.coaching_agent = CoachingAgent(hf_client)

    def _require_session(self, session_id: str) -> SessionState:
        session = self.store.get(session_id)
        if not session:
            raise ValueError("Session not found")
        return session

    def create_session(self, payload: CreateSessionRequest) -> SessionState:
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
            reports=[],
            documentChunks=[],
            features=BehavioralFeatures(),
            archivedTurns=[],
            liveState=LiveState(lastUpdatedAt=created_at),
            createdAt=created_at,
            updatedAt=created_at,
        )
        self.store.save(session)
        return session

    def upload_documents(self, session_id: str, files: list[dict[str, str]]) -> dict[str, object]:
        session = self._require_session(session_id)
        indexed = 0
        for file in files:
            file_name = str(file["fileName"])
            saved = self.document_service.save_upload(session_id, file_name, str(file["base64"]))
            chunks = self.document_service.ingest(session_id, file_name, saved)
            session.document_chunks.extend(chunks)
            indexed += 1
        session.updated_at = now_iso()
        self.store.save(session)
        return {"uploaded": len(files), "indexed": indexed, "status": "ready"}

    def start(self, session_id: str) -> SessionState:
        session = self._require_session(session_id)
        session.status = "live"
        session.live_state.current_speaker = "user"
        session.live_state.last_updated_at = now_iso()
        self.store.save(session)
        return session

    def pause(self, session_id: str) -> SessionState:
        session = self._require_session(session_id)
        session.status = "paused"
        session.live_state.current_speaker = None
        session.live_state.last_updated_at = now_iso()
        self.store.save(session)
        return session

    def resume(self, session_id: str) -> SessionState:
        session = self._require_session(session_id)
        session.status = "live"
        session.live_state.current_speaker = "user"
        session.live_state.last_updated_at = now_iso()
        self.store.save(session)
        return session

    def end(self, session_id: str) -> SessionState:
        session = self._require_session(session_id)
        session.status = "ended"
        session.live_state.current_speaker = None
        session.live_state.last_updated_at = now_iso()
        self.store.save(session)
        return session

    def state(self, session_id: str) -> SessionState:
        return self._require_session(session_id)

    def checkpoints(self, session_id: str) -> list[Checkpoint]:
        return self._require_session(session_id).checkpoints

    def ingest_audio_chunk(self, session_id: str, encoded: Optional[str]) -> LiveState:
        session = self._require_session(session_id)
        session.live_state.audio_chunks_received += 1
        if encoded:
            data = base64.b64decode(encoded)
            ensure_dir(self.audio_dir)
            target = self.audio_dir / f"{session_id}.webm"
            with target.open("ab") as handle:
                handle.write(data)
            session.live_state.bytes_received += len(data)
        session.live_state.last_updated_at = now_iso()
        self.store.save(session)
        return session.live_state

    def set_partial_transcript(self, session_id: str, text: str) -> SessionState:
        session = self._require_session(session_id)
        session.live_state.partial_transcript = text
        session.live_state.current_speaker = "user"
        session.live_state.last_updated_at = now_iso()
        self.store.save(session)
        return session

    async def finalize_user_transcript(self, session_id: str, text: str) -> dict[str, object]:
        session = self._require_session(session_id)
        if session.status in {"paused", "ended"}:
            return {"session": session, "user_turn": None, "agent_turn": None, "checkpoint": None}

        routing = route_mode(session.config.mode)
        user_turn = ConversationTurn(
            turnId=make_id("turn"),
            sessionId=session_id,
            speaker="user",
            transcript=text,
            startedAt=now_iso(),
            endedAt=now_iso(),
        )
        session.turns.append(user_turn)
        session.live_state.partial_transcript = ""
        session.live_state.current_speaker = "agent"
        session.features = extract_features(session.turns)

        agent_payload = await self.practice_agent.generate(
            config={
                "situation_description": session.config.situation_description,
                "partner_tone": session.config.partner_tone,
            },
            routing=routing,
            turns=[turn.model_dump(mode="json", by_alias=False) for turn in session.turns],
        )
        agent_turn = ConversationTurn(
            turnId=make_id("turn"),
            sessionId=session_id,
            speaker="agent",
            transcript=str(agent_payload["reply_text"]),
            emotionTags=list(agent_payload.get("emotion_tags", [])),
            startedAt=now_iso(),
            endedAt=now_iso(),
            metadata={
                "intent": agent_payload.get("intent"),
            },
        )
        session.turns.append(agent_turn)
        session.live_state.turn_index = len(session.turns)
        session.live_state.current_speaker = "user"
        session.features = extract_features(session.turns)

        checkpoint = Checkpoint(
            checkpointId=make_id("ckpt"),
            sessionId=session_id,
            turnIndex=len(session.turns),
            transcriptSnapshot=[turn.model_copy(deep=True) for turn in session.turns],
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
        session.updated_at = now_iso()
        self.store.save(session)
        return {"session": session, "user_turn": user_turn, "agent_turn": agent_turn, "checkpoint": checkpoint}

    async def coach(self, session_id: str, window_turns: int) -> CoachingReport:
        session = self._require_session(session_id)
        routing = route_mode(session.config.mode)
        recent_turns = session.turns[-max(2, window_turns) :]
        retrieved = self.document_service.retrieve(
            session.document_chunks,
            " ".join(
                [
                    session.config.situation_description,
                    " ".join(turn.transcript for turn in recent_turns),
                    f"apologies {session.features.apology_frequency} anchors {session.features.anchoring_attempts}",
                ]
            ),
        )
        payload = await self.coaching_agent.generate(
            session_id=session_id,
            config={
                "situation_description": session.config.situation_description,
                "coaching_focuses": session.config.coaching_focuses,
            },
            routing=routing,
            recent_turns=[turn.model_dump(mode="json", by_alias=False) for turn in recent_turns],
            features=session.features.model_dump(mode="json", by_alias=False),
            retrieved=retrieved,
        )
        report = CoachingReport(
            reportId=make_id("coach"),
            sessionId=session_id,
            basedOnTurnRange={"start": max(0, len(session.turns) - len(recent_turns)), "end": max(0, len(session.turns) - 1)},
            strengths=list(payload.get("strengths", []))[:3],
            weakSignals=list(payload.get("weak_signals", []))[:3],
            suggestedNextMove=str(payload.get("suggested_next_move", "")),
            retrievedEvidence=list(payload.get("retrieved_evidence", [])),
            createdAt=now_iso(),
        )
        session.reports.append(report)
        session.status = "paused"
        session.updated_at = now_iso()
        self.store.save(session)
        return report

    def rewind(self, session_id: str, checkpoint_id: str) -> dict[str, object]:
        session = self._require_session(session_id)
        checkpoint = next((item for item in session.checkpoints if item.checkpoint_id == checkpoint_id), None)
        if not checkpoint:
            raise ValueError("Checkpoint not found")
        later_turns = session.turns[len(checkpoint.transcript_snapshot) :]
        session.archived_turns.extend(later_turns)
        session.turns = [turn.model_copy(deep=True) for turn in checkpoint.transcript_snapshot]
        session.live_state.turn_index = checkpoint.turn_index
        session.live_state.last_checkpoint_id = checkpoint.checkpoint_id
        session.live_state.current_speaker = "user"
        session.live_state.partial_transcript = ""
        session.status = "live"
        session.features = extract_features(session.turns)
        session.updated_at = now_iso()
        self.store.save(session)
        return {"status": "restored", "turn_index": checkpoint.turn_index, "session": session}
