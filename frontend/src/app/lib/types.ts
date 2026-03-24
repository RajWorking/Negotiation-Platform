export type Mode = "fast" | "balanced" | "quality";

export interface VoiceProfile {
  preset?: string;
  gender?: string;
  age?: string;
  accent?: string;
}

export interface TranscriptTurn {
  turnId: string;
  sessionId: string;
  speaker: "user" | "agent";
  transcript: string;
  audioUri?: string;
  emotionTags?: string[];
  startedAt: string;
  endedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface CheckpointSummary {
  checkpointId: string;
  turnIndex: number;
  summary: string;
  createdAt: string;
}

export interface KeyMoment {
  keyMomentId: string;
  kind:
    | "first_anchor"
    | "strong_pushback"
    | "first_concession"
    | "emotional_escalation"
    | "agreement_frame_shift";
  label: string;
  summary: string;
  turnId: string;
  turnIndex: number;
  speaker: "user" | "agent";
  createdAt: string;
}

export interface CoachingReportResponse {
  report_id: string;
  strengths: string[];
  weak_signals: string[];
  suggested_next_move: string;
  retrieved_evidence: Array<{
    source: string;
    snippet: string;
  }>;
}

export interface SessionStateResponse {
  sessionId: string;
  status: "created" | "ready" | "live" | "paused" | "ended";
  config: {
    sessionId: string;
    situationDescription: string;
    partnerTone: string;
    voiceProfile: VoiceProfile;
    mode: Mode;
    createdAt: string;
    coachingFocuses?: string[];
  };
  turns: TranscriptTurn[];
  checkpoints: CheckpointSummary[];
  keyMoments: KeyMoment[];
  liveState: {
    turnIndex: number;
    currentSpeaker: "user" | "agent" | null;
    audioChunksReceived: number;
    bytesReceived: number;
    partialTranscript?: string;
    lastCheckpointId?: string;
    lastUpdatedAt: string;
  };
  features: Record<string, unknown>;
  reports: Array<Record<string, unknown>>;
}

export interface SetupDraft {
  situation: string;
  tone: string;
  customTone: string;
  coachingFocuses: string[];
  gender: string;
  age: string;
  accent: string;
  adviceSpeed: number;
}

export interface ActiveSessionSnapshot {
  sessionId: string;
  situation: string;
  tone: string;
  mode: Mode;
  voiceProfile: VoiceProfile;
}
