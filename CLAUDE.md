# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Voice-enabled negotiation roleplay coaching platform. Users configure a scenario, then practice negotiating against an AI opponent while receiving real-time coaching feedback. Stack: **Python/FastAPI backend** with server-side STT/TTS + **React/Vite frontend**.

## Commands

### Python Backend
```bash
# Setup
python3 -m venv .venv
source .venv/bin/activate
pip install -r python_backend/requirements.txt

# Run (from repo root)
uvicorn python_backend.app.main:app --reload --port 8000

# Tests
python -m unittest python_backend.tests.test_orchestrator -v
```

### Frontend
```bash
cd frontend
npm install
npm run dev        # Vite dev server on :5173, proxies /sessions to localhost:8000
npm run build      # Production build
```

### Environment Files
```bash
cp python_backend/.env.example python_backend/.env   # LLM keys, STT/TTS, DB, Redis
cp frontend/.env.example frontend/.env               # VITE_API_BASE_URL
```

Key env vars: `OPENAI_API_KEY` (or `HUGGINGFACE_API_KEY`, `ANTHROPIC_API_KEY`), `GEMINI_API_KEY` (enables emotion-aware Gemini TTS in quality mode), `LLM_MODEL_FAST/BALANCED/QUALITY` (LiteLLM format), `STT_ENABLED`, `TTS_ENABLED`, `PIPER_VOICES_DIR` (path to Piper ONNX voice models, default `python_backend/data/piper_voices/`), `DATABASE_URL` (PostgreSQL, optional), `REDIS_URL` (optional).

## Architecture

### Backend (`python_backend/app/`)

FastAPI app (`main.py`) with REST endpoints, a WebSocket for live sessions, and optional server-side speech services.

**Core flow:** `main.py` → `SessionOrchestrator` → agents/services

#### Session & Orchestration
- **`orchestrator.py`** — Central coordinator. Manages session lifecycle (create/start/pause/resume/end), processes user transcripts, triggers agent responses, creates checkpoints, runs coaching, and coordinates STT/TTS. Passes mode-based routing config to STT calls (`model_size`, `beam_size`) and TTS calls (`speed`, `engine`) via `route_mode()`. All session mutations go through here. `finalize_user_transcript()` accepts an optional `on_progress` callback for broadcasting status updates and returns both clean transcript text and raw tagged text (`agent_tts_text`) — emotion tags like `[firm]` are stripped from `ConversationTurn.transcript` but preserved in `agent_tts_text` for Gemini TTS and extracted into `ConversationTurn.emotion_tags`. Semantic analysis runs separately via `run_background_analysis()` (called as an `asyncio.create_task` from `main.py`) so agent responses are not blocked by it.
- **`schemas.py`** — All Pydantic models. Uses camelCase aliases (`Field(alias="sessionId")`) with `populate_by_name=True` so both snake_case and camelCase work.
- **`config.py`** — Frozen `Settings` dataclass reading all configuration from env vars.

#### AI Agents & LLM
- **`agents.py`** — `PracticeAgent` (generates opponent dialogue) and `CoachingAgent` (produces coaching reports with strengths/weaknesses/suggestions). Both call `LLMClient`. The `CoachingAgent` system prompt explicitly specifies the JSON schema and forbids markdown/code fences to ensure parseable output. Both agents fall back to heuristic responses when the LLM is unavailable or returns unparseable output; the heuristic coaching fallback currently uses only behavioral feature counters (not conversation turns). When `routing["tts_engine"] == "gemini"` (quality mode), the `PracticeAgent` system prompt includes instructions for inline emotion tags (`[firm]`, `[calm]`, `[excited]`, etc.) that are passed through to Gemini TTS for expressive speech synthesis.
- **`llm_client.py`** — LiteLLM wrapper providing `chat_completion`, `embed`, and `parse_json_object`. `parse_json_object` strips markdown code fences (` ```json ... ``` `) before attempting JSON extraction, since LLMs frequently wrap JSON responses in fences despite instructions not to. Supports any LiteLLM provider (OpenAI, Anthropic, HuggingFace, etc.). Falls back to heuristic agents when no API keys are configured. `litellm.drop_params = True` is set so unsupported parameters (e.g., `temperature` on gpt-5 models) are silently dropped instead of causing errors.
- **`model_router.py`** — Maps mode (`fast`/`balanced`/`quality`) to model name, context window size, coaching depth, STT config (`stt_model_size`, `stt_beam_size`), TTS speed (`tts_speed`), and TTS engine (`tts_engine`: `"piper"` for fast, `"kokoro"` for balanced, `"gemini"` for quality). Models configurable via env vars.
- **`personas.py`** — 9 built-in negotiation partner persona templates (e.g., aggressive, collaborative) plus custom.

