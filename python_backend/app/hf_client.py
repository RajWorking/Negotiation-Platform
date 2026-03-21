from __future__ import annotations

import json
import sys
from typing import Optional

import httpx


class HuggingFaceChatClient:
    def __init__(self, token: Optional[str]) -> None:
        self.token = token
        self.base_url = "https://router.huggingface.co/v1/chat/completions"

    async def chat_completion(
        self,
        *,
        model: str,
        messages: list[dict[str, str]],
        temperature: float = 0.4,
        max_tokens: int = 350,
    ) -> Optional[str]:
        if not self.token:
            return None

        headers = {
            "Authorization": f"Bearer {self.token}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }

        async with httpx.AsyncClient(timeout=45.0) as client:
            try:
                response = await client.post(self.base_url, headers=headers, json=payload)
                response.raise_for_status()
                body = response.json()
            except httpx.HTTPStatusError as exc:
                detail = exc.response.text.strip()
                print(
                    f"[hf-router] {exc.response.status_code} for model={model}: {detail}",
                    file=sys.stderr,
                )
                return None
            except httpx.HTTPError as exc:
                print(f"[hf-router] request failed for model={model}: {exc}", file=sys.stderr)
                return None
        return body["choices"][0]["message"]["content"]

    @staticmethod
    def parse_json_object(raw_text: str) -> Optional[dict[str, object]]:
        try:
            return json.loads(raw_text)
        except json.JSONDecodeError:
            start = raw_text.find("{")
            end = raw_text.rfind("}")
            if start == -1 or end == -1 or end <= start:
                return None
            try:
                return json.loads(raw_text[start : end + 1])
            except json.JSONDecodeError:
                return None
