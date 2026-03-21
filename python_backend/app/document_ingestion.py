from __future__ import annotations

import base64
import re
from pathlib import Path

from .schemas import DocumentChunk
from .utils import cosine_similarity, ensure_dir, hashed_embedding, make_id, summarize_text, tokenize


def _chunk_text(text: str, chunk_size: int = 600, overlap: int = 120) -> list[str]:
    normalized = re.sub(r"\n{3,}", "\n\n", text.replace("\r", "")).strip()
    if not normalized:
        return []
    chunks: list[str] = []
    index = 0
    while index < len(normalized):
        chunk = normalized[index : index + chunk_size].strip()
        if chunk:
            chunks.append(chunk)
        if index + chunk_size >= len(normalized):
            break
        index += max(1, chunk_size - overlap)
    return chunks


def _extract_pdf_text(raw: bytes) -> str:
    candidate = " ".join(match.group(1).decode("latin1", errors="ignore") for match in re.finditer(rb"\(([^()]*)\)", raw))
    return candidate.replace("\\n", " ").replace("\\r", " ").replace("\\t", " ").strip()


def _parse_file(file_path: Path) -> str:
    raw = file_path.read_bytes()
    if file_path.suffix.lower() == ".pdf":
        return _extract_pdf_text(raw) or f"{file_path.name} could not be parsed into rich text."
    return raw.decode("utf-8", errors="ignore")


class DocumentIngestionService:
    def __init__(self, uploads_dir: Path) -> None:
        self.uploads_dir = uploads_dir

    def save_upload(self, session_id: str, file_name: str, encoded: str) -> Path:
        target_dir = self.uploads_dir / session_id
        ensure_dir(target_dir)
        target = target_dir / file_name
        target.write_bytes(base64.b64decode(encoded))
        return target

    def ingest(self, session_id: str, file_name: str, file_path: Path) -> list[DocumentChunk]:
        text = _parse_file(file_path)
        chunks = _chunk_text(text)[:24]
        return [
            DocumentChunk(
                chunkId=make_id("chunk"),
                sessionId=session_id,
                sourceFileName=file_name,
                text=chunk,
                embedding=hashed_embedding(chunk),
                metadata={
                    "chunkIndex": index,
                    "tokenEstimate": len(tokenize(chunk)),
                    "summary": summarize_text(chunk, 120),
                },
            )
            for index, chunk in enumerate(chunks)
        ]

    def retrieve(self, chunks: list[DocumentChunk], query: str, top_k: int = 3) -> list[dict[str, object]]:
        query_embedding = hashed_embedding(query)
        ranked = [
            {
                "source": chunk.source_file_name,
                "snippet": summarize_text(chunk.text, 220),
                "score": cosine_similarity(query_embedding, chunk.embedding),
            }
            for chunk in chunks
        ]
        ranked.sort(key=lambda item: item["score"], reverse=True)
        return ranked[:top_k]
