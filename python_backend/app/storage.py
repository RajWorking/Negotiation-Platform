from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Optional

import asyncpg

from .schemas import (
    BehavioralFeatures,
    Checkpoint,
    CoachingReport,
    ConversationTurn,
    DocumentChunk,
    KeyMoment,
    LiveState,
    SessionState,
    SimulationConfig,
)
from .utils import ensure_dir, now_iso, read_json, write_json

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# File-based store (local development fallback)
# ---------------------------------------------------------------------------
class FileSessionStore:
    """JSON-file storage for local development when PostgreSQL is unavailable."""

    def __init__(self, base_dir: Path) -> None:
        self.sessions_dir = base_dir / "sessions"

    async def init(self) -> None:
        ensure_dir(self.sessions_dir)

    def _path(self, session_id: str) -> Path:
        return self.sessions_dir / f"{session_id}.json"

    async def save(self, session: SessionState) -> SessionState:
        session.updated_at = now_iso()
        write_json(self._path(session.session_id), session.model_dump(mode="json", by_alias=True))
        return session

    async def get(self, session_id: str) -> Optional[SessionState]:
        raw = read_json(self._path(session_id), None)
        if not raw:
            return None
        try:
            return SessionState.model_validate(raw)
        except Exception:
            logger.warning("Corrupt session file for %s", session_id)
            return None


# ---------------------------------------------------------------------------
# PostgreSQL store (production)
# ---------------------------------------------------------------------------
class PostgresSessionStore:
    """PostgreSQL-backed session storage for production deployments."""

    def __init__(self, pool: asyncpg.Pool) -> None:
        self.pool = pool

    async def init(self) -> None:
        pass  # Schema is applied in database.init_db()

    async def save(self, session: SessionState) -> SessionState:
        session.updated_at = now_iso()

        async with self.pool.acquire() as conn:
            async with conn.transaction():
                # 1. Upsert session metadata
                await conn.execute(
                    """INSERT INTO sessions
                       (session_id, status, config, features, semantic_analysis, live_state, created_at, updated_at)
                       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
                       ON CONFLICT (session_id) DO UPDATE SET
                         status=EXCLUDED.status, config=EXCLUDED.config,
                         features=EXCLUDED.features, semantic_analysis=EXCLUDED.semantic_analysis,
                         live_state=EXCLUDED.live_state, updated_at=EXCLUDED.updated_at""",
                    session.session_id,
                    session.status,
                    session.config.model_dump(mode="json", by_alias=True),
                    session.features.model_dump(mode="json", by_alias=True),
                    session.semantic_analysis,
                    session.live_state.model_dump(mode="json", by_alias=True),
                    session.created_at,
                    session.updated_at,
                )

                # 2. Sync active turns
                if session.turns:
                    await conn.executemany(
                        """INSERT INTO turns
                           (turn_id,session_id,speaker,transcript,audio_uri,emotion_tags,
                            started_at,ended_at,metadata,is_archived,position)
                           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
                           ON CONFLICT (turn_id) DO UPDATE SET
                             is_archived=EXCLUDED.is_archived, position=EXCLUDED.position""",
                        [
                            (
                                t.turn_id, session.session_id, t.speaker, t.transcript,
                                t.audio_uri, t.emotion_tags, t.started_at, t.ended_at,
                                t.metadata, False, pos,
                            )
                            for pos, t in enumerate(session.turns)
                        ],
                    )

                # 3. Sync archived turns
                if session.archived_turns:
                    await conn.executemany(
                        """INSERT INTO turns
                           (turn_id,session_id,speaker,transcript,audio_uri,emotion_tags,
                            started_at,ended_at,metadata,is_archived,position)
                           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
                           ON CONFLICT (turn_id) DO UPDATE SET
                             is_archived=EXCLUDED.is_archived, position=EXCLUDED.position""",
                        [
                            (
                                t.turn_id, session.session_id, t.speaker, t.transcript,
                                t.audio_uri, t.emotion_tags, t.started_at, t.ended_at,
                                t.metadata, True, pos,
                            )
                            for pos, t in enumerate(session.archived_turns)
                        ],
                    )

                # 4. Replace key moments (they get rebuilt on rewind / semantic analysis)
                await conn.execute(
                    "DELETE FROM key_moments WHERE session_id=$1", session.session_id,
                )
                if session.key_moments:
                    await conn.executemany(
                        """INSERT INTO key_moments
                           (key_moment_id,session_id,kind,label,summary,turn_id,turn_index,speaker,created_at)
                           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)""",
                        [
                            (
                                km.key_moment_id, session.session_id, km.kind, km.label,
                                km.summary, km.turn_id, km.turn_index, km.speaker, km.created_at,
                            )
                            for km in session.key_moments
                        ],
                    )

                # 5. Append-only: checkpoints
                if session.checkpoints:
                    await conn.executemany(
                        """INSERT INTO checkpoints
                           (checkpoint_id,session_id,turn_index,summary,transcript_snapshot,state_snapshot,created_at)
                           VALUES ($1,$2,$3,$4,$5,$6,$7)
                           ON CONFLICT (checkpoint_id) DO NOTHING""",
                        [
                            (
                                cp.checkpoint_id, session.session_id, cp.turn_index,
                                cp.summary,
                                [t.model_dump(mode="json", by_alias=True) for t in cp.transcript_snapshot],
                                cp.state_snapshot,
                                cp.created_at,
                            )
                            for cp in session.checkpoints
                        ],
                    )

                # 6. Append-only: coaching reports
                if session.reports:
                    await conn.executemany(
                        """INSERT INTO coaching_reports
                           (report_id,session_id,based_on_turn_range,strengths,weak_signals,
                            suggested_next_move,retrieved_evidence,created_at)
                           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
                           ON CONFLICT (report_id) DO NOTHING""",
                        [
                            (
                                r.report_id, session.session_id, r.based_on_turn_range,
                                r.strengths, r.weak_signals, r.suggested_next_move,
                                r.retrieved_evidence, r.created_at,
                            )
                            for r in session.reports
                        ],
                    )

                # 7. Append-only: document chunks
                if session.document_chunks:
                    await conn.executemany(
                        """INSERT INTO document_chunks
                           (chunk_id,session_id,source_file_name,text,embedding,metadata)
                           VALUES ($1,$2,$3,$4,$5,$6)
                           ON CONFLICT (chunk_id) DO NOTHING""",
                        [
                            (
                                c.chunk_id, session.session_id, c.source_file_name,
                                c.text, c.embedding, c.metadata,
                            )
                            for c in session.document_chunks
                        ],
                    )

        return session

    async def get(self, session_id: str) -> Optional[SessionState]:
        async with self.pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT * FROM sessions WHERE session_id=$1", session_id,
            )
            if not row:
                return None

            turn_rows = await conn.fetch(
                "SELECT * FROM turns WHERE session_id=$1 AND NOT is_archived ORDER BY position",
                session_id,
            )
            archived_rows = await conn.fetch(
                "SELECT * FROM turns WHERE session_id=$1 AND is_archived ORDER BY position",
                session_id,
            )
            cp_rows = await conn.fetch(
                "SELECT * FROM checkpoints WHERE session_id=$1 ORDER BY created_at",
                session_id,
            )
            km_rows = await conn.fetch(
                "SELECT * FROM key_moments WHERE session_id=$1 ORDER BY turn_index",
                session_id,
            )
            report_rows = await conn.fetch(
                "SELECT * FROM coaching_reports WHERE session_id=$1 ORDER BY created_at",
                session_id,
            )
            chunk_rows = await conn.fetch(
                "SELECT * FROM document_chunks WHERE session_id=$1",
                session_id,
            )

        return SessionState(
            sessionId=row["session_id"],
            status=row["status"],
            config=SimulationConfig.model_validate(row["config"]),
            turns=[_row_to_turn(r) for r in turn_rows],
            archivedTurns=[_row_to_turn(r) for r in archived_rows],
            checkpoints=[_row_to_checkpoint(r) for r in cp_rows],
            keyMoments=[_row_to_key_moment(r) for r in km_rows],
            reports=[_row_to_report(r) for r in report_rows],
            documentChunks=[_row_to_chunk(r) for r in chunk_rows],
            features=BehavioralFeatures.model_validate(row["features"]),
            semanticAnalysis=row["semantic_analysis"],
            liveState=LiveState.model_validate(row["live_state"]),
            createdAt=row["created_at"],
            updatedAt=row["updated_at"],
        )


