from __future__ import annotations

import asyncio
import base64
import logging

from fastapi import Depends, FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

from .auth import create_auth_dependency
from .config import settings
from .document_ingestion import DocumentIngestionService
from .llm_client import LLMClient
from .orchestrator import SessionOrchestrator
from .redis_manager import ConnectionManager
from .schemas import (
    CoachRequest,
    CreateSessionRequest,
    DocumentUploadRequest,
    RewindRequest,
    SessionState,
)

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# App + middleware
# ---------------------------------------------------------------------------
app = FastAPI(title="Negotiation Platform")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Rate limiting
limiter = Limiter(key_func=get_remote_address, default_limits=[settings.rate_limit])
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# Auth dependency
require_auth = create_auth_dependency(settings.api_key)

# ---------------------------------------------------------------------------
# Services (initialized on startup)
# ---------------------------------------------------------------------------
llm = LLMClient(embedding_model=settings.embedding_model)
manager = ConnectionManager(redis_url=settings.redis_url)
orchestrator: SessionOrchestrator  # set in startup
stt_service = None  # set in startup
tts_service = None  # set in startup




@app.on_event("startup")
async def _startup() -> None:
    global orchestrator, stt_service, tts_service

    # Database
    if settings.database_url:
        from .database import init_db
        from .storage import PostgresSessionStore
        pool = await init_db(settings.database_url)
        store = PostgresSessionStore(pool)
    else:
        from .storage import FileSessionStore
        logger.warning("DATABASE_URL not set — using file storage (not recommended for production)")
        store = FileSessionStore(settings.base_dir)
        await store.init()

    # Redis
    await manager.init()

    # STT service
    if settings.stt_enabled:
        from .stt_service import STTService
        stt_service = STTService(
            model_size=settings.stt_model_size,
            device=settings.stt_device,
            compute_type=settings.stt_compute_type,
        )
        logger.info("STT service initialized (model=%s, device=%s)", settings.stt_model_size, settings.stt_device)
    else:
        logger.info("STT disabled — clients will use browser SpeechRecognition")

    # TTS service
    if settings.tts_enabled:
        from .tts_service import TTSService
        tts_service = TTSService(device=settings.tts_device)
        logger.info("TTS service initialized (device=%s)", settings.tts_device)
    else:
        logger.info("TTS disabled — clients will use browser SpeechSynthesis")

    # Orchestrator
    orchestrator = SessionOrchestrator(
        store=store,
        document_service=DocumentIngestionService(settings.base_dir / "uploads", llm),
        audio_dir=settings.base_dir / "audio",
        llm=llm,
        stt_service=stt_service,
        tts_service=tts_service,
    )

    # LLM status
    if llm.is_available:
        logger.info("LLM API keys detected — model-backed responses enabled")
        logger.info("  fast:     %s", settings.llm_model_fast)
        logger.info("  balanced: %s", settings.llm_model_balanced)
        logger.info("  quality:  %s", settings.llm_model_quality)
    else:
        logger.warning("No LLM API keys found — all responses will use heuristic fallbacks")


@app.on_event("shutdown")
async def _shutdown() -> None:
    await manager.close()
    if settings.database_url:
        from .database import close_db
        await close_db()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _sanitize_session(session: SessionState) -> dict[str, object]:
    """Strip heavy snapshot data before sending state to client."""
    payload = session.model_dump(mode="json", by_alias=True)
    payload["checkpoints"] = [
        {k: cp[k] for k in ("checkpointId", "turnIndex", "summary", "createdAt")}
        for cp in payload["checkpoints"]
    ]
    payload["keyMoments"] = [
        {k: m[k] for k in ("keyMomentId", "kind", "label", "summary", "turnId", "turnIndex", "speaker", "createdAt")}
        for m in payload["keyMoments"]
    ]
    return payload


def _serialize_checkpoint(cp: object) -> dict[str, object]:
    if hasattr(cp, "checkpoint_id"):
        return {
            "checkpointId": cp.checkpoint_id, "turnIndex": cp.turn_index,
            "summary": cp.summary, "createdAt": cp.created_at,
        }
    return cp  # type: ignore[return-value]


def _serialize_key_moment(m: object) -> dict[str, object]:
    if hasattr(m, "key_moment_id"):
        return {
            "keyMomentId": m.key_moment_id, "kind": m.kind, "label": m.label,
            "summary": m.summary, "turnId": m.turn_id, "turnIndex": m.turn_index,
            "speaker": m.speaker, "createdAt": m.created_at,
        }
    return m  # type: ignore[return-value]


# ---------------------------------------------------------------------------
# REST endpoints
# ---------------------------------------------------------------------------
@app.post("/sessions")
@limiter.limit(settings.rate_limit)
async def create_session(request: Request, body: CreateSessionRequest, _=Depends(require_auth)) -> dict[str, object]:
    session = await orchestrator.create_session(body)
    return {"session_id": session.session_id, "status": session.status}


