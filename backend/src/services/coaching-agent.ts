import { buildCoachingPrompt } from "./prompt-builder.ts";
import { makeId } from "../lib/utils.ts";
import type { BehavioralFeatures, CoachingReport, ConversationTurn, RetrievedChunk, RoutingDecision, SimulationConfig } from "../types.ts";

function strengthsFromFeatures(features: BehavioralFeatures, turns: ConversationTurn[]) {
  const strengths: string[] = [];
  if (features.anchoringAttempts > 0) {
    strengths.push("You used at least one concrete anchor instead of staying vague.");
  }
  if (features.confidenceCues > 0) {
    strengths.push("You stated your position directly instead of only hinting at it.");
  }
  if (features.warmthCues > 0) {
    strengths.push("You kept some warmth in the conversation while still advocating for yourself.");
  }
  const userTurns = turns.filter((turn) => turn.speaker === "user");
  if (userTurns.length >= 2) {
    strengths.push("You stayed engaged through multiple rounds instead of retreating after pushback.");
  }
  return strengths.slice(0, 3);
}

function weaknessesFromFeatures(features: BehavioralFeatures) {
  const weakSignals: string[] = [];
  if (features.apologyFrequency > 1) {
    weakSignals.push(`You apologized ${features.apologyFrequency} times, which can dilute your leverage.`);
  }
  if (features.anchoringAttempts === 0) {
    weakSignals.push("You have not anchored with a concrete ask yet.");
  }
  if (features.concessionTurnIndices.some((index) => index <= 1)) {
    weakSignals.push("You showed concession language early before fully defending your position.");
  }
  if (features.confidenceCues === 0) {
    weakSignals.push("Your wording stayed softer than necessary and did not clearly claim a target.");
  }
  return weakSignals.slice(0, 3);
}

function buildNextMove(features: BehavioralFeatures, retrieved: RetrievedChunk[]) {
  const evidenceLead = retrieved[0]?.snippet;
  if (features.anchoringAttempts === 0) {
    return evidenceLead
      ? `State your target plainly, justify it with objective criteria, then reinforce it with this principle: "${evidenceLead}".`
      : "State your target plainly, justify it with objective criteria, and then ask for a concrete response instead of softening the ask.";
  }

  if (features.apologyFrequency > 1) {
    return "Drop the apology frame. Restate your core ask in one calm sentence, add one business or factual justification, and then pause for the other side to respond.";
  }

  return evidenceLead
    ? `Use the next turn to summarize your value, restate your anchor, and connect it to this guidance: "${evidenceLead}".`
    : "Use the next turn to restate your position crisply, tie it to concrete impact, and ask for a direct yes/no response or counterproposal.";
}

export class CoachingAgent {
  createReport(params: {
    sessionId: string;
    config: SimulationConfig;
    recentTurns: ConversationTurn[];
    features: BehavioralFeatures;
    retrieved: RetrievedChunk[];
    routing: RoutingDecision;
  }): CoachingReport {
    buildCoachingPrompt(params);
    const strengths = strengthsFromFeatures(params.features, params.recentTurns);
    const weakSignals = weaknessesFromFeatures(params.features);

    return {
      reportId: makeId("coach"),
      sessionId: params.sessionId,
      basedOnTurnRange: {
        start: Math.max(0, params.recentTurns.length - Math.max(2, params.routing.contextWindow)),
        end: Math.max(0, params.recentTurns.length - 1)
      },
      strengths: strengths.length > 0 ? strengths : ["You stayed in the conversation instead of abandoning the interaction after resistance."],
      weakSignals: weakSignals.length > 0 ? weakSignals : ["There were few obvious weak signals, so focus on becoming more specific and more deliberate."],
      suggestedNextMove: buildNextMove(params.features, params.retrieved),
      retrievedEvidence: params.retrieved.map((item) => ({
        source: item.source,
        snippet: item.snippet
      })),
      createdAt: new Date().toISOString()
    };
  }
}
