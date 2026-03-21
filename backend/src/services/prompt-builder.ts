import { summarizeText } from "../lib/utils.ts";
import type { BehavioralFeatures, ConversationTurn, PersonaTemplate, RetrievedChunk, RoutingDecision, SimulationConfig } from "../types.ts";

export interface PracticePromptContext {
  config: SimulationConfig;
  persona: PersonaTemplate;
  turns: ConversationTurn[];
  routing: RoutingDecision;
}

export interface CoachingPromptContext {
  config: SimulationConfig;
  recentTurns: ConversationTurn[];
  features: BehavioralFeatures;
  retrieved: RetrievedChunk[];
  routing: RoutingDecision;
}

export function buildPracticePrompt(context: PracticePromptContext) {
  const history = context.turns
    .slice(-context.routing.contextWindow)
    .map((turn) => `${turn.speaker.toUpperCase()}: ${summarizeText(turn.transcript, 180)}`)
    .join("\n");

  return [
    `Scenario: ${context.config.situationDescription}`,
    `Persona: ${context.persona.label}`,
    `Persona directive: ${context.persona.systemPrompt}`,
    `Voice tags: ${context.persona.styleTags.join(", ")}`,
    `Recent history:\n${history}`
  ].join("\n\n");
}

export function buildCoachingPrompt(context: CoachingPromptContext) {
  const recentTurns = context.recentTurns
    .map((turn, index) => `${index + 1}. ${turn.speaker}: ${summarizeText(turn.transcript, 220)}`)
    .join("\n");
  const retrieval = context.retrieved
    .map((chunk) => `${chunk.source}: ${chunk.snippet}`)
    .join("\n");

  return [
    `Scenario: ${context.config.situationDescription}`,
    `Coaching focuses: ${(context.config.coachingFocuses ?? []).join(", ") || "general negotiation"}`,
    `Recent turns:\n${recentTurns}`,
    `Features: ${JSON.stringify(context.features)}`,
    retrieval ? `Retrieved guidance:\n${retrieval}` : "Retrieved guidance: none"
  ].join("\n\n");
}
