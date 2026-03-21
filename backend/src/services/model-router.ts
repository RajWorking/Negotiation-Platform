import type { Mode, RoutingDecision } from "../types.ts";

export function routeMode(mode: Mode): RoutingDecision {
  if (mode === "fast") {
    return {
      mode,
      contextWindow: 4,
      responseStyle: "concise",
      coachingDepth: 1
    };
  }

  if (mode === "quality") {
    return {
      mode,
      contextWindow: 10,
      responseStyle: "strategic",
      coachingDepth: 3
    };
  }

  return {
    mode: "balanced",
    contextWindow: 6,
    responseStyle: "balanced",
    coachingDepth: 2
  };
}
