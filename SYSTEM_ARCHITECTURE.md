# System Architecture

Technical reference for developers working on the Negotiation Platform.

---

## High-Level Overview

```
                          Browser (React / Vite)
                  ┌──────────────────────────────────┐
                  │  Setup Screen                    │
                  │    scenario, tone, mode,          │
                  │    voice selector (Kokoro),       │
                  │    coaching focuses, documents    │
                  │                                   │
                  │  Live Simulation                  │
                  │    MediaRecorder → audio chunks   │
                  │    ServerAudioPlayer (PCM)        │
                  │    Browser STT/TTS fallback       │
                  │    WebSocket ←→ backend           │
                  │    transcript, coaching, rewind   │
                  └──────────┬───────────────────────┘
                             │  REST + WebSocket
                             ▼
                  ┌──────────────────────────────────┐
                  │  FastAPI Application              │
                  │                                   │
                  │  Middleware                        │
                  │    CORS (configurable origins)     │
                  │    Rate limiting (slowapi)         │
                  │    API key auth (X-API-Key)        │
                  │                                   │
                  │  SessionOrchestrator (core loop)   │
                  │    PracticeAgent   → opponent AI   │
                  │    CoachingAgent   → feedback AI   │
                  │    SemanticAnalysis → multi-pass   │
                  │    FeatureExtraction → patterns    │
                  │    KeyMomentDetector → heuristics  │
                  │    DocumentIngestion → RAG         │
                  │    STTService → Faster-Whisper     │
                  │    TTSService → Kokoro-82M         │
                  └───┬──────────┬──────────┬─────────┘
                      │          │          │
              ┌───────▼──┐ ┌────▼────┐ ┌───▼──────┐
              │ LiteLLM  │ │ Storage │ │  Redis   │
              │ (any     │ │ Postgres│ │  pub/sub │
              │ provider)│ │ or File │ │(optional)│
              └──────────┘ └─────────┘ └──────────┘
```

---

## Frontend

### Stack

React 18, TypeScript, Vite 6, Tailwind CSS 4, Radix UI (shadcn), React Router 7, recharts, motion.

### Pages

**Setup Screen** (`components/setup-screen.tsx`): Form for scenario config — free-text description, opponent tone dropdown (9 personas + custom), coaching focus checkboxes, voice selector (Kokoro voice cards fetched from `/voices` endpoint with hardcoded fallback), quality mode slider (fast/balanced/quality), file upload for coaching documents. Persists draft to LocalStorage.

**Live Simulation** (`components/live-simulation.tsx`): WebSocket-connected session loop. On `session.ready`, reads server capabilities (`stt`, `tts`) to decide whether to use server-side or browser-native STT/TTS. Left panel: running transcript with speaker labels, key moment badges. Right sidebar: checkpoint list with rewind buttons, coaching report panel. Top bar: mode badge, heuristic mode indicator, pause/resume/end controls.

### Lib Modules

- `api.ts` — REST client functions (`createSession`, `startSession`, `requestCoaching`, `rewindSession`, etc.) + `websocketUrl()` builder + `sliderValueToMode()` converter
- `types.ts` — TypeScript interfaces: `Mode`, `ResponseSource`, `VoiceProfile`, `TranscriptTurn`, `CheckpointSummary`, `KeyMoment`, `CoachingReportResponse`, `SessionStateResponse`, `SetupDraft`
- `speech.ts` — Browser `SpeechRecognition` wrapper, `SpeechSynthesis` with voice scoring (browser TTS fallback), `createServerAudioPlayer()` for server TTS PCM playback via Web Audio API, `fileToBase64` for uploads
- `storage.ts` — LocalStorage helpers for setup draft and active session persistence

---

## Backend

### Module Map

