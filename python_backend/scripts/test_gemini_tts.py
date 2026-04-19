from __future__ import annotations

import asyncio
import base64
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

_env_path = Path(__file__).resolve().parents[1] / ".env"
load_dotenv(_env_path, override=True)

import litellm

litellm.suppress_debug_info = True
litellm.set_verbose = False

MODELS = [
    "gemini/gemini-2.5-flash-preview-tts",
    "gemini/gemini-2.5-pro-preview-tts",
]

TEST_PROMPT = "Say 'hello, this is a test of Gemini text to speech' in a friendly voice."

AUDIO_CONFIG = {"voice": "Kore", "format": "pcm16"}

API_KEY = os.getenv("OPENAI_API_KEY")
API_BASE = os.getenv("OPENAI_API_BASE")

OUTPUT_DIR = Path(__file__).resolve().parent / "tts_output"


def save_audio(model: str, audio_bytes: bytes) -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    safe_name = model.split("/")[-1]
    out_path = OUTPUT_DIR / f"{safe_name}.pcm"
    out_path.write_bytes(audio_bytes)
    print(f"  Saved: {out_path}")
    print(f"  Play with: ffplay -f s16le -ar 24000 -ac 1 {out_path}")
    print(f"  Convert:   ffmpeg -f s16le -ar 24000 -ac 1 -i {out_path} {out_path.with_suffix('.wav')}")


async def test_model(model: str) -> bool:
    print(f"\n{'=' * 60}")
    print(f"Testing: {model}")
    print(f"{'=' * 60}")

    if not API_KEY:
        print("  SKIP: OPENAI_API_KEY not set")
        return False

    try:
        response = await litellm.acompletion(
            model=model,
            messages=[{"role": "user", "content": TEST_PROMPT}],
            modalities=["audio"],
            audio=AUDIO_CONFIG,
            api_key=API_KEY,
            api_base=API_BASE,
            timeout=60.0,
        )

        choice = response.choices[0]
        message = choice.message

        print(f"  Status: SUCCESS")
        print(f"  Finish reason: {choice.finish_reason}")
        print(f"  Model returned: {getattr(response, 'model', 'unknown')}")

        audio_data = getattr(message, "audio", None)
        if audio_data:
            raw_b64 = (
                audio_data.get("data")
                if isinstance(audio_data, dict)
                else getattr(audio_data, "data", None)
            )
            transcript = (
                audio_data.get("transcript")
                if isinstance(audio_data, dict)
                else getattr(audio_data, "transcript", None)
            )

            if raw_b64:
                audio_bytes = base64.b64decode(raw_b64)
                duration_est = len(audio_bytes) / (24000 * 2)
                print(f"  Audio: {len(audio_bytes):,} bytes (~{duration_est:.2f}s at 24kHz 16-bit)")
                if transcript:
                    print(f"  Transcript: {transcript}")
                save_audio(model, audio_bytes)
            else:
                print(f"  WARNING: audio object present but no 'data' field")
                print(f"  Audio object: {audio_data}")
        else:
            content = getattr(message, "content", None)
            print(f"  WARNING: No 'audio' field on message")
            print(f"  message.content: {repr(content)[:200]}")

        usage = getattr(response, "usage", None)
        if usage:
            print(f"  Usage: {usage}")

        return True

    except litellm.AuthenticationError as exc:
        print(f"  FAILED: Authentication error — check OPENAI_API_KEY")
        print(f"  Detail: {exc}")
        return False
    except litellm.RateLimitError as exc:
        print(f"  FAILED: Rate limited")
        print(f"  Detail: {exc}")
        return False
    except litellm.Timeout:
        print(f"  FAILED: Request timed out (60s)")
        return False
    except Exception as exc:
        print(f"  FAILED: {type(exc).__name__}: {exc}")
        return False


async def main() -> None:
    print("Gemini TTS via LiteLLM — Connectivity Test")
    print(f"OPENAI_API_KEY set: {'yes' if API_KEY else 'no'}")
    print(f"OPENAI_API_BASE: {API_BASE or '(not set)'}")
    print(f"Env file: {_env_path} ({'exists' if _env_path.exists() else 'MISSING'})")

    results = {}
    for model in MODELS:
        results[model] = await test_model(model)

    print(f"\n{'=' * 60}")
    print("SUMMARY")
    print(f"{'=' * 60}")
    for model, passed in results.items():
        status = "PASS" if passed else "FAIL"
        print(f"  [{status}] {model}")

    if all(results.values()):
        print("\nAll models passed.")
    else:
        print("\nSome models failed.")
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
