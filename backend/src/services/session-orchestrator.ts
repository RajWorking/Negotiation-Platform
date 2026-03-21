import path from "node:path";
import { appendFile } from "node:fs/promises";
import { extractFeatures } from "./feature-extractor.ts";
import { getPersonaTemplate } from "./personas.ts";
import { routeMode } from "./model-router.ts";
import { PracticeAgent } from "./practice-agent.ts";
import { CoachingAgent } from "./coaching-agent.ts";
import { DocumentIngestionService } from "./document-ingestion.ts";
import { ensureDir, makeId, nowIso, summarizeText } from "../lib/utils.ts";
import type { BehavioralFeatures, Checkpoint, CoachRequest, ConversationTurn, SessionState, SimulationConfig } from "../types.ts";
import type { SessionStore } from "./session-store.ts";

function defaultFeatures(): BehavioralFeatures {
  return {
    apologyFrequency: 0,
    concessionTurnIndices: [],
    anchoringAttempts: 0,
    interruptions: 0,
    confidenceCues: 0,
    warmthCues: 0,
    dominanceCues: 0,
    speakingRateWpm: 0
  };
}

export class SessionOrchestrator {
  private readonly practiceAgent = new PracticeAgent();
  private readonly coachingAgent = new CoachingAgent();
  private readonly sessionStore: SessionStore;
  private readonly documentService: DocumentIngestionService;
  private readonly audioDir: string;

  constructor(
    sessionStore: SessionStore,
    documentService: DocumentIngestionService,
    audioDir: string
  ) {
    this.sessionStore = sessionStore;
    this.documentService = documentService;
    this.audioDir = audioDir;
  }

  async createSession(input: {
    situation_description: string;
    partner_tone: string;
    voice_profile: SimulationConfig["voiceProfile"];
    mode: SimulationConfig["mode"];
    coaching_focuses?: string[];
  }) {
    const sessionId = makeId("sess");
    const createdAt = nowIso();
    const session: SessionState = {
      sessionId,
      status: "created",
      config: {
        sessionId,
        situationDescription: input.situation_description,
        partnerTone: input.partner_tone,
        voiceProfile: input.voice_profile ?? {},
        mode: input.mode,
        coachingFocuses: input.coaching_focuses ?? [],
        createdAt
      },
      turns: [],
      checkpoints: [],
      reports: [],
      documentChunks: [],
      features: defaultFeatures(),
      archivedTurns: [],
      liveState: {
        turnIndex: 0,
        currentSpeaker: null,
        audioChunksReceived: 0,
        bytesReceived: 0,
        lastUpdatedAt: createdAt
      },
      createdAt,
      updatedAt: createdAt
    };
    await this.sessionStore.save(session);
    return session;
  }

  async uploadDocuments(sessionId: string, files: Array<{ fileName: string; base64: string }>) {
    const session = await this.requireSession(sessionId);
    let indexed = 0;
    for (const file of files) {
      const storedPath = await this.documentService.saveUpload(sessionId, file.fileName, file.base64);
      const chunks = await this.documentService.ingest(sessionId, file.fileName, storedPath);
      session.documentChunks.push(...chunks);
      indexed += 1;
    }
    await this.sessionStore.save(session);
    return { uploaded: files.length, indexed, status: "ready" as const };
  }

  async startSession(sessionId: string) {
    const session = await this.requireSession(sessionId);
    session.status = "live";
    session.liveState.currentSpeaker = "user";
    session.liveState.lastUpdatedAt = nowIso();
    await this.sessionStore.save(session);
    return session;
  }

  async pauseSession(sessionId: string) {
    const session = await this.requireSession(sessionId);
    session.status = "paused";
    session.liveState.currentSpeaker = null;
    session.liveState.lastUpdatedAt = nowIso();
    await this.sessionStore.save(session);
    return session;
  }

  async resumeSession(sessionId: string) {
    const session = await this.requireSession(sessionId);
    session.status = "live";
    session.liveState.currentSpeaker = "user";
    session.liveState.lastUpdatedAt = nowIso();
    await this.sessionStore.save(session);
    return session;
  }

  async endSession(sessionId: string) {
    const session = await this.requireSession(sessionId);
    session.status = "ended";
    session.liveState.currentSpeaker = null;
    session.liveState.lastUpdatedAt = nowIso();
    await this.sessionStore.save(session);
    return session;
  }

  async getState(sessionId: string) {
    return this.requireSession(sessionId);
  }

  async getCheckpoints(sessionId: string) {
    const session = await this.requireSession(sessionId);
    return session.checkpoints;
  }