#### Analysis & Coaching
- **`analysis_orchestrator.py`** — Multi-pass semantic analysis: signal extraction → key moment selection → (quality mode) review pass. LLM-driven with heuristic fallback.
- **`feature_extraction.py`** — Extracts behavioral features (apologies, anchoring, concessions, confidence cues) from conversation turns.
- **`key_moment_detector.py`** — Heuristic detection of negotiation milestones (first anchor, pushback, concession, escalation, agreement shift).
- **`document_ingestion.py`** — Upload parsing (PDF via `pypdf`, DOCX via `python-docx`, plain text otherwise), deterministic chunking, and embeddings for uploaded documents. Two retrieval paths: `retrieve()` (sync, hashed-only — fallback/tests) and `retrieve_async()` (embeds the query with the real LLM model when chunks were embedded with it, otherwise hashed). Coaching uses `retrieve_async()`. Documents feed the `CoachingAgent` only — the live `PracticeAgent` does not see them by design.

#### Speech Services
- **`stt_service.py`** — Server-side speech-to-text via Faster-Whisper. Mode-aware: caches multiple Whisper model sizes (e.g., `tiny` for fast mode, `small` for balanced/quality) in `self._models` dict, keyed by model size string. `beam_size` is also per-mode (1 for fast, 3 for others). Both params are passed from the orchestrator via `route_mode()`. Lazy-loaded, with per-session audio buffering and VAD. Disabled when `STT_ENABLED=false` (clients fall back to browser SpeechRecognition).
- **`tts_service.py`** — Server-side text-to-speech with tri-engine support: **Gemini TTS** (24 kHz, quality mode — emotion-aware via inline tags), **Kokoro-82M** (24 kHz, balanced mode), and **Piper TTS** (22.05 kHz, fast mode). All engines use sentence-level streaming via `queue.Queue` in a background thread. The `synthesize()` async generator yields `(pcm_bytes, sample_rate)` tuples so callers get the correct rate per engine. Accepts `engine` parameter (`"gemini"`, `"kokoro"`, or `"piper"`) and `speed` (Kokoro only). Fallback chain: `gemini → kokoro → piper`. Gemini TTS uses the native `google-genai` SDK (`genai.Client().models.generate_content()` with `response_modalities=["AUDIO"]`), NOT LiteLLM. Gemini returns full audio per call (not streamed), so text is split into sentences and each is synthesized separately to preserve the sentence-level streaming pattern. All engines are eagerly initialized at server startup to avoid blocking WebSocket connections. Disabled when `TTS_ENABLED=false` (clients fall back to browser SpeechSynthesis). Piper voice models (ONNX) live in `piper_voices_dir` (default: `python_backend/data/piper_voices/`) and are auto-downloaded on first use if missing.
- **`voice_map.py`** — Kokoro voicepack mapping, selectable voice list (served via `GET /voices`), a `PIPER_VOICE_MAP` dict that maps each Kokoro voice ID to its closest Piper equivalent by gender+accent, and a `GEMINI_VOICE_MAP` dict that maps Kokoro voice IDs to Gemini voice names (e.g., `af_bella` → `Kore`, `am_adam` → `Charon`). `resolve_piper_voice()` and `resolve_gemini_voice()` perform the mappings; users always select Kokoro voices in the UI.

