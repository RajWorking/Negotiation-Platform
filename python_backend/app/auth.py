from __future__ import annotations

import logging
from typing import Optional

from fastapi import HTTPException, Security
from fastapi.security import APIKeyHeader

logger = logging.getLogger(__name__)

_api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)


def create_auth_dependency(api_key: Optional[str]):
    """Return a FastAPI dependency that enforces API key auth.

    If api_key is None/empty, auth is disabled (open access).
    """
    if not api_key:
        logger.info("API_KEY not set — auth disabled (open access)")

        async def _no_auth() -> None:
            return None

        return _no_auth

    logger.info("API_KEY configured — X-API-Key header required on all requests")

    async def _verify_key(key: Optional[str] = Security(_api_key_header)) -> str:
        if not key or key != api_key:
            raise HTTPException(status_code=401, detail="Invalid or missing API key")
        return key

    return _verify_key
