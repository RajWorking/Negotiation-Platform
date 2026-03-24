import type { ActiveSessionSnapshot, SetupDraft } from "./types";

const DRAFT_KEY = "negotiation-platform.setup-draft.v1";
const ACTIVE_SESSION_KEY = "negotiation-platform.active-session.v1";

export function loadSetupDraft(): SetupDraft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    return raw ? (JSON.parse(raw) as SetupDraft) : null;
  } catch {
    return null;
  }
}

export function saveSetupDraft(draft: SetupDraft) {
  localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
}

export function clearSetupDraft() {
  localStorage.removeItem(DRAFT_KEY);
}

export function saveActiveSession(session: ActiveSessionSnapshot) {
  sessionStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify(session));
}

export function loadActiveSession() {
  try {
    const raw = sessionStorage.getItem(ACTIVE_SESSION_KEY);
    return raw ? (JSON.parse(raw) as ActiveSessionSnapshot) : null;
  } catch {
    return null;
  }
}

export function clearActiveSession() {
  sessionStorage.removeItem(ACTIVE_SESSION_KEY);
}
