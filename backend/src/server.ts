import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { Buffer } from "node:buffer";
import { ensureDir, safeJsonParse } from "./lib/utils.ts";
import { SessionStore } from "./services/session-store.ts";
import { DocumentIngestionService } from "./services/document-ingestion.ts";
import { SessionOrchestrator } from "./services/session-orchestrator.ts";

const PORT = Number(process.env.PORT ?? 8787);
const DATA_DIR = path.resolve(process.cwd(), "data");
const store = new SessionStore(DATA_DIR);
const documentService = new DocumentIngestionService(path.join(DATA_DIR, "uploads"));
const orchestrator = new SessionOrchestrator(store, documentService, path.join(DATA_DIR, "audio"));

type SocketClient = {
  sessionId: string;
  socket: import("node:net").Socket;
};

const socketClients = new Map<string, Set<SocketClient>>();

function sendJson(res: ServerResponse, statusCode: number, payload: unknown) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(JSON.stringify(payload));
}

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? safeJsonParse(text) : {};
}

function parseSessionId(urlPath: string) {
  const match = urlPath.match(/^\/sessions\/([^/]+)(?:\/([^/]+))?$/);
  if (!match) {
    return null;
  }
  return {
    sessionId: match[1],
    action: match[2]
  };
}

function encodeFrame(payload: string) {
  const body = Buffer.from(payload);
  let header: Buffer;
  if (body.length < 126) {
    header = Buffer.from([0x81, body.length]);
  } else if (body.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  return Buffer.concat([header, body]);
}

function broadcast(sessionId: string, payload: unknown) {
  const clients = socketClients.get(sessionId);
  if (!clients) {
    return;
  }
  const frame = encodeFrame(JSON.stringify(payload));
  for (const client of clients) {
    client.socket.write(frame);
  }
}

function unmask(payload: Buffer, mask: Buffer) {
  const output = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    output[index] = payload[index] ^ mask[index % 4];
  }
  return output;
}

function attachWebSocket(req: IncomingMessage, socket: import("node:net").Socket) {
  const url = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
  const parts = url.pathname.split("/").filter(Boolean);
  const sessionId = parts[1];
  if (!sessionId || parts[0] !== "sessions" || parts[2] !== "stream") {
    socket.destroy();
    return;
  }

  const key = req.headers["sec-websocket-key"];
  if (!key || Array.isArray(key)) {
    socket.destroy();
    return;
  }

  const accept = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");

  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "\r\n"
    ].join("\r\n")
  );

  const client: SocketClient = { sessionId, socket };
  const set = socketClients.get(sessionId) ?? new Set<SocketClient>();
  set.add(client);
  socketClients.set(sessionId, set);

  void orchestrator.getState(sessionId)
    .then((session) => {
      broadcast(sessionId, {
        type: "session.ready",
        session_id: sessionId,
        state: sanitizeSession(session)
      });
    })
    .catch((error) => {
      broadcast(sessionId, { type: "error", session_id: sessionId, message: error.message });
    });

  let buffered = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 2) {
      const first = buffered[0];
      const second = buffered[1];
      const opcode = first & 0x0f;
      let offset = 2;
      let length = second & 0x7f;

      if (length === 126) {
        if (buffered.length < 4) {
          return;
        }
        length = buffered.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffered.length < 10) {
          return;
        }
        length = Number(buffered.readBigUInt64BE(2));
        offset = 10;
      }

      const masked = Boolean(second & 0x80);
      const required = offset + (masked ? 4 : 0) + length;
      if (buffered.length < required) {
        return;
      }

      const mask = masked ? buffered.subarray(offset, offset + 4) : undefined;
      const payloadStart = offset + (masked ? 4 : 0);
      const payload = buffered.subarray(payloadStart, payloadStart + length);
      buffered = buffered.subarray(required);

      if (opcode === 0x8) {
        socket.end();
        return;
      }

      if (opcode === 0x9) {
        socket.write(Buffer.from([0x8a, 0x00]));
        continue;
      }

      const data = masked && mask ? unmask(payload, mask).toString("utf8") : payload.toString("utf8");
      const event = safeJsonParse(data);
      if (!event) {
        continue;
      }
      void handleSocketEvent(sessionId, event);
    }
  });

  socket.on("close", () => {
    const clients = socketClients.get(sessionId);
    clients?.delete(client);
    if (clients && clients.size === 0) {
      socketClients.delete(sessionId);
    }
  });
}

function sanitizeSession(session: Awaited<ReturnType<typeof orchestrator.getState>>) {
  return {
    sessionId: session.sessionId,
    status: session.status,
    config: session.config,
    turns: session.turns,
    checkpoints: session.checkpoints.map((checkpoint) => ({
      checkpointId: checkpoint.checkpointId,
      turnIndex: checkpoint.turnIndex,
      summary: checkpoint.summary,
      createdAt: checkpoint.createdAt
    })),
    features: session.features,
    liveState: session.liveState,
    reports: session.reports
  };
}