#### Storage & Infrastructure
- **`storage.py`** — Dual-mode: `FileSessionStore` (dev, JSON under `python_backend/data/`) or `PostgresSessionStore` (prod, via asyncpg).
- **`database.py`** — PostgreSQL schema, asyncpg connection pool, JSONB codec. Used when `DATABASE_URL` is set.
- **`redis_manager.py`** — WebSocket `ConnectionManager` with optional Redis pub/sub for multi-instance broadcasting. Falls back to local-only when `REDIS_URL` is not set.
- **`auth.py`** — API key authentication dependency. Active when `API_KEY` env var is set; all endpoints require `X-API-Key` header.

### REST Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/sessions` | Create session |
| POST | `/sessions/{id}/documents` | Upload documents for RAG |
| POST | `/sessions/{id}/start` | Start session |
| POST | `/sessions/{id}/pause` | Pause session |
| POST | `/sessions/{id}/resume` | Resume session |
| POST | `/sessions/{id}/coach` | Request coaching report |
| POST | `/sessions/{id}/rewind` | Rewind to checkpoint |
| POST | `/sessions/{id}/end` | End session |
| GET | `/sessions/{id}/state` | Get session state |
| GET | `/sessions/{id}/checkpoints` | List checkpoints |
| GET | `/voices` | List available TTS voices |
| GET | `/health` | Service health (LLM, STT, TTS, storage, Redis) |

### WebSocket Protocol

Endpoint: `/sessions/{id}/stream`

**Server → Client events:**
- `session.ready` — Initial state + capabilities (`{stt: bool, tts: bool}`)
- `user.audio.received` — Acknowledges audio chunk with live state
- `stt.transcript.partial` / `stt.transcript.final` — Server STT results
- `user.transcript.partial` / `user.transcript.final` — Echo of browser-STT text
- `agent.thinking` — Agent is generating response
- `agent.status` — Granular processing phase updates (`{phase: "generating_response" | "synthesizing_speech"}`) shown in the UI status badge during the thinking state
- `agent.response.text` — Agent turn with transcript and source (`llm`/`heuristic`)
- `agent.response.audio.chunk` — PCM audio chunk (base64, pcm_s16le, dynamic sample_rate: 22050 Hz for Piper/fast mode, 24000 Hz for Kokoro/balanced and Gemini/quality)
- `agent.response.audio.end` — TTS stream complete
- `session.checkpoint.created` — New checkpoint
- `session.key_moment.created` — Detected negotiation milestone (may arrive asynchronously after agent response, from background analysis)
- `session.paused` / `session.resumed` / `session.rewound` — Lifecycle events

**Client → Server events:**
- `user.audio.chunk` — Raw PCM audio (base64, 16kHz mono int16)
- `user.audio.finalize` — Force STT finalization of buffered audio
- `user.transcript.partial` — Browser STT interim text
- `user.transcript.final` — Browser STT final text (fallback path)

### Frontend (`frontend/src/app/`)

Vite + React 18 with React Router 7, Tailwind CSS v4, shadcn/ui (Radix primitives), Recharts, and Motion.

- **`routes.tsx`** — Two routes: `/` (SetupScreen) and `/simulation` (LiveSimulation).
- **`components/setup-screen.tsx`** — Scenario configuration: description, partner tone (9 personas + custom), voice selector (server-fetched Kokoro voices), quality mode slider, coaching focus checkboxes, document upload. Persists draft to LocalStorage.
- **`components/live-simulation.tsx`** — Live negotiation UI: WebSocket connection, running transcript with speaker labels and key moment badges, checkpoint sidebar with rewind, coaching report panel, pause/resume/end controls. Handles both server STT/TTS and browser fallbacks based on server capabilities. Displays granular processing status via `thinkingPhase` state (driven by `agent.status` WebSocket events) — the status badge shows "Generating response…" / "Converting to speech…" instead of a generic "Thinking".
- **`components/ui/`** — shadcn/ui primitives (do not manually edit these).

