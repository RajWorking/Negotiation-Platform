import path from "node:path";
import { ensureDir, readJsonFile, writeJsonFile } from "../lib/utils.ts";
import type { SessionState } from "../types.ts";

export class SessionStore {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  private sessionFile(sessionId: string) {
    return path.join(this.baseDir, "sessions", `${sessionId}.json`);
  }

  async init() {
    await ensureDir(path.join(this.baseDir, "sessions"));
  }

  async save(session: SessionState) {
    session.updatedAt = new Date().toISOString();
    await writeJsonFile(this.sessionFile(session.sessionId), session);
    return session;
  }

  async get(sessionId: string) {
    const session = await readJsonFile<SessionState | null>(this.sessionFile(sessionId), null);
    return session;
  }
}
