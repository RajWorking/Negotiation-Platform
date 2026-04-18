from __future__ import annotations

import json
import logging
import os
from typing import Optional

import litellm

logger = logging.getLogger(__name__)

# Suppress litellm's own verbose logging — we handle warnings ourselves.
litellm.suppress_debug_info = True
litellm.set_verbose = False


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

    @property
    def is_available(self) -> bool:
        """True if at least one LLM API key is configured."""
        return any(os.getenv(var) for var in _LLM_KEY_ENV_VARS)

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
        """Generate embeddings for a batch of texts. Returns None on failure."""
        if not self.is_available or not self.embedding_model:
            return None
        if not texts:
            return []

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

        start = raw_text.find("{")
        end = raw_text.rfind("}")
        if start == -1 or end == -1 or end <= start:
            return None
        try:
            return json.loads(raw_text[start : end + 1])
        except json.JSONDecodeError:
            return None
