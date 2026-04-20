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
    try:
        from io import BytesIO
        from pypdf import PdfReader

        reader = PdfReader(BytesIO(raw))
        return "\n\n".join((page.extract_text() or "") for page in reader.pages).strip()
    except Exception as exc:
        logger.warning("pypdf extraction failed: %s", exc)
        return ""


def _extract_docx_text(raw: bytes) -> str:
    try:
        from io import BytesIO
        from docx import Document

        doc = Document(BytesIO(raw))
        return "\n\n".join(p.text for p in doc.paragraphs if p.text.strip()).strip()
    except Exception as exc:
        logger.warning("python-docx extraction failed: %s", exc)
        return ""


def _parse_file(file_path: Path) -> str:
    raw = file_path.read_bytes()
    suffix = file_path.suffix.lower()
    if suffix == ".pdf":
        text = _extract_pdf_text(raw)
    elif suffix in (".docx", ".doc"):
        text = _extract_docx_text(raw)
    else:
        text = raw.decode("utf-8", errors="ignore")
    if not text:
        logger.warning("Parsing returned empty for %s", file_path.name)
        return f"{file_path.name} could not be parsed into rich text."
    return text


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
        """Rank chunks by cosine similarity to the query using hashed embeddings only.

        Sync fallback path. Prefer `retrieve_async` which embeds the query with the
        same real model used for chunks when available.
        """
        if not chunks:
            return []
        chunk_dim = len(chunks[0].embedding) if chunks[0].embedding else 128
        query_embedding = hashed_embedding(query, dims=chunk_dim)
        return _rank(chunks, query_embedding, top_k)

    async def retrieve_async(
        self, chunks: list[DocumentChunk], query: str, top_k: int = 3
    ) -> list[dict[str, object]]:
        """Rank chunks using a real query embedding when chunks were embedded with a real model."""
        if not chunks:
            return []
        chunk_dim = len(chunks[0].embedding) if chunks[0].embedding else 0
        # hashed_embedding default is 128 dims; anything else came from the real embedding API
        is_hashed_chunks = chunk_dim == 128 or chunk_dim == 0

        query_embedding: list[float] | None = None
        if not is_hashed_chunks:
            embeddings = await self.llm.embed([query])
            if embeddings:
                query_embedding = embeddings[0]
        if query_embedding is None:
            query_embedding = hashed_embedding(query, dims=chunk_dim or 128)

        return _rank(chunks, query_embedding, top_k)


def _rank(
    chunks: list[DocumentChunk], query_embedding: list[float], top_k: int
) -> list[dict[str, object]]:
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
