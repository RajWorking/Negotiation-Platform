from __future__ import annotations

import json
import logging
from typing import Optional

import asyncpg

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Schema — applied on first connection
# ---------------------------------------------------------------------------
SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS sessions (
    session_id   TEXT PRIMARY KEY,
    status       TEXT NOT NULL DEFAULT 'created',
    config       JSONB NOT NULL,
    features     JSONB NOT NULL DEFAULT '{}',
    semantic_analysis JSONB NOT NULL DEFAULT '{}',
    live_state   JSONB NOT NULL,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS turns (
    turn_id      TEXT PRIMARY KEY,
    session_id   TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    speaker      TEXT NOT NULL,
    transcript   TEXT NOT NULL,
    audio_uri    TEXT,
    emotion_tags JSONB,
    started_at   TEXT NOT NULL,
    ended_at     TEXT,
    metadata     JSONB,
    is_archived  BOOLEAN NOT NULL DEFAULT FALSE,
    position     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS checkpoints (
    checkpoint_id       TEXT PRIMARY KEY,
    session_id          TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    turn_index          INTEGER NOT NULL,
    summary             TEXT NOT NULL,
    transcript_snapshot JSONB NOT NULL,
    state_snapshot      JSONB NOT NULL,
    created_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS key_moments (
    key_moment_id TEXT PRIMARY KEY,
    session_id    TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    kind          TEXT NOT NULL,
    label         TEXT NOT NULL,
    summary       TEXT NOT NULL,
    turn_id       TEXT NOT NULL,
    turn_index    INTEGER NOT NULL,
    speaker       TEXT NOT NULL,
    created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS coaching_reports (
    report_id          TEXT PRIMARY KEY,
    session_id         TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    based_on_turn_range JSONB NOT NULL,
    strengths          JSONB NOT NULL,
    weak_signals       JSONB NOT NULL,
    suggested_next_move TEXT NOT NULL,
    retrieved_evidence JSONB NOT NULL,
    created_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS document_chunks (
    chunk_id         TEXT PRIMARY KEY,
    session_id       TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    source_file_name TEXT NOT NULL,
    text             TEXT NOT NULL,
    embedding        JSONB,
    metadata         JSONB
);

CREATE INDEX IF NOT EXISTS idx_turns_session_pos ON turns(session_id, position);
CREATE INDEX IF NOT EXISTS idx_turns_session_arch ON turns(session_id, is_archived);
CREATE INDEX IF NOT EXISTS idx_checkpoints_session ON checkpoints(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_key_moments_session ON key_moments(session_id, turn_index);
CREATE INDEX IF NOT EXISTS idx_reports_session ON coaching_reports(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chunks_session ON document_chunks(session_id);
"""

# ---------------------------------------------------------------------------
# Pool management
# ---------------------------------------------------------------------------
_pool: Optional[asyncpg.Pool] = None


async def _init_connection(conn: asyncpg.Connection) -> None:
    """Set JSONB codec so asyncpg auto-serializes dicts <-> JSONB."""
    await conn.set_type_codec(
        "jsonb",
        encoder=json.dumps,
        decoder=json.loads,
        schema="pg_catalog",
    )


async def init_db(database_url: str) -> asyncpg.Pool:
    """Create the connection pool and apply schema."""
    global _pool
    _pool = await asyncpg.create_pool(
        database_url,
        min_size=2,
        max_size=10,
        init=_init_connection,
    )
    async with _pool.acquire() as conn:
        await conn.execute(SCHEMA_SQL)
    logger.info("PostgreSQL connected and schema applied")
    return _pool


async def get_pool() -> asyncpg.Pool:
    if _pool is None:
        raise RuntimeError("Database not initialized — call init_db() first")
    return _pool


async def close_db() -> None:
    global _pool
    if _pool:
        await _pool.close()
        _pool = None
        logger.info("PostgreSQL connection pool closed")
