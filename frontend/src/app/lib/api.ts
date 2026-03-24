import type { CoachingReportResponse, Mode, SessionStateResponse, VoiceProfile } from "./types";

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "") ?? "";

function buildUrl(path: string) {
  return API_BASE ? `${API_BASE}${path}` : path;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(buildUrl(path), {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options?.headers ?? {}),
    },
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => null);
    throw new Error(errorBody?.error ?? `Request failed with ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export function websocketUrl(sessionId: string) {
  if (API_BASE) {
    const url = new URL(API_BASE);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = `/sessions/${sessionId}/stream`;
    url.search = "";
    return url.toString();
  }

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/sessions/${sessionId}/stream`;
}

export function sliderValueToMode(value: number): Mode {
  if (value <= 33) {
    return "fast";
  }
  if (value >= 67) {
    return "quality";
  }
  return "balanced";
}

export async function createSession(payload: {
  situationDescription: string;
  partnerTone: string;
  voiceProfile: VoiceProfile;
  mode: Mode;
  coachingFocuses: string[];
}) {
  return request<{ session_id: string; status: string }>("/sessions", {
    method: "POST",
    body: JSON.stringify({
      situation_description: payload.situationDescription,
      partner_tone: payload.partnerTone,
      voice_profile: payload.voiceProfile,
      mode: payload.mode,
      coaching_focuses: payload.coachingFocuses,
    }),
  });
}

export async function uploadDocuments(sessionId: string, files: Array<{ fileName: string; base64: string }>) {
  return request<{ uploaded: number; indexed: number; status: string }>(`/sessions/${sessionId}/documents`, {
    method: "POST",
    body: JSON.stringify({ files }),
  });
}

export async function startSession(sessionId: string) {
  return request<{ status: string }>(`/sessions/${sessionId}/start`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function pauseSession(sessionId: string) {
  return request<{ status: string }>(`/sessions/${sessionId}/pause`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function resumeSession(sessionId: string) {
  return request<{ status: string }>(`/sessions/${sessionId}/resume`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function endSession(sessionId: string) {
  return request<{ status: string }>(`/sessions/${sessionId}/end`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function getSessionState(sessionId: string) {
  return request<SessionStateResponse>(`/sessions/${sessionId}/state`);
}

export async function getCheckpoints(sessionId: string) {
  const checkpoints = await request<
    Array<{ checkpoint_id: string; turn_index: number; summary: string; created_at: string }>
  >(`/sessions/${sessionId}/checkpoints`);

  return checkpoints.map((checkpoint) => ({
    checkpointId: checkpoint.checkpoint_id,
    turnIndex: checkpoint.turn_index,
    summary: checkpoint.summary,
    createdAt: checkpoint.created_at,
  }));
}

export async function requestCoaching(sessionId: string, windowTurns = 6) {
  return request<CoachingReportResponse>(`/sessions/${sessionId}/coach`, {
    method: "POST",
    body: JSON.stringify({
      window_turns: windowTurns,
    }),
  });
}

export async function rewindSession(sessionId: string, checkpointId: string) {
  return request<{ status: string; turn_index: number }>(`/sessions/${sessionId}/rewind`, {
    method: "POST",
    body: JSON.stringify({
      checkpoint_id: checkpointId,
    }),
  });
}
