from __future__ import annotations

from pathlib import Path
from typing import Optional

from .schemas import SessionState
from .utils import ensure_dir, read_json, write_json


class SessionStore:
    def __init__(self, base_dir: Path) -> None:
        self.base_dir = base_dir
        self.sessions_dir = base_dir / "sessions"

    def init(self) -> None:
        ensure_dir(self.sessions_dir)

    def _session_path(self, session_id: str) -> Path:
        return self.sessions_dir / f"{session_id}.json"

    def save(self, session: SessionState) -> SessionState:
        session.updated_at = session.updated_at
        write_json(self._session_path(session.session_id), session.model_dump(mode="json", by_alias=True))
        return session

    def get(self, session_id: str) -> Optional[SessionState]:
        raw = read_json(self._session_path(session_id), None)
        return SessionState.model_validate(raw) if raw else None
