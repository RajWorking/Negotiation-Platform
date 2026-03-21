import type { BehavioralFeatures, ConversationTurn } from "../types.ts";

const APOLOGY_PATTERNS = [/sorry/gi, /\bi apologize\b/gi, /\bapologies\b/gi];
const CONCESSION_PATTERNS = [/\bokay\b/gi, /\bfine\b/gi, /\bi can do that\b/gi, /\blet'?s meet in the middle\b/gi];
const CONFIDENCE_PATTERNS = [/\bi (believe|know|recommend|propose|suggest)\b/gi, /\bmy target\b/gi];
const WARMTH_PATTERNS = [/\bappreciate\b/gi, /\bthank you\b/gi, /\bunderstand\b/gi];
const DOMINANCE_PATTERNS = [/\bneed\b/gi, /\bmust\b/gi, /\bfinal\b/gi];

function countMatches(text: string, patterns: RegExp[]) {
  return patterns.reduce((sum, pattern) => sum + (text.match(pattern)?.length ?? 0), 0);
}

export function extractFeatures(turns: ConversationTurn[]): BehavioralFeatures {
  const userTurns = turns.filter((turn) => turn.speaker === "user");
  const joined = userTurns.map((turn) => turn.transcript).join(" ");
  const apologyFrequency = countMatches(joined, APOLOGY_PATTERNS);
  const anchoringAttempts = (joined.match(/\$?\d[\d,]*(\.\d+)?/g) ?? []).length;
  const confidenceCues = countMatches(joined, CONFIDENCE_PATTERNS);
  const warmthCues = countMatches(joined, WARMTH_PATTERNS);
  const dominanceCues = countMatches(joined, DOMINANCE_PATTERNS);

  const concessionTurnIndices = userTurns.flatMap((turn, index) =>
    countMatches(turn.transcript, CONCESSION_PATTERNS) > 0 ? [index] : []
  );

  let wordCount = 0;
  let totalMinutes = 0;
  for (const turn of userTurns) {
    wordCount += turn.transcript.split(/\s+/).filter(Boolean).length;
    if (turn.startedAt && turn.endedAt) {
      const durationMs = new Date(turn.endedAt).getTime() - new Date(turn.startedAt).getTime();
      totalMinutes += Math.max(durationMs, 0) / 60000;
    }
  }

  return {
    apologyFrequency,
    concessionTurnIndices,
    anchoringAttempts,
    interruptions: 0,
    confidenceCues,
    warmthCues,
    dominanceCues,
    speakingRateWpm: totalMinutes > 0 ? Math.round(wordCount / totalMinutes) : wordCount
  };
}
