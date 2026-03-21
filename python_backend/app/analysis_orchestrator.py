from __future__ import annotations

from typing import Any

from .hf_client import HuggingFaceChatClient
from .schemas import ConversationTurn, KeyMoment
from .utils import make_id, now_iso, summarize_text


def _transcript_block(turns: list[ConversationTurn], max_turns: int) -> str:
    relevant = turns[-max_turns:]
    return "\n".join(
        f"{index + 1}. turn_id={turn.turn_id} speaker={turn.speaker} text={turn.transcript}"
        for index, turn in enumerate(relevant)
    )


def _normalize_key_moments(session_id: str, turns: list[ConversationTurn], raw: list[dict[str, Any]]) -> list[KeyMoment]:
    turn_by_id = {turn.turn_id: turn for turn in turns}
    turn_index_by_id = {turn.turn_id: index + 1 for index, turn in enumerate(turns)}
    allowed = {
        "first_anchor": "First Anchor",
        "strong_pushback": "Strong Pushback",
        "first_concession": "First Concession",
        "emotional_escalation": "Emotional Escalation",
        "agreement_frame_shift": "Agreement Shift",
    }

    moments: list[KeyMoment] = []
    seen_kinds: set[str] = set()
    for item in raw:
        kind = str(item.get("kind", "")).strip()
        turn_id = str(item.get("turn_id", "")).strip()
        if kind not in allowed or kind in seen_kinds or turn_id not in turn_by_id:
            continue
        turn = turn_by_id[turn_id]
        moments.append(
            KeyMoment(
                keyMomentId=make_id("km"),
                sessionId=session_id,
                kind=kind,
                label=str(item.get("label") or allowed[kind]),
                summary=summarize_text(str(item.get("summary") or turn.transcript), 72),
                turnId=turn_id,
                turnIndex=turn_index_by_id[turn_id],
                speaker=turn.speaker,
                createdAt=now_iso(),
            )
        )
        seen_kinds.add(kind)

    moments.sort(key=lambda moment: moment.turn_index)
    return moments


class SemanticAnalysisOrchestrator:
    def __init__(self, hf_client: HuggingFaceChatClient) -> None:
        self.hf_client = hf_client

    async def analyze(
        self,
        *,
        session_id: str,
        scenario: str,
        partner_tone: str,
        routing: dict[str, object],
        turns: list[ConversationTurn],
        fallback_key_moments: list[KeyMoment],
        heuristic_features: dict[str, Any],
    ) -> dict[str, Any]:
        if not self.hf_client.token or not turns:
            return {
                "signals": [],
                "summary": "",
                "key_moments": fallback_key_moments,
                "source": "heuristic_fallback",
            }

        transcript = _transcript_block(turns, int(routing.get("context_window", 6)) + 6)
        signal_messages = [
            {
                "role": "system",
                "content": (
                    "You are a conversation-analysis agent. Extract negotiation and emotional signals. "
                    "Return JSON only with keys summary and signals. "
                    "Each signal must have: turn_id, signal_type, intensity, evidence, rationale. "
                    "Allowed signal_type values: anchor, pushback, concession, escalation, agreement_shift, confidence, hesitation."
                ),
            },
            {
                "role": "user",
                "content": (
                    f"Scenario: {scenario}\n"
                    f"Partner tone: {partner_tone}\n"
                    f"Heuristic features: {heuristic_features}\n"
                    f"Transcript:\n{transcript}"
                ),
            },
        ]
        signal_response = await self.hf_client.chat_completion(
            model=str(routing["chat_model"]),
            messages=signal_messages,
            temperature=0.1,
            max_tokens=500,
        )
        signal_payload = self.hf_client.parse_json_object(signal_response or "") or {}
        signals = signal_payload.get("signals", []) if isinstance(signal_payload.get("signals"), list) else []
        summary = str(signal_payload.get("summary", "")).strip()

        moment_messages = [
            {
                "role": "system",
                "content": (
                    "You are a key-moment selection agent. Pick the earliest best-supported moment for each kind. "
                    "Return JSON only with key key_moments. "
                    "Each key_moment must have: kind, label, turn_id, summary. "
                    "Allowed kinds: first_anchor, strong_pushback, first_concession, emotional_escalation, agreement_frame_shift."
                ),
            },
            {
                "role": "user",
                "content": (
                    f"Scenario: {scenario}\n"
                    f"Transcript:\n{transcript}\n"
                    f"Signals: {signals}\n"
                    "Choose only moments clearly grounded in the transcript."
                ),
            },
        ]
        moment_response = await self.hf_client.chat_completion(
            model=str(routing["chat_model"]),
            messages=moment_messages,
            temperature=0.1,
            max_tokens=350,
        )
        moment_payload = self.hf_client.parse_json_object(moment_response or "") or {}
        raw_key_moments = moment_payload.get("key_moments", []) if isinstance(moment_payload.get("key_moments"), list) else []
        key_moments = _normalize_key_moments(session_id, turns, raw_key_moments)
        if not key_moments:
            key_moments = fallback_key_moments

        if routing.get("mode") == "quality" and key_moments:
            review_messages = [
                {
                    "role": "system",
                    "content": (
                        "You are a review agent validating semantic moment selection. "
                        "Return JSON only with keys keep_kinds and optional notes. "
                        "keep_kinds must list the moment kinds that are well-supported."
                    ),
                },
                {
                    "role": "user",
                    "content": (
                        f"Transcript:\n{transcript}\n"
                        f"Signals: {signals}\n"
                        f"Proposed key moments: {[moment.model_dump(mode='json', by_alias=False) for moment in key_moments]}"
                    ),
                },
            ]
            review_response = await self.hf_client.chat_completion(
                model=str(routing["chat_model"]),
                messages=review_messages,
                temperature=0.0,
                max_tokens=180,
            )
            review_payload = self.hf_client.parse_json_object(review_response or "") or {}
            keep_kinds = review_payload.get("keep_kinds", [])
            if isinstance(keep_kinds, list):
                filtered = [moment for moment in key_moments if moment.kind in keep_kinds]
                if filtered:
                    key_moments = filtered

        return {
            "signals": signals,
            "summary": summary,
            "key_moments": key_moments,
            "source": "llm_multi_pass" if signal_response or moment_response else "heuristic_fallback",
        }
