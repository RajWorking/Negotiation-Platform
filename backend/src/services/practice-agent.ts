import { summarizeText } from "../lib/utils.ts";
import { buildPracticePrompt } from "./prompt-builder.ts";
import type { PracticeAgentResponse, SimulationConfig, ConversationTurn, PersonaTemplate, RoutingDecision } from "../types.ts";

function detectIntent(lastUserTurn: string) {
  if (/\$?\d[\d,]*(\.\d+)?/.test(lastUserTurn)) {
    return "counter";
  }
  if (/\?$/.test(lastUserTurn.trim())) {
    return "question";
  }
  if (/\b(because|data|market|impact|evidence|reason)\b/i.test(lastUserTurn)) {
    return "justify";
  }
  return "pushback";
}

function buildToneLead(persona: PersonaTemplate) {
  return `${persona.opener} ${persona.challengeStyle}`;
}

function buildReplyBody(intent: string, lastUserTurn: string, config: SimulationConfig, routing: RoutingDecision) {
  const concise = routing.responseStyle === "concise";
  const strategic = routing.responseStyle === "strategic";
  const summary = summarizeText(lastUserTurn, concise ? 70 : 120);

  if (intent === "counter") {
    return concise
      ? `You mentioned ${summary}. Why does that number work better for me than the status quo?`
      : strategic
        ? `You’ve put a concrete number on the table, but I still need a tighter case for why that number fits the constraints here. Show me the business logic, the tradeoffs, and why I should move off my current position.`
        : `You’ve made a concrete ask. I need to understand why that number is justified for this situation, not just why it helps your side.`;
  }

  if (intent === "question") {
    return concise
      ? `I can answer that, but first I need clarity on what outcome you’re actually asking for.`
      : strategic
        ? `I’m willing to answer, but I need you to sharpen the objective first. Be explicit about the outcome you want, the rationale behind it, and what tradeoff you’re prepared to make.`
        : `I can address that, but I still need a clearer statement of the outcome you want here.`;
  }

  if (intent === "justify") {
    return concise
      ? `I hear the reasoning, but it still feels incomplete from my side.`
      : strategic
        ? `Your reasoning is better, but it still doesn’t fully close the gap for me. Tie your argument to concrete impact, risk reduction, or market reality so I can justify moving.`
        : `I hear the logic, but I still need a stronger justification before I change position.`;
  }

  if (/salary|offer|compensation|pay/i.test(config.situationDescription)) {
    return concise
      ? `I’m open to the discussion, but I need a stronger compensation case.`
      : strategic
        ? `I’m not dismissing the compensation discussion, but I need a tighter argument around scope, impact, and market evidence before I can move meaningfully.`
        : `I’m open to discussing compensation, but I need a stronger case than that.`;
  }

  return concise
    ? `I understand the ask, but I’m not ready to move yet.`
    : strategic
      ? `I understand where you’re trying to take this conversation, but I’m not convinced yet. If you want movement from me, make the next point more concrete, more specific, and more valuable from my perspective.`
      : `I understand your position, but I’m not persuaded enough to change mine yet.`;
}

export class PracticeAgent {
  generate(params: {
    config: SimulationConfig;
    turns: ConversationTurn[];
    persona: PersonaTemplate;
    routing: RoutingDecision;
  }): PracticeAgentResponse {
    buildPracticePrompt(params);
    const lastUserTurn = [...params.turns].reverse().find((turn) => turn.speaker === "user")?.transcript ?? "";
    const intent = detectIntent(lastUserTurn);
    const lead = buildToneLead(params.persona);
    const body = buildReplyBody(intent, lastUserTurn, params.config, params.routing);
    const emotionTags = params.persona.styleTags.slice(0, 2);

    return {
      reply_text: `${lead} ${body}`.replace(/\s+/g, " ").trim(),
      emotion_tags: emotionTags,
      intent
    };
  }
}
