from __future__ import annotations

import json
import logging
import os
import re
from typing import Optional

import litellm

logger = logging.getLogger(__name__)

# Suppress litellm's own verbose logging — we handle warnings ourselves.
litellm.suppress_debug_info = True
litellm.set_verbose = False
litellm.drop_params = True


_LLM_KEY_ENV_VARS = [
    "HUGGINGFACE_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "AZURE_API_KEY",
    "COHERE_API_KEY",
    "REPLICATE_API_KEY",
]


class LLMClient:
    """Unified LLM client backed by LiteLLM.

    Supports any provider LiteLLM supports (HuggingFace, OpenAI, Anthropic,
    etc.) just by changing the model string in config. API keys are read
    from standard env vars automatically.
    """

    def __init__(self, embedding_model: str = "") -> None:
        self.embedding_model = embedding_model
        self._local_embedder = None  # lazy-loaded sentence-transformers model

    @property
    def is_available(self) -> bool:
        """True if at least one LLM API key is configured."""
        return any(os.getenv(var) for var in _LLM_KEY_ENV_VARS)

    @property
    def _is_local_embedding(self) -> bool:
        return self.embedding_model.startswith("local/")

    def _ensure_local_embedder(self):
        if self._local_embedder is None:
            from sentence_transformers import SentenceTransformer
            model_name = self.embedding_model[len("local/"):]
            logger.info("Loading local embedding model: %s", model_name)
            self._local_embedder = SentenceTransformer(model_name)
        return self._local_embedder

    async def chat_completion(
        self,
        *,
        model: str,
        messages: list[dict[str, str]],
        temperature: float = 0.4,
        max_tokens: int = 350,
    ) -> Optional[str]:
        if not self.is_available:
            logger.warning("No LLM API key configured — skipping call, using heuristic fallback")
            return None

        try:
            response = await litellm.acompletion(
                model=model,
                messages=messages,
                temperature=temperature,
                max_tokens=max_tokens,
                timeout=45.0,
            )
            return response.choices[0].message.content
        except litellm.AuthenticationError:
            logger.warning("LLM authentication failed for model=%s — check your API key", model)
            return None
        except litellm.RateLimitError:
            logger.warning("LLM rate limit hit for model=%s", model)
            return None
        except litellm.Timeout:
            logger.warning("LLM request timed out for model=%s", model)
            return None
        except Exception as exc:
            logger.warning("LLM request failed for model=%s: %s", model, exc)
            return None

    async def embed(self, texts: list[str]) -> Optional[list[list[float]]]:
        """Generate embeddings for a batch of texts. Returns None on failure.

        When `embedding_model` starts with `local/`, uses sentence-transformers
        in-process (no API call, no key required). Otherwise routes through LiteLLM.
        """
        if not self.embedding_model:
            return None
        if not texts:
            return []

        if self._is_local_embedding:
            try:
                import asyncio
                model = self._ensure_local_embedder()
                vectors = await asyncio.to_thread(
                    model.encode, texts, convert_to_numpy=True, show_progress_bar=False
                )
                return [v.tolist() for v in vectors]
            except Exception as exc:
                logger.warning("Local embedding failed (model=%s): %s", self.embedding_model, exc)
                return None

        if not self.is_available:
            return None

        try:
            response = await litellm.aembedding(
                model=self.embedding_model,
                input=texts,
                timeout=30.0,
            )
            return [item["embedding"] for item in response.data]
        except Exception as exc:
            logger.warning("Embedding request failed (model=%s): %s", self.embedding_model, exc)
            return None

    @staticmethod
    def parse_json_object(raw_text: str) -> Optional[dict[str, object]]:
        """Extract a JSON object from model output, tolerating surrounding text."""
        try:
            return json.loads(raw_text)
        except json.JSONDecodeError:
            pass

        stripped = re.sub(r"```(?:json)?\s*", "", raw_text).strip().rstrip("`")

        try:
            return json.loads(stripped)
        except json.JSONDecodeError:
            pass

        start = stripped.find("{")
        end = stripped.rfind("}")
        if start == -1 or end == -1 or end <= start:
            return None
        try:
            return json.loads(stripped[start : end + 1])
        except json.JSONDecodeError:
            return None