# ---------------------------------------------------------------------------
# Row → Pydantic converters
# ---------------------------------------------------------------------------
def _row_to_turn(r: asyncpg.Record) -> ConversationTurn:
    return ConversationTurn(
        turnId=r["turn_id"],
        sessionId=r["session_id"],
        speaker=r["speaker"],
        transcript=r["transcript"],
        audioUri=r["audio_uri"],
        emotionTags=r["emotion_tags"],
        startedAt=r["started_at"],
        endedAt=r["ended_at"],
        metadata=r["metadata"],
    )


def _row_to_checkpoint(r: asyncpg.Record) -> Checkpoint:
    return Checkpoint(
        checkpointId=r["checkpoint_id"],
        sessionId=r["session_id"],
        turnIndex=r["turn_index"],
        summary=r["summary"],
        transcriptSnapshot=[
            ConversationTurn.model_validate(t) for t in r["transcript_snapshot"]
        ],
        stateSnapshot=r["state_snapshot"],
        createdAt=r["created_at"],
    )


def _row_to_key_moment(r: asyncpg.Record) -> KeyMoment:
    return KeyMoment(
        keyMomentId=r["key_moment_id"],
        sessionId=r["session_id"],
        kind=r["kind"],
        label=r["label"],
        summary=r["summary"],
        turnId=r["turn_id"],
        turnIndex=r["turn_index"],
        speaker=r["speaker"],
        createdAt=r["created_at"],
    )


def _row_to_report(r: asyncpg.Record) -> CoachingReport:
    return CoachingReport(
        reportId=r["report_id"],
        sessionId=r["session_id"],
        basedOnTurnRange=r["based_on_turn_range"],
        strengths=r["strengths"],
        weakSignals=r["weak_signals"],
        suggestedNextMove=r["suggested_next_move"],
        retrievedEvidence=r["retrieved_evidence"],
        createdAt=r["created_at"],
    )


def _row_to_chunk(r: asyncpg.Record) -> DocumentChunk:
    return DocumentChunk(
        chunkId=r["chunk_id"],
        sessionId=r["session_id"],
        sourceFileName=r["source_file_name"],
        text=r["text"],
        embedding=r["embedding"] or [],
        metadata=r["metadata"] or {},
    )
