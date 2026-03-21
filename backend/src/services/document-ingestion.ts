import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { cosineSimilarity, createHashedEmbedding, ensureDir, makeId, summarizeText, tokenize } from "../lib/utils.ts";
import type { DocumentChunk, RetrievedChunk } from "../types.ts";

function chunkText(text: string, chunkSize = 600, overlap = 120) {
  const normalized = text.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
  if (!normalized) {
    return [];
  }

  const chunks: string[] = [];
  let index = 0;
  while (index < normalized.length) {
    const chunk = normalized.slice(index, index + chunkSize).trim();
    if (chunk) {
      chunks.push(chunk);
    }
    if (index + chunkSize >= normalized.length) {
      break;
    }
    index += Math.max(1, chunkSize - overlap);
  }

  return chunks;
}

function extractPdfText(buffer: Buffer) {
  const raw = buffer.toString("latin1");
  const matches = Array.from(raw.matchAll(/\(([^()]*)\)/g)).map((match) => match[1]);
  const candidate = matches.join(" ").replace(/\\[nrt]/g, " ").replace(/\\\(/g, "(").replace(/\\\)/g, ")");
  return candidate.replace(/\s+/g, " ").trim();
}

async function parseFile(filePath: string) {
  const extension = path.extname(filePath).toLowerCase();
  const buffer = await readFile(filePath);
  if (extension === ".pdf") {
    return extractPdfText(buffer);
  }
  return buffer.toString("utf8");
}

export class DocumentIngestionService {
  private readonly uploadsDir: string;

  constructor(uploadsDir: string) {
    this.uploadsDir = uploadsDir;
  }

  async saveUpload(sessionId: string, fileName: string, base64: string) {
    const sessionDir = path.join(this.uploadsDir, sessionId);
    await ensureDir(sessionDir);
    const filePath = path.join(sessionDir, fileName);
    await writeFile(filePath, Buffer.from(base64, "base64"));
    return filePath;
  }

  async ingest(sessionId: string, fileName: string, filePath: string): Promise<DocumentChunk[]> {
    const text = await parseFile(filePath);
    const safeText = text || `${fileName} could not be parsed into rich text.`;
    const chunks = chunkText(safeText).slice(0, 24);

    return chunks.map((chunk, index) => ({
      chunkId: makeId("chunk"),
      sessionId,
      sourceFileName: fileName,
      text: chunk,
      embedding: createHashedEmbedding(chunk),
      metadata: {
        chunkIndex: index,
        tokenEstimate: tokenize(chunk).length,
        summary: summarizeText(chunk, 120)
      }
    }));
  }

  retrieve(chunks: DocumentChunk[], query: string, topK = 3): RetrievedChunk[] {
    const queryEmbedding = createHashedEmbedding(query);
    return chunks
      .map((chunk) => ({
        source: chunk.sourceFileName,
        snippet: summarizeText(chunk.text, 220),
        score: cosineSimilarity(queryEmbedding, chunk.embedding)
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, topK);
  }
}