**Frontend lib (`frontend/src/app/lib/`):**
- **`api.ts`** — REST client and `websocketUrl` builder.
- **`types.ts`** — TypeScript interfaces for all API types (sessions, turns, checkpoints, key moments, coaching reports, voices).
- **`speech.ts`** — `createPcmMicCapture()` (16kHz mono PCM), `createSpeechRecognition()` (browser STT), `speakWithBrowserVoice()` (browser TTS with voice matching), `createServerAudioPlayer()` (Web Audio API PCM playback for server TTS).
- **`storage.ts`** — LocalStorage helpers for setup drafts and active session snapshots.

## Mode Routing Summary

All mode-dependent behavior is centralized in `model_router.py:route_mode()`. The orchestrator calls this with the session's mode and threads the config to each subsystem.

| Parameter | fast | balanced | quality |
|-----------|------|----------|---------|
| **LLM model** | gpt-5.4-nano | gpt-5.4-mini | gpt-5.4-mini |
| **Context window** (turns) | 4 | 6 | 10 |
| **Agent temperature** | 0.3 | 0.3 | 0.5 |
| **Analysis passes** | 2 | 2 | 3 (+ validation) |
| **STT model** | tiny | small | small |
| **STT beam_size** | 1 | 3 | 3 |
| **TTS engine** | Piper (22.05 kHz) | Kokoro (24 kHz) | Gemini (24 kHz, emotion tags) |
| **TTS speed** | 1.2 | 1.0 | 1.0 |
| **Coaching depth** | 1 | 2 | 3 |
| **Emotion tags** | No | No | Yes (`[firm]`, `[calm]`, `[excited]`, etc.) |

## Key Conventions

- Pydantic models use camelCase aliases for JSON serialization and snake_case for Python access.
- Session data persists as JSON files in `python_backend/data/` (dev) or PostgreSQL (prod); uploaded docs go to `python_backend/data/uploads/`.
- IDs are prefixed strings: `sess_`, `turn_`, `ckpt_`, `coach_` (generated by `utils.make_id`).
- LLM calls go through LiteLLM (`llm_client.py`), supporting any provider via standard env vars.
- STT and TTS are optional server features with automatic browser fallbacks.
- The `agents.py` module falls back to heuristic responses when no LLM API keys are available.
- LLM JSON responses are sanitized before being passed to Pydantic models — e.g., `retrieved_evidence` items that arrive as strings (instead of `{"source", "snippet"}` dicts) are normalized in `orchestrator.py`.
- `CoachingReport` includes a `source` field (`"llm"` or `"heuristic"`) piped from `agents.py` through `orchestrator.py` and `main.py` to the frontend, where it controls the "LLM unavailable" indicator badge.

## Development Practices

- **Always use the venv**: All Python commands (tests, server, pip) must run inside `source .venv/bin/activate`.
- **Frontend type-checking**: No standalone `tsc` binary; use `npm run build` (Vite build) to verify there are no type errors.
- **Testing changes**: After modifying backend, run `source .venv/bin/activate && python -m unittest python_backend.tests.test_orchestrator -v`. After modifying frontend, run `cd frontend && npm run build`.

### LLM JSON Integration Patterns

When adding or modifying LLM calls that expect structured JSON:

- **System prompts must include the exact JSON schema** with field types and example structure. Vague instructions like "return JSON with keys X, Y" lead to unparseable responses. Explicitly state "NO markdown, NO code fences, respond with ONLY the JSON object."
- **Token budgets**: Set `max_tokens` with headroom. A JSON response with 3 arrays of 3 strings each + a paragraph string needs ~300-400 tokens; use 500 to avoid truncation. Truncated JSON silently falls back to heuristic without user-visible errors.
- **Sanitize LLM output before Pydantic**: LLMs may return fields in unexpected formats (e.g., strings instead of dicts in an array). Normalize in the orchestrator layer before constructing Pydantic models — don't rely on the LLM matching the schema exactly.
- **`parse_json_object()`** handles code fences and surrounding text, but test with the actual model being used — different models have different formatting tendencies.
- **Always pipe `source` fields through**: When an agent returns `"llm"` or `"heuristic"` source indicators, ensure they survive through the Pydantic model → REST endpoint → frontend chain so the UI can display the correct provenance.

## Speech Turn Lifecycle (Critical Path)