@app.post("/sessions/{session_id}/documents")
async def upload_documents(session_id: str, body: DocumentUploadRequest, _=Depends(require_auth)) -> dict[str, object]:
    return await orchestrator.upload_documents(session_id, body.files)


@app.post("/sessions/{session_id}/start")
async def start_session(session_id: str, _=Depends(require_auth)) -> dict[str, object]:
    session = await orchestrator.start(session_id)
    return {"status": session.status}


@app.post("/sessions/{session_id}/pause")
async def pause_session(session_id: str, _=Depends(require_auth)) -> dict[str, object]:
    session = await orchestrator.pause(session_id)
    await manager.broadcast(session_id, {"type": "session.paused", "session_id": session_id})
    return {"status": session.status}


@app.post("/sessions/{session_id}/resume")
async def resume_session(session_id: str, _=Depends(require_auth)) -> dict[str, object]:
    session = await orchestrator.resume(session_id)
    await manager.broadcast(session_id, {"type": "session.resumed", "session_id": session_id})
    return {"status": session.status}


@app.post("/sessions/{session_id}/coach")
async def coach_session(session_id: str, body: CoachRequest, _=Depends(require_auth)) -> dict[str, object]:
    report = await orchestrator.coach(session_id, body.window_turns)
    return {
        "report_id": report.report_id,
        "strengths": report.strengths,
        "weak_signals": report.weak_signals,
        "suggested_next_move": report.suggested_next_move,
        "retrieved_evidence": report.retrieved_evidence,
    }


@app.post("/sessions/{session_id}/rewind")
async def rewind_session(session_id: str, body: RewindRequest, _=Depends(require_auth)) -> dict[str, object]:
    result = await orchestrator.rewind(session_id, body.checkpoint_id)
    await manager.broadcast(
        session_id,
        {
            "type": "session.rewound", "session_id": session_id,
            "turn_index": result["turn_index"],
            "state": _sanitize_session(result["session"]),
        },
    )
    return {"status": result["status"], "turn_index": result["turn_index"]}


@app.post("/sessions/{session_id}/end")
async def end_session(session_id: str, _=Depends(require_auth)) -> dict[str, object]:
    session = await orchestrator.end(session_id)
    return {"status": session.status}


@app.get("/sessions/{session_id}/state")
async def get_state(session_id: str, _=Depends(require_auth)) -> dict[str, object]:
    return _sanitize_session(await orchestrator.state(session_id))


@app.get("/sessions/{session_id}/checkpoints")
async def get_checkpoints(session_id: str, _=Depends(require_auth)) -> list[dict[str, object]]:
    return [_serialize_checkpoint(cp) for cp in await orchestrator.checkpoints(session_id)]


# ---------------------------------------------------------------------------
# WebSocket — real-time session stream
# ---------------------------------------------------------------------------
def _stt_available() -> bool:
    return stt_service is not None and stt_service.available


def _tts_available() -> bool:
    return tts_service is not None and tts_service.available


async def _progress_cb(session_id: str, phase: str) -> None:
    await manager.broadcast(session_id, {
        "type": "agent.status", "session_id": session_id, "phase": phase,
    })


async def _broadcast_agent_result(session_id: str, result: dict[str, object]) -> None:
    """Broadcast agent response, TTS audio, and checkpoint."""
    user_turn = result["user_turn"]
    agent_turn = result["agent_turn"]
    checkpoint = result["checkpoint"]

    if not (user_turn and agent_turn and checkpoint):
        return

    await manager.broadcast(
        session_id,
        {"type": "user.transcript.final", "session_id": session_id,
         "turn": user_turn.model_dump(mode="json", by_alias=True)},
    )

    agent_payload = agent_turn.model_dump(mode="json", by_alias=True)
    agent_payload["source"] = result.get("agent_source", "unknown")
    await manager.broadcast(
        session_id,
        {"type": "agent.response.text", "session_id": session_id, "turn": agent_payload},
    )

    # Stream TTS audio if available
    if _tts_available():
        await _progress_cb(session_id, "synthesizing_speech")
        seq = 0
        async for audio_chunk in orchestrator.synthesize_agent_speech(session_id, agent_turn.transcript):
            await manager.broadcast(
                session_id,
                {
                    "type": "agent.response.audio.chunk", "session_id": session_id,
                    "base64": base64.b64encode(audio_chunk).decode(),
                    "format": "pcm_s16le", "sample_rate": 24000, "sequence": seq,
                },
            )
            seq += 1

    await manager.broadcast(
        session_id,
        {"type": "agent.response.audio.end", "session_id": session_id},
    )
    await manager.broadcast(
        session_id,
        {"type": "session.checkpoint.created", "session_id": session_id,
         "checkpoint": _serialize_checkpoint(checkpoint)},
    )
    for moment in result["key_moments_created"]:
        await manager.broadcast(
            session_id,
            {"type": "session.key_moment.created", "session_id": session_id,
             "key_moment": _serialize_key_moment(moment)},
        )