```
app/
├── main.py                    FastAPI app, routes, WebSocket handler, startup/shutdown
├── orchestrator.py            Session lifecycle, turn processing core loop
├── agents.py                  PracticeAgent (opponent) + CoachingAgent (feedback)
├── llm_client.py              LiteLLM wrapper: chat_completion, embed, parse_json_object
├── analysis_orchestrator.py   Multi-pass LLM semantic analysis (signals → moments → review)
├── key_moment_detector.py     Regex-based key moment detection (heuristic fallback)
├── feature_extraction.py      Behavioral feature extraction from user turns
├── document_ingestion.py      RAG: upload (pypdf/python-docx/txt), chunk, embed, retrieve_async (coaching-only)
├── personas.py                9 negotiation partner persona templates
├── model_router.py            Mode → model/context_window/coaching_depth routing
├── stt_service.py             Server-side STT via Faster-Whisper (lazy-loaded)
├── tts_service.py             Server-side TTS via Kokoro-82M (lazy-loaded, streaming)
├── voice_map.py               Kokoro voicepack mapping + selectable voice list
├── storage.py                 FileSessionStore (dev) + PostgresSessionStore (prod)
├── database.py                PostgreSQL schema, asyncpg pool, JSONB codec
├── redis_manager.py           WebSocket ConnectionManager with optional Redis pub/sub
├── auth.py                    API key auth dependency factory
├── config.py                  Settings dataclass from env vars
├── schemas.py                 Pydantic models with camelCase aliases
└── utils.py                   IDs, timestamps, text helpers, hashed embeddings, cosine sim
```

### Core Loop — `SessionOrchestrator.finalize_user_transcript()`

This is the heart of the system. Called when the frontend sends a `user.transcript.final` WebSocket event:

1. **Record user turn** — create `ConversationTurn`, append to session
2. **Extract features** — `feature_extraction.extract_features()` scans all user turns for apology patterns, anchoring attempts, confidence/warmth/dominance cues, concessions, speaking rate
3. **Generate agent response** — `PracticeAgent.generate()`:
   - Builds persona-specific system prompt from `personas.py`
   - Sends recent history (context window sized by mode) to LLM
   - Parses JSON response `{reply_text, emotion_tags, intent}`
   - If LLM fails or leaks instructions → heuristic fallback classified by intent (counter/question/justify/pushback) with scenario-aware variants
4. **Detect key moments (heuristic)** — `key_moment_detector.detect_key_moments()` regex patterns for: first_anchor, strong_pushback, first_concession, emotional_escalation, agreement_frame_shift
5. **Semantic analysis** — `SemanticAnalysisOrchestrator.analyze()`:
   - **Pass 1**: Signal extraction — LLM identifies anchor/pushback/concession/escalation/agreement_shift/confidence/hesitation signals with turn_id, intensity, evidence
   - **Pass 2**: Key moment selection — LLM picks earliest best-supported moment per kind
   - **Pass 3** (quality mode only): Review — LLM validates proposed moments, filters unsupported ones
   - Falls back to heuristic moments if LLM returns empty
6. **Checkpoint** — snapshot full turn history + session state for rewind
7. **Broadcast** — send user turn, agent response, checkpoint, and key moments over WebSocket

### Agent System

Both agents follow the same pattern: LLM call → JSON parse → validate → fallback to heuristic.

**PracticeAgent** — opponent roleplay. The system prompt instructs the model to read the scenario and *embody* the counterparty role the user is negotiating with (e.g., "user is negotiating with a landlord" → agent IS the landlord). The selected partner tone is demoted to behavioral style guidance — it shapes HOW the agent speaks, not WHO it is. Each response includes `"source": "llm"` or `"source": "heuristic"`. Heuristic replies are intent-classified with scenario-specific variants (salary, rent, generic). The `_is_instruction_leak()` guard catches system-prompt regurgitation. **PracticeAgent never sees uploaded documents** — RAG is coaching-only by design.

**CoachingAgent** — strategic feedback. Takes recent turns, behavioral features, semantic analysis, key moments, and RAG evidence retrieved from uploaded documents. Returns `{strengths, weak_signals, suggested_next_move, retrieved_evidence}`. Heuristic fallback generates feedback from behavioral feature counts.

### Persona System

`personas.py` defines 9 tones, each with:
- `system_prompt` — character instructions for the LLM
- `style_tags` — emotion tags the persona uses
- `opener` — first line in character
- `challenge_style` — how this persona pushes back

Tones: aggressive, dismissive, neutral, cooperative, analytical, fearful, interviewer, landlord, partner. Unknown tones get a dynamically generated prompt with a logged warning.

### LLM Integration

`LLMClient` wraps LiteLLM. Provider-agnostic — any LiteLLM-supported provider works by setting the right env var and model string. The client:

- Checks `is_available` by scanning env vars: `HUGGINGFACE_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `AZURE_API_KEY`, `COHERE_API_KEY`, `REPLICATE_API_KEY`
- Handles `AuthenticationError`, `RateLimitError`, `Timeout` specifically (logs warning, returns `None`)
- `parse_json_object()` tolerates surrounding text in LLM output
- `embed()` has a dual path: when `EMBEDDING_MODEL` starts with `local/`, it lazy-loads a `sentence-transformers` model in-process (no API key required — e.g. `local/all-MiniLM-L6-v2` → 384-dim vectors on CPU/MPS). Any other value routes through LiteLLM's embedding API. This lets deployments use gateways that don't permit embedding models (e.g. the CMU AI Gateway) while still getting true semantic retrieval.

### Mode Routing

`model_router.route_mode()` maps the user's mode selection:

| Mode | Model | Context Window | Style | Coaching Depth |
|------|-------|----------------|-------|----------------|
| fast | gpt-5.4-nano | 4 turns | concise | 1-level |
| balanced | gpt-5.4-mini | 6 turns | balanced | 2-level |
| quality | gpt-5.4-pro | 10 turns | strategic | 3-level + review |

### Storage

**FileSessionStore** (dev): One JSON file per session in `data/sessions/`. Async `save()`/`get()` interface.

**PostgresSessionStore** (prod): Relational schema via `asyncpg`:

- `sessions` — metadata, config (JSONB), features (JSONB), live_state (JSONB)
- `turns` — with `is_archived` flag and `position` column (handles rewind)
- `checkpoints` — `transcript_snapshot` (JSONB array), `state_snapshot` (JSONB). Append-only.
- `key_moments` — delete-and-reinsert on each turn (rebuilt by semantic analysis)
- `coaching_reports` — append-only
- `document_chunks` — `embedding` (float array), append-only

The save strategy: session metadata uses upsert. Turns use `ON CONFLICT DO UPDATE` (rewind changes `is_archived`/`position`). Key moments are deleted and reinserted. Checkpoints, reports, and chunks use `ON CONFLICT DO NOTHING`.

### WebSocket Broadcasting

`ConnectionManager` tracks connections per session_id. Two modes:

- **Local** (no Redis): Direct `websocket.send_json()` to all connections for that session
- **Redis pub/sub**: Publish to `session:{id}` channel. Each backend instance runs a subscriber task per session that forwards messages to local connections.

Graceful degradation — if Redis is configured but goes down, falls back to local-only with a logged warning.

### RAG Pipeline

**Scope:** Uploaded documents feed the **CoachingAgent only**. The live `PracticeAgent` opponent never sees them — this keeps the roleplay authentic (the counterparty shouldn't know your prep notes).

1. **Upload** — base64 decode → save to `data/uploads/{session_id}/{filename}`
2. **Parse** — by extension:
   - `.pdf` → `pypdf.PdfReader` (page-by-page `extract_text()`)
   - `.docx` / `.doc` → `python-docx` (`Document(...).paragraphs`)
   - everything else → UTF-8 decode
3. **Chunk** — 600-char chunks, 120-char overlap, max 24 chunks per file
4. **Embed** — `LLMClient.embed()` via the dual path above (local sentence-transformers or LiteLLM). Fallback to deterministic 128-dim hashed embeddings only when both paths fail
5. **Retrieve (coaching)** — `retrieve_async()` is called from `orchestrator.coach()` with a query built by `_build_retrieval_query(session)`:
   - `Scenario: <situation_description>`
   - `Conversation summary: <semantic_analysis.summary>` (when populated by the background analysis pass)
   - `Conversation: <all user/agent turns>` truncated to 3500 chars, oldest-first drop so the most recent exchanges always survive
   - The query is embedded with the **same** model used for chunks (detected via chunk dimensionality — `128 or 0` → hashed, anything else → real). Top-k ranked by cosine similarity.
   - A sync `retrieve()` is kept for legacy/hashed-only paths but is no longer used by the orchestrator.

### Server-Side STT (Faster-Whisper)

`stt_service.py` wraps Faster-Whisper with lazy model loading. Per-session audio buffers accumulate webm chunks from the browser's MediaRecorder, convert to 16kHz mono PCM via PyAV (bundled with kokoro, no system ffmpeg needed), and transcribe with Whisper using Silero VAD for silence detection. `transcribe_chunk()` returns partial transcripts while speaking and final transcripts on silence. All blocking inference runs in `asyncio.to_thread()`. Configurable via `STT_MODEL_SIZE` (default `small`), `STT_DEVICE` (auto/cpu/cuda), `STT_COMPUTE_TYPE`.

### Server-Side TTS (Kokoro-82M)

`tts_service.py` wraps Kokoro with lazy loading and per-language pipeline caching. `synthesize()` is an async generator that splits text into sentences, synthesizes each via `asyncio.to_thread()`, converts float32 → int16 PCM at 24kHz, and yields chunks for streaming over WebSocket. `voice_map.py` maps `VoiceProfile.preset` to Kokoro voicepack IDs (e.g., `af_bella`, `bm_george`) with gender+accent fallback. The `/voices` endpoint returns a curated list of 10 selectable voices for the frontend.

### Auth & Rate Limiting

- `auth.py`: Factory `create_auth_dependency(api_key)` returns a FastAPI `Depends()`. If `API_KEY` env var is not set, returns a no-op (open access). If set, validates `X-API-Key` header on every request.
- `slowapi`: Attached to the app via `Limiter(key_func=get_remote_address)`. `create_session` is explicitly rate-limited; the default limit applies to all routes.

### Schemas

All Pydantic models use `alias_generator` for camelCase JSON serialization (`by_alias=True`). Key models:

- `SessionState` — top-level container: config, turns, checkpoints, key_moments, reports, document_chunks, features, semantic_analysis, archived_turns, live_state
- `SimulationConfig` — scenario description, partner tone, voice profile, mode, coaching focuses
- `ConversationTurn` — speaker, transcript, emotion tags, audio URI, timestamps, metadata
- `BehavioralFeatures` — apology frequency, concession indices, anchoring attempts, confidence/warmth/dominance cues, speaking rate
- `LiveState` — turn index, current speaker, audio stats, partial transcript, last checkpoint ID

---

## API Reference

### REST Endpoints

All require `X-API-Key` header when `API_KEY` is configured.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/sessions` | Create session (rate-limited) |
| `POST` | `/sessions/{id}/documents` | Upload coaching documents |
| `POST` | `/sessions/{id}/start` | Set status to live |
| `POST` | `/sessions/{id}/pause` | Pause session |
| `POST` | `/sessions/{id}/resume` | Resume session |
| `POST` | `/sessions/{id}/end` | End session |
| `POST` | `/sessions/{id}/coach` | Request coaching report |
| `POST` | `/sessions/{id}/rewind` | Rewind to checkpoint |
| `GET`  | `/sessions/{id}/state` | Full session state |
| `GET`  | `/sessions/{id}/checkpoints` | List checkpoints |
| `GET`  | `/voices` | List available TTS voices |
| `GET`  | `/health` | Status of LLM, STT, TTS, storage, Redis |