  async rewindSession(sessionId: string, checkpointId: string) {
    const session = await this.requireSession(sessionId);
    const checkpoint = session.checkpoints.find((item) => item.checkpointId === checkpointId);
    if (!checkpoint) {
      throw new Error("Checkpoint not found");
    }

    const laterTurns = session.turns.slice(checkpoint.transcriptSnapshot.length);
    session.archivedTurns.push(...laterTurns);
    session.turns = checkpoint.transcriptSnapshot.map((turn) => ({ ...turn }));
    session.liveState.turnIndex = checkpoint.turnIndex;
    session.liveState.lastCheckpointId = checkpoint.checkpointId;
    session.liveState.currentSpeaker = "user";
    session.liveState.partialTranscript = "";
    session.features = extractFeatures(session.turns);
    session.status = "live";
    await this.sessionStore.save(session);
    return {
      status: "restored" as const,
      turn_index: checkpoint.turnIndex,
      session
    };
  }

  async createCoachingReport(sessionId: string, request: CoachRequest = {}) {
    const session = await this.requireSession(sessionId);
    const routing = routeMode(session.config.mode);
    const windowTurns = Math.max(2, request.windowTurns ?? routing.contextWindow);
    const recentTurns = session.turns.slice(-windowTurns);
    const query = [
      session.config.situationDescription,
      recentTurns.map((turn) => turn.transcript).join(" "),
      `weaknesses ${session.features.apologyFrequency} apologies ${session.features.anchoringAttempts} anchors`
    ].join(" ");
    const retrieved = this.documentService.retrieve(session.documentChunks, query, 3);
    const report = this.coachingAgent.createReport({
      sessionId,
      config: session.config,
      recentTurns,
      features: session.features,
      retrieved,
      routing
    });
    session.reports.push(report);
    session.status = "paused";
    await this.sessionStore.save(session);
    return report;
  }

  async ingestAudioChunk(sessionId: string, payload: { base64?: string }) {
    const session = await this.requireSession(sessionId);
    session.liveState.audioChunksReceived += 1;
    if (payload.base64) {
      const buffer = Buffer.from(payload.base64, "base64");
      session.liveState.bytesReceived += buffer.byteLength;
      const targetFile = path.join(this.audioDir, `${sessionId}.webm`);
      await ensureDir(path.dirname(targetFile));
      await appendFile(targetFile, buffer);
    }
    session.liveState.lastUpdatedAt = nowIso();
    await this.sessionStore.save(session);
    return session.liveState;
  }

  async setPartialTranscript(sessionId: string, text: string) {
    const session = await this.requireSession(sessionId);
    session.liveState.partialTranscript = text;
    session.liveState.currentSpeaker = "user";
    session.liveState.lastUpdatedAt = nowIso();
    await this.sessionStore.save(session);
    return session;
  }

  async finalizeUserTranscript(sessionId: string, text: string) {
    const session = await this.requireSession(sessionId);
    if (session.status === "paused" || session.status === "ended") {
      return { session, agentTurn: null, checkpoint: null };
    }

    const routing = routeMode(session.config.mode);
    const persona = getPersonaTemplate(session.config.partnerTone);
    const turnStartedAt = nowIso();
    const userTurn: ConversationTurn = {
      turnId: makeId("turn"),
      sessionId,
      speaker: "user",
      transcript: text,
      startedAt: turnStartedAt,
      endedAt: nowIso()
    };
    session.turns.push(userTurn);
    session.liveState.partialTranscript = "";
    session.liveState.currentSpeaker = "agent";
    session.features = extractFeatures(session.turns);

    const agentResponse = this.practiceAgent.generate({
      config: session.config,
      turns: session.turns,
      persona,
      routing
    });
    const agentTurn: ConversationTurn = {
      turnId: makeId("turn"),
      sessionId,
      speaker: "agent",
      transcript: agentResponse.reply_text,
      emotionTags: agentResponse.emotion_tags,
      startedAt: nowIso(),
      endedAt: nowIso(),
      metadata: {
        intent: agentResponse.intent,
        voiceStyleTags: persona.styleTags
      }
    };
    session.turns.push(agentTurn);
    session.liveState.turnIndex = session.turns.length;
    session.features = extractFeatures(session.turns);

    const checkpoint = this.createCheckpoint(session);
    session.checkpoints.push(checkpoint);
    session.liveState.lastCheckpointId = checkpoint.checkpointId;
    session.liveState.currentSpeaker = "user";
    session.status = "live";
    await this.sessionStore.save(session);

    return { session, userTurn, agentTurn, checkpoint };
  }

  private createCheckpoint(session: SessionState): Checkpoint {
    const transcriptSnapshot = session.turns.map((turn) => ({ ...turn }));
    return {
      checkpointId: makeId("ckpt"),
      sessionId: session.sessionId,
      turnIndex: session.turns.length,
      transcriptSnapshot,
      stateSnapshot: {
        status: session.status,
        features: session.features,
        liveState: session.liveState
      },
      summary: summarizeText(transcriptSnapshot.at(-1)?.transcript ?? "Checkpoint", 72),
      createdAt: nowIso()
    };
  }

  private async requireSession(sessionId: string) {
    const session = await this.sessionStore.get(sessionId);
    if (!session) {
      throw new Error("Session not found");
    }
    return session;
  }
}