async function handleSocketEvent(sessionId: string, event: any) {
  switch (event.type) {
    case "user.audio.chunk": {
      const liveState = await orchestrator.ingestAudioChunk(sessionId, {
        base64: event.base64
      });
      broadcast(sessionId, {
        type: "user.audio.received",
        session_id: sessionId,
        live_state: liveState
      });
      return;
    }
    case "user.transcript.partial": {
      await orchestrator.setPartialTranscript(sessionId, String(event.text ?? ""));
      broadcast(sessionId, {
        type: "user.transcript.partial",
        session_id: sessionId,
        turn_id: event.turn_id ?? null,
        text: String(event.text ?? ""),
        timestamp_ms: Date.now()
      });
      return;
    }
    case "user.transcript.final": {
      broadcast(sessionId, {
        type: "agent.thinking",
        session_id: sessionId
      });
      const result = await orchestrator.finalizeUserTranscript(sessionId, String(event.text ?? ""));
      if (!result.userTurn || !result.agentTurn || !result.checkpoint) {
        return;
      }
      broadcast(sessionId, {
        type: "user.transcript.final",
        session_id: sessionId,
        turn: result.userTurn
      });
      broadcast(sessionId, {
        type: "agent.response.text",
        session_id: sessionId,
        turn: result.agentTurn
      });
      broadcast(sessionId, {
        type: "agent.response.audio.end",
        session_id: sessionId,
        voice_profile: result.session.config.voiceProfile
      });
      broadcast(sessionId, {
        type: "session.checkpoint.created",
        session_id: sessionId,
        checkpoint: {
          checkpointId: result.checkpoint.checkpointId,
          turnIndex: result.checkpoint.turnIndex,
          summary: result.checkpoint.summary,
          createdAt: result.checkpoint.createdAt
        }
      });
      return;
    }
    default:
      broadcast(sessionId, {
        type: "error",
        session_id: sessionId,
        message: `Unsupported event type: ${String(event.type ?? "unknown")}`
      });
  }
}

const server = createServer(async (req, res) => {
  if (!req.url) {
    sendJson(res, 400, { error: "Missing URL" });
    return;
  }

  if (req.method === "OPTIONS") {
    sendJson(res, 200, { ok: true });
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  const sessionRoute = parseSessionId(url.pathname);

  try {
    if (req.method === "POST" && url.pathname === "/sessions") {
      const body = await readBody(req);
      const session = await orchestrator.createSession({
        situation_description: String(body?.situation_description ?? ""),
        partner_tone: String(body?.partner_tone ?? "neutral"),
        voice_profile: body?.voice_profile ?? {},
        mode: body?.mode ?? "balanced",
        coaching_focuses: Array.isArray(body?.coaching_focuses) ? body.coaching_focuses : []
      });
      sendJson(res, 201, { session_id: session.sessionId, status: session.status });
      return;
    }

    if (sessionRoute?.action === "documents" && req.method === "POST") {
      const body = await readBody(req);
      const files = Array.isArray(body?.files) ? body.files : [];
      const result = await orchestrator.uploadDocuments(sessionRoute.sessionId, files);
      sendJson(res, 200, result);
      return;
    }

    if (sessionRoute?.action === "start" && req.method === "POST") {
      const session = await orchestrator.startSession(sessionRoute.sessionId);
      sendJson(res, 200, { status: session.status });
      return;
    }

    if (sessionRoute?.action === "pause" && req.method === "POST") {
      const session = await orchestrator.pauseSession(sessionRoute.sessionId);
      broadcast(sessionRoute.sessionId, { type: "session.paused", session_id: sessionRoute.sessionId });
      sendJson(res, 200, { status: session.status });
      return;
    }

    if (sessionRoute?.action === "resume" && req.method === "POST") {
      const session = await orchestrator.resumeSession(sessionRoute.sessionId);
      broadcast(sessionRoute.sessionId, { type: "session.resumed", session_id: sessionRoute.sessionId });
      sendJson(res, 200, { status: session.status });
      return;
    }

    if (sessionRoute?.action === "coach" && req.method === "POST") {
      const body = await readBody(req);
      const report = await orchestrator.createCoachingReport(sessionRoute.sessionId, {
        windowTurns: body?.window_turns
      });
      sendJson(res, 200, {
        report_id: report.reportId,
        strengths: report.strengths,
        weak_signals: report.weakSignals,
        suggested_next_move: report.suggestedNextMove,
        retrieved_evidence: report.retrievedEvidence
      });
      return;
    }

    if (sessionRoute?.action === "rewind" && req.method === "POST") {
      const body = await readBody(req);
      const result = await orchestrator.rewindSession(sessionRoute.sessionId, String(body?.checkpoint_id ?? ""));
      broadcast(sessionRoute.sessionId, {
        type: "session.rewound",
        session_id: sessionRoute.sessionId,
        turn_index: result.turn_index,
        state: sanitizeSession(result.session)
      });
      sendJson(res, 200, { status: result.status, turn_index: result.turn_index });
      return;
    }

    if (sessionRoute?.action === "end" && req.method === "POST") {
      const session = await orchestrator.endSession(sessionRoute.sessionId);
      sendJson(res, 200, { status: session.status });
      return;
    }

    if (sessionRoute?.action === "state" && req.method === "GET") {
      const session = await orchestrator.getState(sessionRoute.sessionId);
      sendJson(res, 200, sanitizeSession(session));
      return;
    }

    if (sessionRoute?.action === "checkpoints" && req.method === "GET") {
      const checkpoints = await orchestrator.getCheckpoints(sessionRoute.sessionId);
      sendJson(res, 200, checkpoints.map((checkpoint) => ({
        checkpoint_id: checkpoint.checkpointId,
        turn_index: checkpoint.turnIndex,
        summary: checkpoint.summary,
        created_at: checkpoint.createdAt
      })));
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error";
    sendJson(res, 500, { error: message });
  }
});

server.on("upgrade", (req, socket) => {
  attachWebSocket(req, socket);
});

await ensureDir(DATA_DIR);
await store.init();

server.listen(PORT, () => {
  console.log(`Negotiation backend listening on http://localhost:${PORT}`);
});