### WebSocket Protocol

`WS /sessions/{id}/stream`

**Client → Server:**

| Event | Payload | Triggers |
|-------|---------|----------|
| `user.audio.chunk` | `{base64}` | Audio saved to disk + fed to server STT (if enabled) |
| `user.audio.finalize` | `{}` | Force-finalize buffered STT audio |
| `user.transcript.partial` | `{text}` | Broadcast to all clients (browser STT fallback) |
| `user.transcript.final` | `{text}` | Full turn processing loop (browser STT fallback) |

**Server → Client:**

| Event | Payload | When |
|-------|---------|------|
| `session.ready` | `{state, capabilities}` | On WebSocket connect. `capabilities: {stt: bool, tts: bool}` |
| `user.audio.received` | `{live_state}` | After each audio chunk |
| `stt.transcript.partial` | `{text}` | Server STT partial transcription |
| `stt.transcript.final` | `{text}` | Server STT final transcription (triggers agent response) |
| `user.transcript.partial` | `{text}` | Relayed partial transcript (browser STT path) |
| `user.transcript.final` | `{turn}` | User turn recorded |
| `agent.thinking` | `{}` | Before agent generation — frontend stops the mic here so the user's voice isn't captured while the agent is preparing its reply |
| `agent.response.text` | `{turn, source}` | Agent reply ready |
| `agent.response.audio.chunk` | `{base64, format, sample_rate, sequence}` | Server TTS PCM audio chunk |
| `agent.response.audio.end` | `{}` | Signals all TTS chunks sent |
| `session.checkpoint.created` | `{checkpoint}` | After each turn pair |
| `session.key_moment.created` | `{key_moment}` | New key moment detected |
| `session.paused` | `{}` | Session paused |
| `session.resumed` | `{}` | Session resumed |
| `session.rewound` | `{turn_index, state}` | After rewind |
| `error` | `{message}` | On any error |

