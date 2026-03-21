from __future__ import annotations

import re
from datetime import datetime

from .schemas import BehavioralFeatures, ConversationTurn

APOLOGY_PATTERNS = [r"sorry", r"\bi apologize\b", r"\bapologies\b"]
CONCESSION_PATTERNS = [r"\bokay\b", r"\bfine\b", r"\bi can do that\b", r"meet in the middle"]
CONFIDENCE_PATTERNS = [r"\bi (believe|know|recommend|propose|suggest)\b", r"\bmy target\b"]
WARMTH_PATTERNS = [r"\bappreciate\b", r"\bthank you\b", r"\bunderstand\b"]
DOMINANCE_PATTERNS = [r"\bneed\b", r"\bmust\b", r"\bfinal\b"]


def _count(text: str, patterns: list[str]) -> int:
    return sum(len(re.findall(pattern, text, re.IGNORECASE)) for pattern in patterns)


def extract_features(turns: list[ConversationTurn]) -> BehavioralFeatures:
    user_turns = [turn for turn in turns if turn.speaker == "user"]
    joined = " ".join(turn.transcript for turn in user_turns)
    apology_frequency = _count(joined, APOLOGY_PATTERNS)
    anchoring_attempts = len(re.findall(r"\$?\d[\d,]*(?:\.\d+)?", joined))
    confidence_cues = _count(joined, CONFIDENCE_PATTERNS)
    warmth_cues = _count(joined, WARMTH_PATTERNS)
    dominance_cues = _count(joined, DOMINANCE_PATTERNS)

    concession_turn_indices = [
        index
        for index, turn in enumerate(user_turns)
        if _count(turn.transcript, CONCESSION_PATTERNS) > 0
    ]

    word_count = 0
    total_minutes = 0.0
    for turn in user_turns:
        word_count += len(turn.transcript.split())
        if turn.started_at and turn.ended_at:
            start = datetime.fromisoformat(turn.started_at.replace("Z", "+00:00"))
            end = datetime.fromisoformat(turn.ended_at.replace("Z", "+00:00"))
            total_minutes += max((end - start).total_seconds(), 0) / 60.0

    return BehavioralFeatures(
        apologyFrequency=apology_frequency,
        concessionTurnIndices=concession_turn_indices,
        anchoringAttempts=anchoring_attempts,
        interruptions=0,
        confidenceCues=confidence_cues,
        warmthCues=warmth_cues,
        dominanceCues=dominance_cues,
        speakingRateWpm=round(word_count / total_minutes) if total_minutes > 0 else word_count,
    )
