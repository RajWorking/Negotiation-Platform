from __future__ import annotations

from collections import defaultdict
from pathlib import Path
import traceback

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from .config import settings
from .document_ingestion import DocumentIngestionService
from .hf_client import HuggingFaceChatClient
from .orchestrator import SessionOrchestrator
from .schemas import CoachRequest, CreateSessionRequest, DocumentUploadRequest, RewindRequest, SessionState
from .storage import SessionStore

app = FastAPI(title="Negotiation Platform Python Backend")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

store = SessionStore(settings.base_dir)
store.init()
orchestrator = SessionOrchestrator(
    store=store,
    document_service=DocumentIngestionService(settings.base_dir / "uploads"),
    audio_dir=settings.base_dir / "audio",
    hf_client=HuggingFaceChatClient(settings.hf_token),
)


class ConnectionManager:
    def __init__(self) -> None:
        self.connections: dict[str, set[WebSocket]] = defaultdict(set)

    async def connect(self, session_id: str, websocket: WebSocket) -> None:
        await websocket.accept()
        self.connections[session_id].add(websocket)

    def disconnect(self, session_id: str, websocket: WebSocket) -> None:
        self.connections[session_id].discard(websocket)
        if not self.connections[session_id]:
            self.connections.pop(session_id, None)

    async def broadcast(self, session_id: str, payload: dict[str, object]) -> None:
        for websocket in list(self.connections.get(session_id, set())):
            await websocket.send_json(payload)


manager = ConnectionManager()


def sanitize_session(session: SessionState) -> dict[str, object]:
    payload = session.model_dump(mode="json", by_alias=True)
    payload["checkpoints"] = [
        {
            "checkpointId": checkpoint["checkpointId"],
            "turnIndex": checkpoint["turnIndex"],
            "summary": checkpoint["summary"],
            "createdAt": checkpoint["createdAt"],
        }
        for checkpoint in payload["checkpoints"]
    ]
    return payload


@app.post("/sessions")
async def create_session(request: CreateSessionRequest) -> dict[str, object]:
    session = orchestrator.create_session(request)
    return {"session_id": session.session_id, "status": session.status}


@app.post("/sessions/{session_id}/documents")
async def upload_documents(session_id: str, request: DocumentUploadRequest) -> dict[str, object]:
    return orchestrator.upload_documents(session_id, request.files)


@app.post("/sessions/{session_id}/start")
async def start_session(session_id: str) -> dict[str, object]:
    session = orchestrator.start(session_id)
    return {"status": session.status}


@app.post("/sessions/{session_id}/pause")
async def pause_session(session_id: str) -> dict[str, object]:
    session = orchestrator.pause(session_id)
    await manager.broadcast(session_id, {"type": "session.paused", "session_id": session_id})
    return {"status": session.status}


@app.post("/sessions/{session_id}/resume")
async def resume_session(session_id: str) -> dict[str, object]:
    session = orchestrator.resume(session_id)
    await manager.broadcast(session_id, {"type": "session.resumed", "session_id": session_id})
    return {"status": session.status}


@app.post("/sessions/{session_id}/coach")
async def coach_session(session_id: str, request: CoachRequest) -> dict[str, object]:
    report = await orchestrator.coach(session_id, request.window_turns)
    return {
        "report_id": report.report_id,
        "strengths": report.strengths,
        "weak_signals": report.weak_signals,
        "suggested_next_move": report.suggested_next_move,
        "retrieved_evidence": report.retrieved_evidence,
    }


@app.post("/sessions/{session_id}/rewind")
async def rewind_session(session_id: str, request: RewindRequest) -> dict[str, object]:
    result = orchestrator.rewind(session_id, request.checkpoint_id)
    await manager.broadcast(
        session_id,
        {"type": "session.rewound", "session_id": session_id, "turn_index": result["turn_index"], "state": sanitize_session(result["session"])},
    )
    return {"status": result["status"], "turn_index": result["turn_index"]}


@app.post("/sessions/{session_id}/end")
async def end_session(session_id: str) -> dict[str, object]:
    session = orchestrator.end(session_id)
    return {"status": session.status}


@app.get("/sessions/{session_id}/state")
async def get_state(session_id: str) -> dict[str, object]:
    return sanitize_session(orchestrator.state(session_id))


@app.get("/sessions/{session_id}/checkpoints")
async def get_checkpoints(session_id: str) -> list[dict[str, object]]:
    return [
        {
            "checkpoint_id": checkpoint.checkpoint_id,
            "turn_index": checkpoint.turn_index,
            "summary": checkpoint.summary,
            "created_at": checkpoint.created_at,
        }
        for checkpoint in orchestrator.checkpoints(session_id)
    ]


@app.websocket("/sessions/{session_id}/stream")
async def stream_session(websocket: WebSocket, session_id: str) -> None:
    await manager.connect(session_id, websocket)
    try:
        await manager.broadcast(session_id, {"type": "session.ready", "session_id": session_id, "state": sanitize_session(orchestrator.state(session_id))})
        while True:
            event = await websocket.receive_json()
            event_type = event.get("type")
            if event_type == "user.audio.chunk":
                live_state = orchestrator.ingest_audio_chunk(session_id, event.get("base64"))
                await manager.broadcast(session_id, {"type": "user.audio.received", "session_id": session_id, "live_state": live_state.model_dump(mode="json", by_alias=True)})
            elif event_type == "user.transcript.partial":
                orchestrator.set_partial_transcript(session_id, str(event.get("text", "")))
                await manager.broadcast(session_id, {"type": "user.transcript.partial", "session_id": session_id, "text": str(event.get("text", "")), "timestamp_ms": 0})
            elif event_type == "user.transcript.final":
                await manager.broadcast(session_id, {"type": "agent.thinking", "session_id": session_id})
                result = await orchestrator.finalize_user_transcript(session_id, str(event.get("text", "")))
                if result["user_turn"] and result["agent_turn"] and result["checkpoint"]:
                    await manager.broadcast(session_id, {"type": "user.transcript.final", "session_id": session_id, "turn": result["user_turn"].model_dump(mode="json", by_alias=True)})
                    await manager.broadcast(session_id, {"type": "agent.response.text", "session_id": session_id, "turn": result["agent_turn"].model_dump(mode="json", by_alias=True)})
                    await manager.broadcast(session_id, {"type": "agent.response.audio.end", "session_id": session_id})
                    checkpoint = result["checkpoint"]
                    await manager.broadcast(
                        session_id,
                        {
                            "type": "session.checkpoint.created",
                            "session_id": session_id,
                            "checkpoint": {
                                "checkpointId": checkpoint.checkpoint_id,
                                "turnIndex": checkpoint.turn_index,
                                "summary": checkpoint.summary,
                                "createdAt": checkpoint.created_at,
                            },
                        },
                    )
            else:
                await manager.broadcast(session_id, {"type": "error", "session_id": session_id, "message": f"Unsupported event type: {event_type}"})
    except (WebSocketDisconnect, ValueError) as exc:
        if isinstance(exc, ValueError):
            await manager.broadcast(session_id, {"type": "error", "session_id": session_id, "message": str(exc)})
    except Exception as exc:
        traceback.print_exc()
        await manager.broadcast(session_id, {"type": "error", "session_id": session_id, "message": f"Live session error: {exc}"})
    finally:
        manager.disconnect(session_id, websocket)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
