from __future__ import annotations

import asyncio
import json
import logging
from collections import defaultdict
from typing import Optional

from fastapi import WebSocket

logger = logging.getLogger(__name__)


class ConnectionManager:
    """WebSocket connection manager with optional Redis pub/sub.

    When redis_url is provided, broadcasts are published to Redis so that
    all server instances can forward messages to their local WebSocket
    connections. Without Redis, falls back to in-process broadcasting
    (single-instance mode).
    """

    def __init__(self, redis_url: Optional[str] = None) -> None:
        self.local_connections: dict[str, set[WebSocket]] = defaultdict(set)
        self.redis_url = redis_url
        self._redis = None
        self._subscriber_tasks: dict[str, asyncio.Task] = {}

    async def init(self) -> None:
        if not self.redis_url:
            logger.info("Redis not configured — using local-only WebSocket broadcasting")
            return
        try:
            import redis.asyncio as aioredis
            self._redis = aioredis.from_url(self.redis_url, decode_responses=True)
            await self._redis.ping()
            logger.info("Redis connected for WebSocket pub/sub")
        except Exception as exc:
            logger.warning("Redis connection failed (%s) — falling back to local broadcasting", exc)
            self._redis = None

    async def connect(self, session_id: str, ws: WebSocket) -> None:
        await ws.accept()
        self.local_connections[session_id].add(ws)
        # Start a subscriber task for this session if Redis is active
        if self._redis and session_id not in self._subscriber_tasks:
            self._subscriber_tasks[session_id] = asyncio.create_task(
                self._subscribe_loop(session_id)
            )

    def disconnect(self, session_id: str, ws: WebSocket) -> None:
        self.local_connections[session_id].discard(ws)
        if not self.local_connections[session_id]:
            self.local_connections.pop(session_id, None)
            task = self._subscriber_tasks.pop(session_id, None)
            if task:
                task.cancel()

    async def broadcast(self, session_id: str, payload: dict[str, object]) -> None:
        """Broadcast a message to all connections for a session."""
        if self._redis:
            # Publish via Redis — the subscriber loop will forward to local sockets
            await self._redis.publish(
                f"session:{session_id}",
                json.dumps(payload, default=str),
            )
        else:
            await self._send_to_local(session_id, payload)

    async def _send_to_local(self, session_id: str, payload: dict[str, object]) -> None:
        """Send a message to all locally-connected WebSockets for a session."""
        dead: list[WebSocket] = []
        for ws in list(self.local_connections.get(session_id, set())):
            try:
                await ws.send_json(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.local_connections[session_id].discard(ws)

    async def _subscribe_loop(self, session_id: str) -> None:
        """Listen for Redis messages and forward to local WebSocket connections."""
        if not self._redis:
            return
        import redis.asyncio as aioredis
        pubsub = self._redis.pubsub()
        channel = f"session:{session_id}"
        try:
            await pubsub.subscribe(channel)
            async for message in pubsub.listen():
                if message["type"] == "message":
                    payload = json.loads(message["data"])
                    await self._send_to_local(session_id, payload)
        except asyncio.CancelledError:
            await pubsub.unsubscribe(channel)
        except Exception as exc:
            logger.warning("Redis subscriber error for %s: %s", session_id, exc)

    async def close(self) -> None:
        for task in self._subscriber_tasks.values():
            task.cancel()
        self._subscriber_tasks.clear()
        if self._redis:
            await self._redis.close()
