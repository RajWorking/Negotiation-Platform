from __future__ import annotations

import base64
import logging
import re
from pathlib import Path

from .llm_client import LLMClient
from .schemas import DocumentChunk
from .utils import cosine_similarity, ensure_dir, hashed_embedding, make_id, summarize_text, tokenize

logger = logging.getLogger(__name__)


def _chunk_text(text: str, chunk_size: int = 600, overlap: int = 120) -> list[str]:
    """Split text into overlapping chunks for embedding."""
    normalized = re.sub(r"\n{3,}", "\n\n", text.replace("\r", "")).strip()
    if not normalized:
        return []
    chunks: list[str] = []
    pos = 0
    while pos < len(normalized):
        chunk = normalized[pos : pos + chunk_size].strip()
        if chunk:
            chunks.append(chunk)
        if pos + chunk_size >= len(normalized):
            break
        pos += max(1, chunk_size - overlap)
    return chunks


def _extract_pdf_text(raw: bytes) -> str:
    # TODO(phase2): Replace with pdfplumber/PyMuPDF as part of the RAG sub-system.
    candidate = " ".join(
        match.group(1).decode("latin1", errors="ignore")
        for match in re.finditer(rb"\(([^()]*)\)", raw)
    )
    return candidate.replace("\\n", " ").replace("\\r", " ").replace("\\t", " ").strip()


def _parse_file(file_path: Path) -> str:
    raw = file_path.read_bytes()
    if file_path.suffix.lower() == ".pdf":
        text = _extract_pdf_text(raw)
        if not text:
            logger.warning("PDF parsing returned empty for %s — needs proper PDF library", file_path.name)
            return f"{file_path.name} could not be parsed into rich text."
        return text
    return raw.decode("utf-8", errors="ignore")


class DocumentIngestionService:
    """Handles file uploads, chunking, embedding, and retrieval."""

    def __init__(self, uploads_dir: Path, llm: LLMClient) -> None:
        self.uploads_dir = uploads_dir
        self.llm = llm

    def save_upload(self, session_id: str, file_name: str, encoded: str) -> Path:
        target_dir = self.uploads_dir / session_id
        ensure_dir(target_dir)
        target = target_dir / file_name
        target.write_bytes(base64.b64decode(encoded))
        return target

    async def ingest(self, session_id: str, file_name: str, file_path: Path) -> list[DocumentChunk]:
        text = _parse_file(file_path)
        chunks = _chunk_text(text)[:24]
        if not chunks:
            logger.warning("No chunks produced from %s", file_name)
            return []

        # Try real embeddings via LLM client, fall back to hashed
        embeddings = await self.llm.embed(chunks)
        if embeddings is None:
            logger.warning("Embedding API unavailable — using hashed fallback for %s", file_name)
            embeddings = [hashed_embedding(chunk) for chunk in chunks]

        return [
            DocumentChunk(
                chunkId=make_id("chunk"),
                sessionId=session_id,
                sourceFileName=file_name,
                text=chunk,
                embedding=embeddings[idx],
                metadata={
                    "chunkIndex": idx,
                    "tokenEstimate": len(tokenize(chunk)),
                    "summary": summarize_text(chunk, 120),
                },
            )
            for idx, chunk in enumerate(chunks)
        ]

    def retrieve(self, chunks: list[DocumentChunk], query: str, top_k: int = 3) -> list[dict[str, object]]:
        """Rank chunks by cosine similarity to the query. Sync for now."""
        if not chunks:
            return []
        # Use hashed embedding for query since we need sync retrieval and
        # the chunks may use hashed embeddings too. When both are real
        # embeddings from the same model, cosine similarity still works.
        query_embedding = hashed_embedding(query)

        # If chunks have real embeddings (different dim), fall back gracefully
        if chunks[0].embedding and len(chunks[0].embedding) != len(query_embedding):
            query_embedding = hashed_embedding(query, dims=len(chunks[0].embedding))

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
