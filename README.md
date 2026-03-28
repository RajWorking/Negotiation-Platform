# Negotiation-Platform

Voice-enabled roleplay coaching prototype with a React frontend and a Python/FastAPI backend.

## What’s implemented

- Session setup with scenario, opponent tone, coaching focuses, voice profile, document upload, and fast/balanced/quality routing.
- File-backed backend APIs for session lifecycle, coaching, checkpoints, rewind, and session state.
- WebSocket live loop for audio chunk receipt, partial/final transcript events, agent response events, and checkpoint updates.
- Retrieval-augmented coaching using deterministic chunking, hashed embeddings, and per-session document search.
- Browser speech-recognition and speech-synthesis fallback so the prototype works locally without external STT/TTS providers.

## Repo layout

- `frontend/`: existing Vite/React UI, now wired to real APIs and websocket events.
- `python_backend/`: FastAPI backend with orchestration, Hugging Face-hosted open-source model routing, persistence, coaching, checkpointing, and tests.
- `backend/`: earlier Node prototype retained as a local reference.

## Environment

Before running the copy commands below, make sure you have your `HF_TOKEN` (Hugging Face access token) ready. After copying, open the `.env` file and add your token.

Python backend:

```bash
cp python_backend/.env.example python_backend/.env
```

Frontend:

```bash
cp frontend/.env.example frontend/.env
```

## Run locally

1. Start the backend:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r python_backend/requirements.txt
uvicorn python_backend.app.main:app --reload --port 8000
```

2. Start the frontend in a second terminal:

```bash
cd frontend
npm install
npm run dev
```

3. Open the Vite app, configure a scenario, and start the simulation.

## Notes

- The frontend proxies `/sessions` to `http://localhost:8000` in dev.
- Uploaded documents are stored under `python_backend/data/`.
- The FastAPI backend routes live and coaching generation through Hugging Face-hosted open-source chat models when `HF_TOKEN` is set.
- Default mode routing is `google/gemma-2-2b-it` for `fast` and `Qwen/Qwen2.5-7B-Instruct` for both `balanced` and `quality`. `quality` still behaves differently through deeper prompting and wider context. Override them in `python_backend/.env`.
- If the Hugging Face router rejects a configured model or returns any HTTP error, the backend now logs that response and falls back to the local heuristic agents instead of crashing the websocket session.
- Rewind discards later turns from the active branch and archives them in session storage for debugging.
- Live transcription currently relies on browser `SpeechRecognition`; if the browser does not support it, audio still reaches the backend but transcript generation will not run.

## Tests

Python backend tests cover:

- session creation persistence
- coaching response schema
- rewind restoration

Run them with:

```bash
source .venv/bin/activate
python -m unittest python_backend.tests.test_orchestrator
```
