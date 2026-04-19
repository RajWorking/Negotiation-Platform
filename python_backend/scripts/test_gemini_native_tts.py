from __future__ import annotations

import sys
import wave
from pathlib import Path

from dotenv import load_dotenv

_env_path = Path(__file__).resolve().parents[1] / ".env"
load_dotenv(_env_path, override=True)

from google import genai
from google.genai import types

MODELS = [
    # "gemini-2.5-flash-preview-tts",
    # "gemini-2.5-pro-preview-tts",
    "gemini-3.1-flash-tts-preview",
]

PLAIN_PROMPT = "Hello, this is a test of Gemini text to speech."

EMOTION_PROMPTS = {
    "whisper": "[whispers] Don't tell anyone, but I think this is working.",
    "excited": "[excited] Oh my gosh, this is amazing, I can't believe it!",
    "sarcastic": "[sarcastic] Oh wow, another text to speech test, how thrilling.",
    "crying": "[crying] I just can't believe it's over... it meant so much to me.",
    "shouting": "[shouting] Hey! Can you hear me over there?!",
    "laughing": "[laughs] That was the funniest thing I've ever heard!",
    "mixed": "[whispers] Hey, come closer... [shouting] SURPRISE! [laughs] Got you!",
}

VOICE = "Kore"

OUTPUT_DIR = Path(__file__).resolve().parent / "tts_output"


def save_wav(filename: str, pcm: bytes) -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = OUTPUT_DIR / filename
    with wave.open(str(out_path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(24000)
        wf.writeframes(pcm)
    duration = len(pcm) / (24000 * 2)
    print(f"  Saved: {out_path}")
    print(f"  Audio: {len(pcm):,} bytes (~{duration:.2f}s at 24kHz 16-bit)")


def synthesize(client: genai.Client, model: str, prompt: str) -> bytes | None:
    response = client.models.generate_content(
        model=model,
        contents=prompt,
        config=types.GenerateContentConfig(
            response_modalities=["AUDIO"],
            speech_config=types.SpeechConfig(
                voice_config=types.VoiceConfig(
                    prebuilt_voice_config=types.PrebuiltVoiceConfig(
                        voice_name=VOICE,
                    )
                )
            ),
        ),
    )
    return response.candidates[0].content.parts[0].inline_data.data


def test_model_plain(client: genai.Client, model: str) -> bool:
    label = f"{model} (plain)"
    print(f"\n{'=' * 60}")
    print(f"Testing: {label}")
    print(f"{'=' * 60}")

    try:
        audio_data = synthesize(client, model, PLAIN_PROMPT)
        if not audio_data:
            print("  FAILED: Response contained no audio data")
            return False
        print(f"  Status: SUCCESS")
        safe_name = model.replace("/", "_")
        save_wav(f"{safe_name}_plain.wav", audio_data)
        return True
    except Exception as exc:
        print(f"  FAILED: {type(exc).__name__}: {exc}")
        return False


def test_model_emotions(client: genai.Client, model: str) -> dict[str, bool]:
    results: dict[str, bool] = {}
    safe_model = model.replace("/", "_")

    for tag, prompt in EMOTION_PROMPTS.items():
        label = f"{model} [{tag}]"
        print(f"\n{'-' * 60}")
        print(f"Testing: {label}")
        print(f"  Prompt: {prompt}")
        print(f"{'-' * 60}")

        try:
            audio_data = synthesize(client, model, prompt)
            if not audio_data:
                print("  FAILED: Response contained no audio data")
                results[label] = False
                continue
            print(f"  Status: SUCCESS")
            save_wav(f"{safe_model}_{tag}.wav", audio_data)
            results[label] = True
        except Exception as exc:
            print(f"  FAILED: {type(exc).__name__}: {exc}")
            results[label] = False

    return results


def test_text_generation(client: genai.Client) -> bool:
    model = "gemini-2.5-flash"
    print(f"\n{'=' * 60}")
    print(f"Testing text generation: {model}")
    print(f"{'=' * 60}")

    try:
        response = client.models.generate_content(
            model=model,
            contents="Explain how AI works in one sentence.",
        )
        print(f"  Status: SUCCESS")
        print(f"  Response: {response.text[:200]}")
        return True
    except Exception as exc:
        print(f"  FAILED: {type(exc).__name__}: {exc}")
        return False


def main() -> None:
    print("Gemini TTS via google-genai SDK — Connectivity Test")
    print(f"Env file: {_env_path} ({'exists' if _env_path.exists() else 'MISSING'})")

    try:
        client = genai.Client()
        print("Client created (using GEMINI_API_KEY from env)")
    except Exception as exc:
        print(f"Failed to create client: {exc}")
        print("Make sure GEMINI_API_KEY is set in your environment or .env file.")
        sys.exit(1)

    results: dict[str, bool] = {}

    results["text-generation"] = test_text_generation(client)

    for model in MODELS:
        results[f"{model} (plain)"] = test_model_plain(client, model)
        emotion_results = test_model_emotions(client, model)
        results.update(emotion_results)

    print(f"\n{'=' * 60}")
    print("SUMMARY")
    print(f"{'=' * 60}")
    for name, passed in results.items():
        status = "PASS" if passed else "FAIL"
        print(f"  [{status}] {name}")

    total = len(results)
    passed = sum(results.values())
    failed = total - passed
    print(f"\n{passed}/{total} passed, {failed} failed.")

    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