---

## Data Flow Diagrams

### Turn Processing

```
user.transcript.final
        │
        ▼
  Record user turn
        │
        ▼
  Extract behavioral features (regex)
        │
        ▼
  PracticeAgent.generate()
   ├── LLM call with persona prompt
   │    ├── Parse JSON response
   │    │    ├── Valid → use LLM reply
   │    │    └── Invalid / leak → heuristic fallback
   │    └── Error → heuristic fallback
   └── No API key → heuristic fallback
        │
        ▼
  Record agent turn
        │
        ▼
  Key moment detection (heuristic)
        │
        ▼
  SemanticAnalysisOrchestrator.analyze()
   ├── Pass 1: Signal extraction (LLM)
   ├── Pass 2: Key moment selection (LLM)
   ├── Pass 3: Review (quality mode only)
   └── Fallback: heuristic moments
        │
        ▼
  Create checkpoint (snapshot turns + state)
        │
        ▼
  Broadcast all events via WebSocket
```

### Coaching Request

```
POST /sessions/{id}/coach
        │
        ▼
  Get recent turns (window_turns parameter)
        │
        ▼
  RAG retrieval (retrieve_async)
   ├── Build query: scenario + semantic summary + full conversation (truncated to 3500 chars)
   ├── Embed query with the same model as chunks (local sentence-transformers or LiteLLM)
   ├── Cosine similarity against document chunk embeddings
   └── Return top-k snippets
        │
        ▼
  CoachingAgent.generate()
   ├── LLM prompt: turns + features + semantic analysis + key moments + evidence
   │    ├── Parse JSON → {strengths, weak_signals, suggested_next_move}
   │    └── Error → heuristic coaching from feature counts
   └── No API key → heuristic coaching
        │
        ▼
  Save report, pause session
```

---

## TODO — Not Yet Implemented

### Phase 2: RAG Sub-System
- [x] Replace basic PDF regex parser with `pypdf`
- [x] Support DOCX via `python-docx`
- [x] Async `retrieve_async()` with real embeddings for query vector (local `sentence-transformers` or LiteLLM)
- [ ] Support additional document formats (PPTX, HTML)
- [ ] Hybrid retrieval (BM25 + semantic)
- [ ] Chunk deduplication and overlap-aware merging

### STT/TTS Enhancements
- [x] Server-side STT via Faster-Whisper with VAD-based silence detection
- [x] Server-side TTS via Kokoro-82M with streaming PCM over WebSocket
- [x] Capability negotiation (`session.ready` → `capabilities`) with browser fallback
- [ ] STT fallback detection timeout (5s no server partial → switch to browser STT)
- [ ] TTS fallback detection timeout (2s no audio chunk → switch to browser TTS)
- [ ] Voice preview playback on setup screen

### Deployment
- [ ] Dockerfile and docker-compose.yml
- [ ] CI/CD pipeline (GitHub Actions)
- [ ] Alembic migrations (replace apply-on-startup schema)
- [ ] Structured JSON logging
- [ ] Horizontal scaling docs (load balancer + Redis pub/sub)

### Session Management
- [ ] Session listing and deletion endpoints
- [ ] Session TTL / expiry cleanup
- [ ] Multi-user auth (OAuth / JWT)
- [ ] Session sharing and replay

### Coaching
- [ ] Cross-session progress tracking
- [ ] Custom coaching prompt templates
- [ ] Export reports (PDF / Markdown)

### Frontend
- [ ] Session history page
- [ ] Visual analytics dashboard (behavioral feature charts)
- [ ] Mobile-responsive layout
- [ ] Accessibility audit

### Testing
- [ ] Integration tests with real PostgreSQL (testcontainers)
- [ ] WebSocket integration tests
- [ ] Frontend component tests (Vitest)
- [ ] E2E tests (Playwright)
- [ ] Load testing for WebSocket concurrency
