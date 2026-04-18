# Negotiation Platform

A voice-enabled AI roleplay coaching tool. Practice negotiation scenarios against configurable AI opponents, get real-time behavioral feedback, and receive strategic coaching grounded in your uploaded reference documents.

## What You Can Do

- **Set up a scenario**: Describe any negotiation situation in plain text
- **Pick an opponent tone**: Aggressive, dismissive, cooperative, analytical, fearful, and more (9 built-in + custom)
- **Choose coaching focuses**: Anchoring & Numbers, Persuasion, Confidence, Emotional Control, Power Dynamics, Domain Expertise
- **Upload reference documents**: PDFs, text files — the coaching agent uses them as evidence
- **Select quality mode**: Fast (quick responses), Balanced (default), Quality (deeper analysis with review pass)
- **Select a voice**: Choose from curated Kokoro TTS voices (e.g., Bella, Adam, Emma, George) with server-side synthesis
- **Practice live**: Speak naturally — server-side Faster-Whisper transcribes your words and the AI responds in character
- **Get coached**: Request on-demand coaching reports with strengths, weak signals, and a suggested next move
- **Rewind**: Jump back to any checkpoint and try a different approach

## Setup

### Prerequisites

- Python 3.10+
- Node.js 18+
- At least one LLM API key (OpenAI, Anthropic, or HuggingFace)

### Backend

```bash
cp python_backend/.env.example python_backend/.env
```

Open `python_backend/.env` and add your API key. The default models use OpenAI (via the CMU AI Gateway), so set `OPENAI_API_KEY`. If you prefer Anthropic or HuggingFace, change the `LLM_MODEL_*` values and set the corresponding key instead.

Without any API key, the platform still works — it falls back to rule-based heuristic responses (the UI shows an amber "Heuristic mode" badge).

### Frontend

```bash
cp frontend/.env.example frontend/.env
```

Default points to `http://localhost:8000`. Change `VITE_API_BASE_URL` if your backend runs elsewhere.

## Run Locally

1. Start the backend:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r python_backend/requirements.txt
uvicorn python_backend.app.main:app --reload --port 8000
```

2. Start the frontend (second terminal):

```bash
cd frontend
npm install
npm run dev
```

3. Open the Vite dev server URL, configure a scenario, and start the simulation.

### Optional: PostgreSQL and Redis

For production-like storage and multi-instance WebSocket support:

```bash
docker run -d --name pg -e POSTGRES_PASSWORD=secret -p 5432:5432 postgres:16
docker run -d --name redis -p 6379:6379 redis:7
```

Then add to your `.env`:

```
DATABASE_URL=postgresql://postgres:secret@localhost:5432/postgres
REDIS_URL=redis://localhost:6379
```

Without these, the backend uses file-based storage and in-process WebSocket broadcasting — fine for local development.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | At least one LLM key | OpenAI API key |
| `OPENAI_API_BASE` | No | Custom base URL (default: `https://ai-gateway.andrew.cmu.edu`) |
| `ANTHROPIC_API_KEY` | | Anthropic API key (alternative provider) |
| `HUGGINGFACE_API_KEY` | | HuggingFace API key (alternative provider) |
| `DATABASE_URL` | No | PostgreSQL connection string |
| `REDIS_URL` | No | Redis connection string |
| `API_KEY` | No | Enables `X-API-Key` header auth on all endpoints |
| `ALLOWED_ORIGINS` | No | CORS origins (default: `http://localhost:5173,http://localhost:3000`) |
| `RATE_LIMIT` | No | Request rate limit (default: `30/minute`) |
| `LLM_MODEL_FAST` | No | Model for fast mode (default: `openai/gpt-5.4-nano`) |
| `LLM_MODEL_BALANCED` | No | Model for balanced mode (default: `openai/gpt-5.4-mini`) |
| `LLM_MODEL_QUALITY` | No | Model for quality mode (default: `openai/gpt-5.4-pro`) |
| `EMBEDDING_MODEL` | No | Embedding model for RAG (default: `openai/text-embedding-3-small`) |
| `STT_ENABLED` | No | Enable server-side STT (default: `true`) |
| `STT_MODEL_SIZE` | No | Faster-Whisper model size (default: `small`) |
| `STT_DEVICE` | No | STT device: `auto`, `cpu`, or `cuda` (default: `auto`) |
| `STT_COMPUTE_TYPE` | No | CTranslate2 compute type (default: `auto`) |
| `TTS_ENABLED` | No | Enable server-side TTS (default: `true`) |
| `TTS_DEVICE` | No | TTS device: `auto`, `cpu`, or `cuda` (default: `auto`) |

## Tests

```bash
source .venv/bin/activate
python -m unittest python_backend.tests.test_orchestrator -v
```

## Browser Requirements

By default, transcription and voice synthesis run server-side (Faster-Whisper for STT, Kokoro for TTS). Any modern browser with microphone access works.

If server STT/TTS is disabled, the frontend falls back to browser-native Web Speech APIs (`SpeechRecognition` for STT, `SpeechSynthesis` for TTS). Browser STT works best in Chrome and Edge.

## Architecture

See [SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md) for the full technical design, data flow, API reference, and developer-facing details.
