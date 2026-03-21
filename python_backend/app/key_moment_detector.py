from __future__ import annotations

import re

from .schemas import ConversationTurn, KeyMoment
from .utils import make_id, now_iso, summarize_text


ANCHOR_PATTERNS = [
    r"\$?\d[\d,]*(?:\.\d+)?",
    r"\b(target|range|salary|rent|offer|proposal|rate)\b",
]
PUSHBACK_PATTERNS = [
    r"\bnot persuaded\b",
    r"\bnot convinced\b",
    r"\bneed a stronger case\b",
    r"\bneed a stronger justification\b",
    r"\bstill need a stronger\b",
    r"\bnot ready to change\b",
    r"\bnot ready to move\b",
    r"\bwhy should i\b",
    r"\bi can't\b",
    r"\bthat's not enough\b",
    r"\btoo high\b",
    r"\btoo low\b",
]
CONCESSION_PATTERNS = [
    r"\bokay\b",
    r"\bfine\b",
    r"\bmeet in the middle\b",
    r"\bi can do that\b",
    r"\bwork with that\b",
    r"\bopen to\b",
]
EMOTIONAL_ESCALATION_PATTERNS = [
    r"\bfrustrat",
    r"\bunfair\b",
    r"\bupset\b",
    r"\bannoy",
    r"\bseriously\b",
    r"\bfinal offer\b",
    r"!",
]
AGREEMENT_PATTERNS = [
    r"\bworkable\b",
    r"\bagree(?:ment)?\b",
    r"\bdeal\b",
    r"\bfinal offer\b",
    r"\bmove forward\b",
    r"\bdraw up\b",
    r"\bcommitted to staying\b",
]


def _matches(text: str, patterns: list[str], *, threshold: int = 1) -> bool:
    count = 0
    for pattern in patterns:
        if re.search(pattern, text, re.IGNORECASE):
            count += 1
    return count >= threshold


def detect_key_moments(session_id: str, turns: list[ConversationTurn]) -> list[KeyMoment]:
    moments: list[KeyMoment] = []
    seen_kinds: set[str] = set()

    for index, turn in enumerate(turns):
        text = turn.transcript.strip()
        if not text:
            continue

        if (
            turn.speaker == "user"
            and "first_anchor" not in seen_kinds
            and _matches(text, ANCHOR_PATTERNS, threshold=2)
        ):
            moments.append(
                KeyMoment(
                    keyMomentId=make_id("km"),
                    sessionId=session_id,
                    kind="first_anchor",
                    label="First Anchor",
                    summary=summarize_text(text, 72),
                    turnId=turn.turn_id,
                    turnIndex=index + 1,
                    speaker=turn.speaker,
                    createdAt=now_iso(),
                )
            )
            seen_kinds.add("first_anchor")

        if (
            turn.speaker == "agent"
            and "strong_pushback" not in seen_kinds
            and _matches(text, PUSHBACK_PATTERNS)
        ):
            moments.append(
                KeyMoment(
                    keyMomentId=make_id("km"),
                    sessionId=session_id,
                    kind="strong_pushback",
                    label="Strong Pushback",
                    summary=summarize_text(text, 72),
                    turnId=turn.turn_id,
                    turnIndex=index + 1,
                    speaker=turn.speaker,
                    createdAt=now_iso(),
                )
            )
            seen_kinds.add("strong_pushback")

        if (
            turn.speaker == "user"
            and "first_concession" not in seen_kinds
            and _matches(text, CONCESSION_PATTERNS)
        ):
            moments.append(
                KeyMoment(
                    keyMomentId=make_id("km"),
                    sessionId=session_id,
                    kind="first_concession",
                    label="First Concession",
                    summary=summarize_text(text, 72),
                    turnId=turn.turn_id,
                    turnIndex=index + 1,
                    speaker=turn.speaker,
                    createdAt=now_iso(),
                )
            )
            seen_kinds.add("first_concession")

        if (
            "emotional_escalation" not in seen_kinds
            and _matches(text, EMOTIONAL_ESCALATION_PATTERNS, threshold=1)
        ):
            moments.append(
                KeyMoment(
                    keyMomentId=make_id("km"),
                    sessionId=session_id,
                    kind="emotional_escalation",
                    label="Emotional Escalation",
                    summary=summarize_text(text, 72),
                    turnId=turn.turn_id,
                    turnIndex=index + 1,
                    speaker=turn.speaker,
                    createdAt=now_iso(),
                )
            )
            seen_kinds.add("emotional_escalation")

        if (
            "agreement_frame_shift" not in seen_kinds
            and _matches(text, AGREEMENT_PATTERNS)
        ):
            moments.append(
                KeyMoment(
                    keyMomentId=make_id("km"),
                    sessionId=session_id,
                    kind="agreement_frame_shift",
                    label="Agreement Shift",
                    summary=summarize_text(text, 72),
                    turnId=turn.turn_id,
                    turnIndex=index + 1,
                    speaker=turn.speaker,
                    createdAt=now_iso(),
                )
            )
            seen_kinds.add("agreement_frame_shift")

    moments.sort(key=lambda moment: moment.turn_index)
    return moments
