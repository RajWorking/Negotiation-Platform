export type Mode = "fast" | "balanced" | "quality";

export interface VoiceProfile {
  preset?: string;
  gender?: string;
  age?: string;
  accent?: string;
}

export interface SimulationConfig {
  sessionId: string;
  situationDescription: string;
  partnerTone: string;
  voiceProfile: VoiceProfile;
  mode: Mode;
  coachingFocuses?: string[];
  createdAt: string;
}

export interface ConversationTurn {
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

export interface Checkpoint {
  checkpointId: string;
  sessionId: string;
  turnIndex: number;
  transcriptSnapshot: ConversationTurn[];
  stateSnapshot: Record<string, unknown>;
  summary: string;
  createdAt: string;
}

export interface CoachingReport {
  reportId: string;
  sessionId: string;
  basedOnTurnRange: {
    start: number;
    end: number;
  };
  strengths: string[];
  weakSignals: string[];
  suggestedNextMove: string;
  retrievedEvidence: Array<{
    source: string;
    snippet: string;
  }>;
  createdAt: string;
}

export interface DocumentChunk {
  chunkId: string;
  sessionId: string;
  sourceFileName: string;
  text: string;
  embedding: number[];
  metadata: Record<string, unknown>;
}

export interface BehavioralFeatures {
  apologyFrequency: number;
  concessionTurnIndices: number[];
  anchoringAttempts: number;
  interruptions: number;
  confidenceCues: number;
  warmthCues: number;
  dominanceCues: number;
  speakingRateWpm: number;
}

export interface SessionState {
  sessionId: string;
  status: "created" | "ready" | "live" | "paused" | "ended";
  config: SimulationConfig;
  turns: ConversationTurn[];
  checkpoints: Checkpoint[];
  reports: CoachingReport[];
  documentChunks: DocumentChunk[];
  features: BehavioralFeatures;
  archivedTurns: ConversationTurn[];
  liveState: {
    turnIndex: number;
    currentSpeaker: "user" | "agent" | null;
    audioChunksReceived: number;
    bytesReceived: number;
    partialTranscript?: string;
    lastCheckpointId?: string;
    lastUpdatedAt: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface PersonaTemplate {
  id: string;
  label: string;
  systemPrompt: string;
  styleTags: string[];
  opener: string;
  challengeStyle: string;
}

export interface RoutingDecision {
  mode: Mode;
  contextWindow: number;
  responseStyle: "concise" | "balanced" | "strategic";
  coachingDepth: 1 | 2 | 3;
}

export interface PracticeAgentResponse {
  reply_text: string;
  emotion_tags: string[];
  intent: string;
}

export interface RetrievedChunk {
  source: string;
  snippet: string;
  score: number;
}

export interface CoachRequest {
  windowTurns?: number;
}