async def _run_and_broadcast_analysis(session_id: str) -> None:
    """Run semantic analysis in background and broadcast results."""
    try:
        analysis_result = await orchestrator.run_background_analysis(session_id)
        for moment in analysis_result.get("key_moments_created", []):
            await manager.broadcast(
                session_id,
                {"type": "session.key_moment.created", "session_id": session_id,
                 "key_moment": _serialize_key_moment(moment)},
            )
    except Exception:
        logger.exception("Background analysis failed for session %s", session_id)


@app.websocket("/sessions/{session_id}/stream")
async def stream_session(websocket: WebSocket, session_id: str) -> None:
    await manager.connect(session_id, websocket)
    try:
        initial_state = _sanitize_session(await orchestrator.state(session_id))
        await manager.broadcast(
            session_id,
            {
                "type": "session.ready", "session_id": session_id,
                "state": initial_state,
                "capabilities": {"stt": _stt_available(), "tts": _tts_available()},
            },
        )

        while True:
            event = await websocket.receive_json()
            event_type = event.get("type")

            if event_type == "user.audio.chunk":
                result = await orchestrator.ingest_audio_chunk_with_stt(
                    session_id, event.get("base64"), audio_format=event.get("format"),
                )
                await manager.broadcast(
                    session_id,
                    {
                        "type": "user.audio.received", "session_id": session_id,
                        "live_state": result["live_state"].model_dump(mode="json", by_alias=True),
                    },
                )

                # If STT produced a transcription, broadcast it
                transcription = result.get("transcription")
                if transcription and transcription.text:
                    if transcription.is_final:
                        # Final transcript — trigger full agent response flow
                        await manager.broadcast(
                            session_id,
                            {"type": "stt.transcript.final", "session_id": session_id, "text": transcription.text},
                        )
                        orchestrator.reset_stt_session(session_id)
                        await manager.broadcast(session_id, {"type": "agent.thinking", "session_id": session_id})
                        finalize_result = await orchestrator.finalize_user_transcript(
                            session_id, transcription.text,
                            on_progress=lambda phase: _progress_cb(session_id, phase),
                        )
                        await _broadcast_agent_result(session_id, finalize_result)
                        asyncio.create_task(_run_and_broadcast_analysis(session_id))
                    else:
                        # Partial transcript
                        await orchestrator.set_partial_transcript(session_id, transcription.text)
                        await manager.broadcast(
                            session_id,
                            {"type": "stt.transcript.partial", "session_id": session_id, "text": transcription.text},
                        )

            elif event_type == "user.transcript.partial":
                text = str(event.get("text", ""))
                await orchestrator.set_partial_transcript(session_id, text)
                await manager.broadcast(
                    session_id,
                    {"type": "user.transcript.partial", "session_id": session_id, "text": text},
                )

            elif event_type == "user.transcript.final":
                # Browser STT fallback path — client sends final transcript directly
                orchestrator.reset_stt_session(session_id)
                await manager.broadcast(session_id, {"type": "agent.thinking", "session_id": session_id})
                result = await orchestrator.finalize_user_transcript(
                    session_id, str(event.get("text", "")),
                    on_progress=lambda phase: _progress_cb(session_id, phase),
                )
                await _broadcast_agent_result(session_id, result)
                asyncio.create_task(_run_and_broadcast_analysis(session_id))

            elif event_type == "user.audio.finalize":
                # Client requests forced finalization of buffered STT audio
                transcription = await orchestrator.finalize_stt_audio(session_id)
                if transcription and transcription.text:
                    await manager.broadcast(
                        session_id,
                        {"type": "stt.transcript.final", "session_id": session_id, "text": transcription.text},
                    )
                    await manager.broadcast(session_id, {"type": "agent.thinking", "session_id": session_id})
                    finalize_result = await orchestrator.finalize_user_transcript(
                        session_id, transcription.text,
                        on_progress=lambda phase: _progress_cb(session_id, phase),
                    )
                    await _broadcast_agent_result(session_id, finalize_result)
                    asyncio.create_task(_run_and_broadcast_analysis(session_id))

            else:
                await manager.broadcast(
                    session_id,
                    {"type": "error", "session_id": session_id, "message": f"Unsupported event: {event_type}"},
                )

    except WebSocketDisconnect:
        pass
    except Exception as exc:
        logger.exception("WebSocket error for session %s", session_id)
        try:
            await manager.broadcast(
                session_id,
                {"type": "error", "session_id": session_id, "message": f"Live session error: {exc}"},
            )
        except Exception:
            pass
    finally:
        orchestrator.reset_stt_session(session_id)
        manager.disconnect(session_id, websocket)


@app.get("/voices")
async def list_voices() -> list[dict[str, str]]:
    from .voice_map import SELECTABLE_VOICES
    return SELECTABLE_VOICES


@app.get("/health")
async def health() -> dict[str, str]:
    return {
        "status": "ok",
        "llm": "available" if llm.is_available else "heuristic_only",
        "stt": "available" if _stt_available() else "disabled",
        "tts": "available" if _tts_available() else "disabled",
        "storage": "postgres" if settings.database_url else "file",
        "redis": "connected" if manager._redis else "local_only",
    }
