import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SessionStore } from "../services/session-store.ts";
import { SessionOrchestrator } from "../services/session-orchestrator.ts";
import { DocumentIngestionService } from "../services/document-ingestion.ts";

async function createHarness() {
  const baseDir = await mkdtemp(path.join(tmpdir(), "negotiation-backend-"));
  const store = new SessionStore(baseDir);
  await store.init();
  const documentService = new DocumentIngestionService(path.join(baseDir, "uploads"));
  const orchestrator = new SessionOrchestrator(store, documentService, path.join(baseDir, "audio"));
  return { orchestrator, store, baseDir };
}

test("session creation persists config and default state", async () => {
  const { orchestrator, store } = await createHarness();
  const session = await orchestrator.createSession({
    situation_description: "Negotiate a higher salary",
    partner_tone: "analytical",
    voice_profile: { preset: "adult_female_neutral_us" },
    mode: "balanced",
    coaching_focuses: ["Anchoring & Numbers"]
  });

  const saved = await store.get(session.sessionId);
  assert.ok(saved);
  assert.equal(saved?.config.situationDescription, "Negotiate a higher salary");
  assert.equal(saved?.status, "created");
  assert.deepEqual(saved?.documentChunks, []);
});

test("coaching response schema is structured and grounded", async () => {
  const { orchestrator } = await createHarness();
  const session = await orchestrator.createSession({
    situation_description: "Renegotiate rent with a landlord",
    partner_tone: "landlord",
    voice_profile: {},
    mode: "quality"
  });

  const fileContent = Buffer.from("Anchor early and justify with objective criteria.", "utf8").toString("base64");
  await orchestrator.uploadDocuments(session.sessionId, [{ fileName: "notes.txt", base64: fileContent }]);
  await orchestrator.startSession(session.sessionId);
  await orchestrator.finalizeUserTranscript(session.sessionId, "I would like to discuss reducing rent to $1900 based on comparable units.");
  const report = await orchestrator.createCoachingReport(session.sessionId, { windowTurns: 4 });

  assert.equal(typeof report.reportId, "string");
  assert.ok(Array.isArray(report.strengths));
  assert.ok(Array.isArray(report.weakSignals));
  assert.equal(typeof report.suggestedNextMove, "string");
  assert.ok(Array.isArray(report.retrievedEvidence));
});

test("rewind restores prior checkpoint and discards later turns from the active branch", async () => {
  const { orchestrator } = await createHarness();
  const session = await orchestrator.createSession({
    situation_description: "Handle a difficult performance review",
    partner_tone: "dismissive",
    voice_profile: {},
    mode: "fast"
  });

  await orchestrator.startSession(session.sessionId);
  const first = await orchestrator.finalizeUserTranscript(session.sessionId, "I want to talk about the review and my promotion path.");
  await orchestrator.finalizeUserTranscript(session.sessionId, "I also want to understand how you see my recent project impact.");

  const rewind = await orchestrator.rewindSession(session.sessionId, first.checkpoint!.checkpointId);
  assert.equal(rewind.status, "restored");
  assert.equal(rewind.session.turns.length, first.checkpoint!.transcriptSnapshot.length);
  assert.ok(rewind.session.archivedTurns.length > 0);
});