Understanding how user speech becomes an agent response is essential for debugging latency, turn-cutting, and transcript issues.

### Two STT Paths

1. **Server STT (default)**: `STT_ENABLED` defaults to `true`. When available, `startInputLoop` sends raw PCM audio via `user.audio.chunk` and returns early — browser SpeechRecognition is **never started**. Transcription happens server-side via Faster-Whisper in `stt_service.py`.

2. **Browser STT (fallback)**: Only used when server STT is unavailable. Uses Web Speech API (`recognition.continuous = true`). The browser marks results as `isFinal` after ~500ms of silence (browser-dependent, not configurable). The frontend debounces these with a 2-second accumulation buffer (`finalizedBufferRef` + `turnFinalizeTimerRef` in `live-simulation.tsx`) before sending `user.transcript.final`.

### Server STT Finalization Chain

Audio chunks → `stt_service.py` VAD (silence threshold: `_SILENCE_THRESHOLD_S = 1.5s`) → Whisper transcription every `_PARTIAL_INTERVAL_S = 1.0s` → stable count check (`_STABLE_COUNT_FOR_FINAL = 2`, meaning text must be unchanged for ~2 consecutive checks) → `is_final=True` → `main.py` immediately calls `orchestrator.finalize_user_transcript()` → agent response generated.

**Total latency from silence to agent response**: ~2.5s (1.5s VAD + ~2s stable count). These thresholds are in `stt_service.py` lines 12-17. Be careful stacking additional delays — the silence detection layers compound.

### Browser STT Finalization Chain

Browser fires `isFinal` (~500ms silence) → text pushed to `finalizedBufferRef` → 2-second debounce timer resets → timer fires → `flushTurnBuffer()` sends `user.transcript.final` → `main.py` calls `orchestrator.finalize_user_transcript()` → agent response.

### Response Pipeline (Backend)

`finalize_user_transcript()` is the fast path — it generates the agent reply and returns immediately without waiting for semantic analysis:

1. Record user turn → emit `agent.status` (`"generating_response"`) via `on_progress` callback
2. `await practice_agent.generate()` — LLM call (2-10s), the main latency source
3. Record agent turn, run heuristic key moment detection, create checkpoint, save
4. Return result → `main.py` broadcasts `agent.response.text` + TTS audio immediately

TTS uses true sentence-level streaming: `tts_service.py` runs synthesis (Piper in fast mode, Kokoro in balanced, Gemini in quality) in a background thread that pushes each sentence's PCM audio into a `queue.Queue`. The async generator in `synthesize()` polls the queue and yields `(chunk, sample_rate)` tuples immediately — `main.py`'s broadcast loop sends each chunk with its dynamic sample rate to the client as it arrives. In quality mode, `main.py` passes `agent_tts_text` (raw text with emotion tags) to TTS instead of the clean transcript, so Gemini receives tags like `[firm]` and `[calm]` for expressive synthesis. The frontend's `createServerAudioPlayer` plays chunks immediately via `feedChunk(base64, sampleRate)`, handling the rate difference between engines transparently.

Semantic analysis (`analysis_orchestrator.py`) runs as `asyncio.create_task(_run_and_broadcast_analysis(...))` after the agent response is already streaming to the client. It broadcasts `session.key_moment.created` events when complete. This decoupling means the user hears the agent ~2-10s sooner than if analysis blocked the response.

There are **no intentional delays** (`asyncio.sleep` / `time.sleep`) anywhere in the response pipeline. All latency is from LLM inference and TTS synthesis.

### Turn Controls

- **Automatic**: Both paths auto-finalize after sufficient silence (no user action needed).
- **"Done Speaking" button**: Immediately flushes the browser STT buffer and sends `user.audio.finalize` for server STT, bypassing all silence timers.
- **`stopInputLoop`**: Flushes any buffered transcript before tearing down audio/recognition (called on pause, end, and before agent speaks).

### Backend Safety Net

`orchestrator.finalize_user_transcript()` merges `session.live_state.partial_transcript` with the incoming final text if the partial contains content not already in the final text. This prevents lost fragments if finalization text is incomplete.
