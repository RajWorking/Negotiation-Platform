from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, Field


Mode = Literal["fast", "balanced", "quality"]


class VoiceProfile(BaseModel):
    preset: Optional[str] = None
    gender: Optional[str] = None
    age: Optional[str] = None
    accent: Optional[str] = None


class SimulationConfig(BaseModel):
    session_id: str = Field(alias="sessionId")
    situation_description: str = Field(alias="situationDescription")
    partner_tone: str = Field(alias="partnerTone")
    voice_profile: VoiceProfile = Field(alias="voiceProfile")
    mode: Mode
    coaching_focuses: list[str] = Field(default_factory=list, alias="coachingFocuses")
    created_at: str = Field(alias="createdAt")

    model_config = {"populate_by_name": True}


class ConversationTurn(BaseModel):
    turn_id: str = Field(alias="turnId")
    session_id: str = Field(alias="sessionId")
    speaker: Literal["user", "agent"]
    transcript: str
    audio_uri: Optional[str] = Field(default=None, alias="audioUri")
    emotion_tags: Optional[list[str]] = Field(default=None, alias="emotionTags")
    started_at: str = Field(alias="startedAt")
    ended_at: Optional[str] = Field(default=None, alias="endedAt")
    metadata: Optional[dict[str, Any]] = None

    model_config = {"populate_by_name": True}


class Checkpoint(BaseModel):
    checkpoint_id: str = Field(alias="checkpointId")
    session_id: str = Field(alias="sessionId")
    turn_index: int = Field(alias="turnIndex")
    transcript_snapshot: list[ConversationTurn] = Field(alias="transcriptSnapshot")
    state_snapshot: dict[str, Any] = Field(alias="stateSnapshot")
    summary: str
    created_at: str = Field(alias="createdAt")

    model_config = {"populate_by_name": True}


class CoachingReport(BaseModel):
    report_id: str = Field(alias="reportId")
    session_id: str = Field(alias="sessionId")
    based_on_turn_range: dict[str, int] = Field(alias="basedOnTurnRange")
    strengths: list[str]
    weak_signals: list[str] = Field(alias="weakSignals")
    suggested_next_move: str = Field(alias="suggestedNextMove")
    retrieved_evidence: list[dict[str, str]] = Field(alias="retrievedEvidence")
    created_at: str = Field(alias="createdAt")

    model_config = {"populate_by_name": True}


class DocumentChunk(BaseModel):
    chunk_id: str = Field(alias="chunkId")
    session_id: str = Field(alias="sessionId")
    source_file_name: str = Field(alias="sourceFileName")
    text: str
    embedding: list[float]
    metadata: dict[str, Any]

    model_config = {"populate_by_name": True}


class BehavioralFeatures(BaseModel):
    apology_frequency: int = Field(default=0, alias="apologyFrequency")
    concession_turn_indices: list[int] = Field(default_factory=list, alias="concessionTurnIndices")
    anchoring_attempts: int = Field(default=0, alias="anchoringAttempts")
    interruptions: int = 0
    confidence_cues: int = Field(default=0, alias="confidenceCues")
    warmth_cues: int = Field(default=0, alias="warmthCues")
    dominance_cues: int = Field(default=0, alias="dominanceCues")
    speaking_rate_wpm: int = Field(default=0, alias="speakingRateWpm")

    model_config = {"populate_by_name": True}


class LiveState(BaseModel):
    turn_index: int = Field(default=0, alias="turnIndex")
    current_speaker: Optional[Literal["user", "agent"]] = Field(default=None, alias="currentSpeaker")
    audio_chunks_received: int = Field(default=0, alias="audioChunksReceived")
    bytes_received: int = Field(default=0, alias="bytesReceived")
    partial_transcript: str = Field(default="", alias="partialTranscript")
    last_checkpoint_id: Optional[str] = Field(default=None, alias="lastCheckpointId")
    last_updated_at: str = Field(alias="lastUpdatedAt")

    model_config = {"populate_by_name": True}


class SessionState(BaseModel):
    session_id: str = Field(alias="sessionId")
    status: Literal["created", "ready", "live", "paused", "ended"]
    config: SimulationConfig
    turns: list[ConversationTurn]
    checkpoints: list[Checkpoint]
    reports: list[CoachingReport]
    document_chunks: list[DocumentChunk] = Field(alias="documentChunks")
    features: BehavioralFeatures
    archived_turns: list[ConversationTurn] = Field(alias="archivedTurns")
    live_state: LiveState = Field(alias="liveState")
    created_at: str = Field(alias="createdAt")
    updated_at: str = Field(alias="updatedAt")

    model_config = {"populate_by_name": True}


class CreateSessionRequest(BaseModel):
    situation_description: str
    partner_tone: str
    voice_profile: VoiceProfile = Field(default_factory=VoiceProfile)
    mode: Mode = "balanced"
    coaching_focuses: list[str] = Field(default_factory=list)


class DocumentUploadRequest(BaseModel):
    files: list[dict[str, str]]


class CoachRequest(BaseModel):
    window_turns: int = 6


class RewindRequest(BaseModel):
    checkpoint_id: str
