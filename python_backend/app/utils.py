from __future__ import annotations

import hashlib
import json
import math
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def make_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def read_json(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text("utf-8"))
    except FileNotFoundError:
        return fallback


def write_json(path: Path, value: Any) -> None:
    ensure_dir(path.parent)
    path.write_text(json.dumps(value, indent=2), "utf-8")


def summarize_text(text: str, max_len: int = 96) -> str:
    normalized = re.sub(r"\s+", " ", text).strip()
    if len(normalized) <= max_len:
        return normalized
    return f"{normalized[: max_len - 1].rstrip()}..."


def tokenize(text: str) -> list[str]:
    return [token for token in re.sub(r"[^a-zA-Z0-9\s.$%-]", " ", text.lower()).split() if token]


def hashed_embedding(text: str, dims: int = 64) -> list[float]:
    vector = [0.0] * dims
    for token in tokenize(text):
        index = hashlib.sha256(token.encode("utf-8")).digest()[0] % dims
        vector[index] += 1.0
    norm = math.sqrt(sum(value * value for value in vector)) or 1.0
    return [value / norm for value in vector]


def cosine_similarity(left: list[float], right: list[float]) -> float:
    return sum(l * r for l, r in zip(left, right))
